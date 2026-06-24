import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'csv-parse/sync';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProductRecord, ProductResult } from './interfaces/product.interface';

/** Numeric amount and ISO currency extracted from a raw price string. */
type ParsedPrice = { amount: number | null; currency: string };

/** Options passed to the CSV parser when loading the product catalog. */
type CsvParseOptions = {
  columns: boolean;
  skip_empty_lines: boolean;
  relax_quotes: boolean;
  trim: boolean;
  bom?: boolean;
  relax_column_count?: boolean;
  skip_records_with_error?: boolean;
};

type RecipientProfile = 'male' | 'female' | 'kids' | 'unisex';

type ProductAudience = {
  male: boolean;
  female: boolean;
  kids: boolean;
  unisex: boolean;
};

/**
 * Loads the product catalog from CSV and performs token-based search with
 * synonym expansion and relevance scoring.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private products: ProductRecord[] = [];
  private hasLoaded = false;

  private readonly synonyms: Record<string, string[]> = {
    telefono: ['phone', 'iphone', 'celular', 'movil', 'smartphone'],
    celular: ['phone', 'iphone', 'telefono', 'movil', 'smartphone'],
    movil: ['phone', 'iphone', 'telefono', 'celular', 'smartphone'],
    laptop: ['notebook', 'chromebook', 'computer', 'gaming laptop'],
    reloj: ['watch', 'smartwatch', 'clock'],
    zapatos: ['shoe', 'shoes', 'boots', 'sandals', 'slippers'],
    vestido: ['dress', 'outfit', 'clothing'],
    maleta: ['luggage', 'suitcase', 'bag']
  };

  constructor(private readonly configService: ConfigService) {}

  /**
   * Searches the catalog for products most relevant to the given query.
   *
   * Scores matches by title, description, and category tokens. When no product
   * reaches a positive score, returns a fallback set of popular items.
   *
   * @param query - Free-text search query from the user or assistant tool.
   * @param limit - Maximum number of products to return.
   * @returns Ranked product matches with parsed price metadata.
   */
  async searchProducts(query: string, limit = 2): Promise<ProductResult[]> {
    await this.ensureProductsLoaded();

    const normalizedQuery = this.normalizeText(query);
    const queryTokens = this.expandTokens(this.tokenize(normalizedQuery));
    const recipientProfile = this.detectRecipientProfile(normalizedQuery);

    const scoredProducts = this.products.map((product) => {
      const baseScore = this.scoreProduct(product, normalizedQuery, queryTokens);
      const profileAdjustment = this.scoreRecipientFit(product, recipientProfile);
      const parsedPrice = this.parsePrice(product.price);

      return {
        name: product.displayTitle,
        description: product.embeddingText,
        embeddingText: product.embeddingText,
        url: product.url,
        imageUrl: product.imageUrl,
        price: product.price,
        priceAmount: parsedPrice.amount,
        currency: parsedPrice.currency,
        productType: product.productType,
        discount: product.discount,
        variants: product.variants,
        score: baseScore + profileAdjustment
      };
    });

    const candidates = this.filterByRecipientProfile(scoredProducts, recipientProfile);

    const matched = candidates
      .filter((product) => product.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (matched.length > 0) {
      return matched;
    }

    this.logger.warn(
      'No direct match found, returning fallback popular products'
    );

    return candidates
      .sort((a, b) => this.fallbackRank(b) - this.fallbackRank(a))
      .slice(0, limit);
  }

  /**
   * Loads the CSV catalog once and caches it in memory for subsequent searches.
   *
   * @throws Error when no CSV file can be resolved or parsed.
   */
  private async ensureProductsLoaded(): Promise<void> {
    if (this.hasLoaded) {
      return;
    }

    const csvPath = await this.resolveCsvPath();

    const csvData = await readFile(csvPath, 'utf8');
    const defaultOptions: CsvParseOptions = {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      trim: true,
      bom: true
    };

    let parsed: ProductRecord[];
    try {
      parsed = parse(csvData, defaultOptions) as ProductRecord[];
    } catch (error) {
      this.logger.warn(
        `Strict CSV parsing failed, retrying with tolerant mode: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      parsed = parse(csvData, {
        ...defaultOptions,
        relax_column_count: true,
        skip_records_with_error: true
      }) as ProductRecord[];
    }

    this.products = parsed;
    this.hasLoaded = true;
    this.logger.log(`Loaded ${this.products.length} products from CSV`);
  }

  /**
   * Resolves the product CSV path from configuration or known fallback locations.
   *
   * @returns Absolute path to an accessible CSV file.
   * @throws Error when none of the candidate paths exist.
   */
  private async resolveCsvPath(): Promise<string> {
    const configuredPath = this.configService.get<string>('PRODUCTS_CSV_PATH');
    const candidates = [
      configuredPath,
      join(process.cwd(), 'full_stack_test_products_list_rmk.csv'),
      join(process.cwd(), 'Full Stack Test products_list.csv'),
      join(__dirname, '../../full_stack_test_products_list_rmk.csv'),
      join(__dirname, '../../Full Stack Test products_list.csv'),
      join(__dirname, '../../../full_stack_test_products_list_rmk.csv'),
      join(__dirname, '../../../Full Stack Test products_list.csv')
    ].filter((path): path is string => Boolean(path && path.trim().length > 0));

    for (const candidate of candidates) {
      try {
        await access(candidate);
        this.logger.debug(`Using products CSV path: ${candidate}`);
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error(
      `Products CSV file not found. Checked: ${candidates.join(', ')}`
    );
  }

  /**
   * Computes a relevance score for a product against the normalized query.
   *
   * Higher weight is given to full-query matches, exact title tokens, and
   * category hits; partial token matches receive a lower boost.
   *
   * @param product - Catalog record to score.
   * @param normalizedQuery - Lowercase, accent-stripped full query.
   * @param queryTokens - Expanded search tokens including synonyms.
   */
  private scoreProduct(
    product: ProductRecord,
    normalizedQuery: string,
    queryTokens: string[]
  ): number {
    const title = this.normalizeText(product.displayTitle);
    const description = this.normalizeText(product.embeddingText ?? '');
    const category = this.normalizeText(product.productType ?? '');
    const searchableText = `${title} ${description}`.trim();

    let score = 0;

    if (title.includes(normalizedQuery) || description.includes(normalizedQuery)) {
      score += 12;
    }

    for (const token of queryTokens) {
      if (title.split(' ').includes(token)) {
        score += 7;
      } else if (searchableText.includes(token)) {
        score += 5;
      } else if (this.hasPartialMatch(searchableText, token)) {
        score += 3;
      }

      if (category.includes(token)) {
        score += 2;
      }
    }

    return score;
  }

  /**
   * Ranks fallback products when no direct query match is found.
   *
   * Prefers items on sale and products with a parsed numeric price.
   *
   * @param product - Scored product candidate.
   */
  private fallbackRank(product: ProductResult): number {
    const discountBoost = product.description.toLowerCase().includes('sale')
      ? 4
      : 0;
    const hasPrice = product.priceAmount !== null ? 2 : 0;

    return discountBoost + hasPrice + product.score;
  }

  /**
   * Detects recipient profile hints in the user query (e.g. dad, mom, kids).
   *
   * @param normalizedQuery - Lowercase, accent-stripped query text.
   */
  private detectRecipientProfile(
    normalizedQuery: string
  ): RecipientProfile | null {
    const malePattern =
      /\b(dad|father|papa|pap[aá]|husband|boyfriend|brother|uncle|man|men|male|hombre)\b/;
    const femalePattern =
      /\b(mom|mother|mama|mam[aá]|wife|girlfriend|sister|aunt|woman|women|female|mujer|tia|t[ií]a)\b/;
    const kidsPattern =
      /\b(kid|kids|child|children|baby|babies|toddler|toddlers|boy|boys|girl|girls|nino|ni[ñn]o|nina|ni[ñn]a|bebe|beb[ée])\b/;
    const unisexPattern =
      /\b(unisex|home|technology|tech|hogar|casa|electronic|electronics)\b/;

    if (kidsPattern.test(normalizedQuery)) {
      return 'kids';
    }
    if (malePattern.test(normalizedQuery)) {
      return 'male';
    }
    if (femalePattern.test(normalizedQuery)) {
      return 'female';
    }
    if (unisexPattern.test(normalizedQuery)) {
      return 'unisex';
    }

    return null;
  }

  /**
   * Adds a relevance adjustment based on audience compatibility.
   *
   * @param product - Catalog record to evaluate.
   * @param recipientProfile - Recipient profile inferred from query.
   */
  private scoreRecipientFit(
    product: ProductRecord,
    recipientProfile: RecipientProfile | null
  ): number {
    if (!recipientProfile) {
      return 0;
    }

    const audience = this.getProductAudience(
      product.displayTitle,
      product.embeddingText,
      product.productType
    );

    if (!this.isAudienceCompatible(audience, recipientProfile)) {
      return -25;
    }

    if (
      (recipientProfile === 'male' && audience.male) ||
      (recipientProfile === 'female' && audience.female) ||
      (recipientProfile === 'kids' && audience.kids) ||
      (recipientProfile === 'unisex' && audience.unisex)
    ) {
      return 10;
    }

    return 2;
  }

  /**
   * Keeps only products compatible with recipient profile.
   *
   * If filtering removes all products, the original set is returned to avoid
   * empty responses.
   *
   * @param products - Scored products.
   * @param recipientProfile - Recipient profile inferred from query.
   */
  private filterByRecipientProfile(
    products: ProductResult[],
    recipientProfile: RecipientProfile | null
  ): ProductResult[] {
    if (!recipientProfile) {
      return products;
    }

    const filtered = products.filter((product) => {
      const audience = this.getProductAudience(
        product.name,
        product.description,
        product.productType
      );
      return this.isAudienceCompatible(audience, recipientProfile);
    });

    return filtered.length > 0 ? filtered : products;
  }

  /**
   * Infers product audience tags from title, description, and category.
   *
   * @param title - Product title.
   * @param description - Product searchable description.
   * @param productType - Product category.
   */
  private getProductAudience(
    title: string,
    description: string,
    productType: string
  ): ProductAudience {
    const text = this.normalizeText(`${title} ${description}`.trim());
    const normalizedType = this.normalizeText(productType ?? '');

    const male = /\b(men|mens|man|male|hombre)\b/.test(text);
    const female =
      /\b(women|womens|woman|female|mujer|makeup|mascara|eyeliner|eyeshadow)\b/.test(
        text
      );
    const kids =
      /\b(kid|kids|child|children|toddler|baby|infant|boy|boys|girl|girls|nino|ni[ñn]o|nina|ni[ñn]a|bebe|beb[ée])\b/.test(
        text
      );
    const unisex =
      /\bunisex\b/.test(text) ||
      normalizedType === 'technology' ||
      normalizedType === 'home';

    return { male, female, kids, unisex };
  }

  /**
   * Checks whether product audience aligns with the inferred recipient profile.
   *
   * @param audience - Inferred product audience tags.
   * @param recipientProfile - Recipient profile inferred from query.
   */
  private isAudienceCompatible(
    audience: ProductAudience,
    recipientProfile: RecipientProfile
  ): boolean {
    if (recipientProfile === 'male') {
      return !audience.female && !audience.kids;
    }

    if (recipientProfile === 'female') {
      return !audience.male && !audience.kids;
    }

    if (recipientProfile === 'kids') {
      return audience.kids || audience.unisex;
    }

    return audience.unisex || (!audience.male && !audience.female && !audience.kids);
  }

  /**
   * Splits text into lowercase alphanumeric tokens longer than two characters.
   *
   * @param text - Input text to tokenize.
   */
  private tokenize(text: string): string[] {
    return text
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 2);
  }

  /**
   * Expands query tokens with configured Spanish/English synonyms.
   *
   * @param tokens - Base tokens extracted from the query.
   */
  private expandTokens(tokens: string[]): string[] {
    const expanded = new Set<string>();

    for (const token of tokens) {
      expanded.add(token);
      const aliases = this.synonyms[token] ?? [];
      for (const alias of aliases) {
        expanded.add(this.normalizeText(alias));
      }
    }

    return [...expanded];
  }

  /**
   * Checks whether a token partially matches any word in searchable text.
   *
   * @param searchableText - Normalized title and description combined.
   * @param token - Query token to compare.
   */
  private hasPartialMatch(searchableText: string, token: string): boolean {
    return searchableText
      .split(' ')
      .some((word) => word.startsWith(token) || token.startsWith(word));
  }

  /**
   * Extracts the first numeric amount and ISO currency code from a price string.
   *
   * Defaults to `USD` when no currency code is present.
   *
   * @param rawPrice - Raw price value from the CSV row.
   */
  private parsePrice(rawPrice: string): ParsedPrice {
    const matches = rawPrice?.match(/\d+(\.\d+)?/g) ?? [];
    const amount = matches.length > 0 ? Number(matches[0]) : null;
    const currencyMatch = rawPrice?.match(/[A-Z]{3}/);

    return {
      amount,
      currency: currencyMatch?.[0] ?? 'USD'
    };
  }

  /**
   * Normalizes text for case-insensitive, accent-insensitive comparisons.
   *
   * @param text - Input text to normalize.
   */
  private normalizeText(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
}
