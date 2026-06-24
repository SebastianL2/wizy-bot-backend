import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'csv-parse/sync';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProductRecord, ProductResult } from './interfaces/product.interface';

type ParsedPrice = { amount: number | null; currency: string };
type CsvParseOptions = {
  columns: boolean;
  skip_empty_lines: boolean;
  relax_quotes: boolean;
  trim: boolean;
  bom?: boolean;
  relax_column_count?: boolean;
  skip_records_with_error?: boolean;
};

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

  async searchProducts(query: string, limit = 2): Promise<ProductResult[]> {
    await this.ensureProductsLoaded();

    const normalizedQuery = this.normalizeText(query);
    const queryTokens = this.expandTokens(this.tokenize(normalizedQuery));

    const scoredProducts = this.products.map((product) => {
      const score = this.scoreProduct(product, normalizedQuery, queryTokens);
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
        score
      };
    });

    const matched = scoredProducts
      .filter((product) => product.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (matched.length > 0) {
      return matched;
    }

    this.logger.warn(
      'No direct match found, returning fallback popular products'
    );

    return scoredProducts
      .sort((a, b) => this.fallbackRank(b) - this.fallbackRank(a))
      .slice(0, limit);
  }

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

  private fallbackRank(product: ProductResult): number {
    const discountBoost = product.description.toLowerCase().includes('sale')
      ? 4
      : 0;
    const hasPrice = product.priceAmount !== null ? 2 : 0;

    return discountBoost + hasPrice + product.score;
  }

  private tokenize(text: string): string[] {
    return text
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 2);
  }

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

  private hasPartialMatch(searchableText: string, token: string): boolean {
    return searchableText
      .split(' ')
      .some((word) => word.startsWith(token) || token.startsWith(word));
  }

  private parsePrice(rawPrice: string): ParsedPrice {
    const matches = rawPrice?.match(/\d+(\.\d+)?/g) ?? [];
    const amount = matches.length > 0 ? Number(matches[0]) : null;
    const currencyMatch = rawPrice?.match(/[A-Z]{3}/);

    return {
      amount,
      currency: currencyMatch?.[0] ?? 'USD'
    };
  }

  private normalizeText(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
}
