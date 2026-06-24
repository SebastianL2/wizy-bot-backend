import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions';
import { randomUUID } from 'node:crypto';
import { CurrencyConversionResult } from '../currency/interfaces/exchange-rates.interface';
import { ProductResult } from '../products/interfaces/product.interface';
import { CurrencyService } from '../currency/currency.service';
import { ProductsService } from '../products/products.service';
import { ChatResponseDto } from './dto/chat-response.dto';
import { SendMessageDto } from './dto/send-message.dto';

/** Product payload returned to the chat client and OpenAI tool results. */
interface ProductOutput {
  title: string;
  price?: number;
  currency: string;
  embeddingText?: string;
  url?: string;
  imageUrl?: string;
  productType?: string;
  discount?: string;
  variants?: string;
}

/** Aggregated result of the OpenAI function-calling loop. */
interface OpenAiMessageResult {
  content: string;
  totalTokens: number;
  functionsExecuted: string[];
  messages: ChatCompletionMessageParam[];
  products?: ProductOutput[];
  conversions?: CurrencyConversionResult[];
}

/** Synthetic assistant reply when the model skips product search. */
interface FallbackResponse {
  message: string;
  products: ProductOutput[];
}

/** In-memory conversation state keyed by session id. */
interface SessionState {
  messages: ChatCompletionMessageParam[];
  updatedAt: number;
}

/**
 * Orchestrates chat requests with OpenAI function calling, session memory,
 * product search, and currency conversion.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxIterations = 5;
  private readonly maxSessionHistoryMessages = 30;
  private readonly sessionTtlMs = 60 * 60 * 1000;
  private readonly sessionStore = new Map<string, SessionState>();
  private readonly recipientRecommendationGuide = [
    'Recipient recommendation guide (use this when user asks products for someone like dad, mom, aunt, sister, kids, etc.):',
    'HOMBRE: Men\'s Comfy Memory Foam Slide Slippers; IRON Clothing Men\'s Yukon Stretch Twill Flat Front Short; George Men\'s Pique Polo Shirts (2-Pack).',
    'MUJER: Time and Tru Women\'s Tall Slouch Boots; Luv Betsey By Betsey Johnson Women\'s Ruffle Tiered Dress; POPYOUNG Womens Summer Casual Tank Tops; Racerback Tank Tops for women; NELEUS Womens 4 High Waist Athletic Running Shorts; Eytino One Piece Bathing Suit for Women; Women\'s Plus Size Ruffled V-Neck Top; Womens Having A Weird Mom Builds Character Tshirt; Women\'s Short Sleeve Slub Crew T-Shirt; Women\'s Long Sleeve High Leg Rash Guard One Piece Swimsuit; Women\'s Low Chunky Lug Fashion Sneakers; Summer Tank Tops for Women V-neck Sleeveless Shirts (both listings); Smurfette Sassy Classy Smurf Women\'s Graphic T Shirt; Women\'s Studded Heeled Moto Boots; Cueply Womens Plus Size Tops Short Sleeve V Neck; Jordache Womens Boyfriend Short With Rolled Cuff Hem; Time and Tru Women\'s Short Sleeve Tiered Knit Dress; Female Carmen Shoulder Bag Multi Snake Pink; Women\'s Athletic Ankle Socks; Women\'s Summer Casual T-shirt; Maybelline and makeup items (mascara, eyeliner, eyeshadow).',
    'NINOS/NINAS: NEWTZ Little & Big Boys Water Shoes (ninos); Little & Big Boys Slide Sandals (ninos); Wonder Nation Baby Boys Fisherman Sandals (bebe nino); Wonder Nation Girls Cushioned Ankle Socks (ninas); Gerber Baby Boy or Girl Unisex Waffle Romper (unisex bebe); Crocs Toddler & Kids Crocband Sandal (ninos).',
    'UNISEX or NO GENERO (HOME/TECH/OTHERS) - Tecnologia: iPhone 12 / iPhone 13 / iPhone SE; Lenovo Ideapad Gaming Chromebook; MSI Katana GF66 Gaming Laptop; JBL GO 2 Speaker; Apple AirPods Pro (2nd Gen); Apple Watch Series 8 / SE; Sony PlayStation 5 (and Digital Edition); Nintendo Switch Bundle; LG 86" TV / Philips 75" TV; Wireless Earbuds / Open Ear Headphones; Canon EOS Rebel T100 / KODAK camera; Samsung soundbars/headphones.',
    'UNISEX or NO GENERO (HOME/TECH/OTHERS) - Hogar: detergents (Clorox, Gain, Laundry Sanitizer); furniture (sofa, chairs, dining chairs, plant stand); kitchen (knife sets, cookware, refrigerator, ice maker); luggage/suitcases/totes; inflatable pools; baskets/laundry/bedding.',
    'For recipient-based requests, prioritize these items as search intents and keep recommendations aligned to recipient profile.'
  ].join(' ');
  private readonly systemInstruction = [
    'You are a warm and proactive customer service assistant for an e-commerce store that must use function calling.',
    'Use searchProducts directly for product discovery queries without asking unnecessary clarifying questions.',
    'If the user request is generic or underspecified, always provide 2 relevant products first and then ask whether they want something more specific.',
    'When user asks for product price in another currency, first fetch 2 relevant products with searchProducts and then convert each price with convertCurrencies when numeric prices are available.',
    'When user asks pure currency conversion with explicit amount and currencies (e.g. "How many Canadian Dollars are 350 Euros"), call convertCurrencies directly.',
    'For generic price questions without a target currency (e.g. "How much does a watch cost?"), provide an approximate price range based on the relevant catalog products, do not convert currency, and then show 2 products.',
    this.recipientRecommendationGuide,
    'Always keep a customer-service tone: clear, friendly, and solution-oriented.',
    'Avoid empty responses and avoid saying you cannot help before trying tools.'
  ].join(' ');

  private readonly tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'searchProducts',
        description:
          'Search related products from catalog and return top matches with name, description and price',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'User query to search related products'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'convertCurrencies',
        description: 'Convert an amount between two currencies',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Amount to convert' },
            from: { type: 'string', description: 'Source currency, e.g. USD' },
            to: { type: 'string', description: 'Target currency, e.g. EUR' }
          },
          required: ['amount', 'from', 'to']
        }
      }
    }
  ];

  /**
   * Initializes the OpenAI client from environment configuration.
   *
   * @throws ServiceUnavailableException when `OPENAI_API_KEY` is missing.
   */
  constructor(
    private readonly configService: ConfigService,
    private readonly productsService: ProductsService,
    private readonly currencyService: CurrencyService
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Missing OPENAI_API_KEY environment variable'
      );
    }

    this.model = this.configService.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
    this.openai = new OpenAI({ apiKey });
  }

  /**
   * Processes an incoming user message end-to-end.
   *
   * Resolves or creates a session, runs the OpenAI tool loop, optionally
   * converts product prices to a detected target currency, and returns a
   * structured response for the client.
   *
   * @param payload - User message and optional session identifier.
   * @returns Assistant reply, matched products, conversion data, and metadata.
   */
  async processMessage(payload: SendMessageDto): Promise<ChatResponseDto> {
    this.logger.log(`Processing chat message: "${payload.message}"`);

    try {
      const sessionId = this.resolveSessionId(payload.sessionId);
      const initialMessages = this.getSessionMessages(sessionId);
      const messages: ChatCompletionMessageParam[] = [
        ...initialMessages,
        { role: 'user', content: payload.message }
      ];
      const result = await this.runFunctionCallingLoop(messages);

      this.persistSessionMessages(sessionId, result.messages);
      const requestedCurrency = this.detectRequestedCurrency(payload.message);
      const convertedProducts = await this.convertProductsIfNeeded(
        result.products,
        requestedCurrency
      );
      const products = convertedProducts.products;
      const normalizedMessage = this.normalizeMessageForStructuredProducts(
        result.content,
        products
      );
      const combinedConversions = [
        ...(result.conversions ?? []),
        ...convertedProducts.conversions
      ];
      const finalMessage = this.buildFinalMessage(
        payload.message,
        normalizedMessage,
        products
      );

      const conversion =
        combinedConversions.length === 1
          ? combinedConversions[0]
          : undefined;

      return {
        message: finalMessage,
        products,
        conversion,
        conversions:
          combinedConversions.length > 1
            ? combinedConversions
            : undefined,
        metadata: {
          totalTokens: result.totalTokens,
          functionsExecuted: result.functionsExecuted,
          sessionId
        }
      };
    } catch (error) {
      this.logger.error('Failed to process chat message', {
        message: payload.message,
        model: this.model,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Executes the OpenAI chat loop with tool calling until a final answer
   * is produced or the iteration limit is reached.
   *
   * @param messages - Mutable conversation history including the latest user turn.
   * @returns Assistant content, token usage, executed tools, and structured data.
   */
  private async runFunctionCallingLoop(
    messages: ChatCompletionMessageParam[]
  ): Promise<OpenAiMessageResult> {
    let totalTokens = 0;
    const functionsExecuted: string[] = [];
    let structuredProducts: ProductOutput[] | undefined;
    const structuredConversions: CurrencyConversionResult[] = [];

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      this.logger.debug(
        `OpenAI request iteration ${iteration}/${this.maxIterations} (model=${this.model})`
      );

      const completion = await this.openai.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        max_tokens: 400,
        messages,
        tools: this.tools
      });

      totalTokens += completion.usage?.total_tokens ?? 0;
      const assistantMessage = completion.choices[0]?.message;

      if (!assistantMessage) {
        break;
      }

      messages.push(assistantMessage);
      const toolCalls = assistantMessage.tool_calls ?? [];

      if (toolCalls.length === 0) {
        const fallbackResponse = await this.buildFallbackResponse(
          messages,
          functionsExecuted
        );
        if (fallbackResponse) {
          messages[messages.length - 1] = {
            role: 'assistant',
            content: fallbackResponse.message
          };

          return {
            content: fallbackResponse.message,
            totalTokens,
            functionsExecuted,
            messages,
            products: fallbackResponse.products,
            conversions:
              structuredConversions.length > 0 ? structuredConversions : undefined
          };
        }

        return {
          content:
            assistantMessage.content ??
            'I could not understand your request. Try asking for a product search or currency conversion.',
          totalTokens,
          functionsExecuted,
          messages,
          products: structuredProducts,
          conversions:
            structuredConversions.length > 0 ? structuredConversions : undefined
        };
      }

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        const args = this.parseToolArguments(toolCall.function.arguments);

        this.logger.log(
          `Tool call requested: ${functionName} with args ${JSON.stringify(args)}`
        );

        const result = await this.executeTool(functionName, args);

        functionsExecuted.push(functionName);

        if (functionName === 'searchProducts') {
          const parsedProducts = this.extractProductOutput(result);
          if (parsedProducts.length > 0) {
            structuredProducts = parsedProducts;
          }
        }

        if (functionName === 'convertCurrencies') {
          const conversion = this.extractCurrencyConversion(result);
          if (conversion) {
            structuredConversions.push(conversion);
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
    }

    return {
      content:
        'I could not complete the request after several attempts. Please try again with a clearer message.',
      totalTokens,
      functionsExecuted,
      messages,
      products: structuredProducts,
      conversions: structuredConversions.length > 0 ? structuredConversions : undefined
    };
  }

  /**
   * Returns a trimmed session id or generates a new UUID when absent.
   *
   * @param sessionId - Optional client-provided session identifier.
   */
  private resolveSessionId(sessionId?: string): string {
    if (sessionId && sessionId.trim().length > 0) {
      return sessionId.trim();
    }

    return randomUUID();
  }

  /**
   * Loads stored conversation history for a session or seeds it with the
   * system instruction when the session is new.
   *
   * @param sessionId - Session identifier.
   */
  private getSessionMessages(sessionId: string): ChatCompletionMessageParam[] {
    this.cleanupExpiredSessions();

    const existingSession = this.sessionStore.get(sessionId);
    if (existingSession) {
      return [...existingSession.messages];
    }

    return [
      {
        role: 'system',
        content: this.systemInstruction
      }
    ];
  }

  /**
   * Persists trimmed conversation history and refreshes the session TTL.
   *
   * @param sessionId - Session identifier.
   * @param messages - Full message history after the current turn.
   */
  private persistSessionMessages(
    sessionId: string,
    messages: ChatCompletionMessageParam[]
  ): void {
    const trimmedMessages = this.trimSessionHistory(messages);
    this.sessionStore.set(sessionId, {
      messages: trimmedMessages,
      updatedAt: Date.now()
    });
  }

  /**
   * Keeps the system message and the most recent user/assistant turns within
   * the configured history limit.
   *
   * @param messages - Full conversation history.
   */
  private trimSessionHistory(
    messages: ChatCompletionMessageParam[]
  ): ChatCompletionMessageParam[] {
    if (messages.length <= this.maxSessionHistoryMessages) {
      return [...messages];
    }

    const [systemMessage, ...conversation] = messages;
    const trimmedConversation = conversation.slice(
      -(this.maxSessionHistoryMessages - 1)
    );

    return [systemMessage, ...trimmedConversation];
  }

  /** Removes sessions that exceeded the in-memory TTL. */
  private cleanupExpiredSessions(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.sessionStore.entries()) {
      if (now - session.updatedAt > this.sessionTtlMs) {
        this.sessionStore.delete(sessionId);
      }
    }
  }

  /**
   * Parses JSON tool arguments sent by the model.
   *
   * @param rawArgs - Raw JSON string from the tool call.
   * @returns Parsed arguments object, or an empty object when invalid.
   */
  private parseToolArguments(rawArgs: string): Record<string, unknown> {
    try {
      return JSON.parse(rawArgs) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn('Invalid JSON arguments received from model');
      return {};
    }
  }

  /**
   * Executes a tool by name with logging and error propagation.
   *
   * @param functionName - OpenAI tool name.
   * @param args - Parsed tool arguments.
   */
  private async executeTool(
    functionName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    this.logger.debug(`Executing tool: ${functionName}`);

    try {
      return await this.runTool(functionName, args);
    } catch (error) {
      this.logger.error(`Tool execution failed: ${functionName}`, {
        args,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Dispatches a tool call to the corresponding domain service.
   *
   * Supported tools: `searchProducts`, `convertCurrencies`.
   *
   * @param functionName - OpenAI tool name.
   * @param args - Parsed tool arguments.
   */
  private async runTool(
    functionName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (functionName === 'searchProducts') {
      const query = String(args.query ?? '');
      const products = await this.productsService.searchProducts(query, 2);
      if (products.length === 0) {
        return {
          message: 'No related products found'
        };
      }

      return {
        products: this.mapProductsForOutput(products)
      };
    }

    if (functionName === 'convertCurrencies') {
      const amount = Number(args.amount);
      const from = String(args.from ?? 'USD');
      const to = String(args.to ?? 'USD');
      return this.currencyService.convertCurrencies(amount, from, to);
    }

    return {
      error: `Function ${functionName} is not implemented`
    };
  }

  /**
   * Maps internal product search results to the chat response shape.
   *
   * @param products - Products returned by {@link ProductsService.searchProducts}.
   */
  private mapProductsForOutput(products: ProductResult[]): ProductOutput[] {
    return products.map((product) => ({
      title: product.name,
      price: product.priceAmount ?? undefined,
      currency: product.currency,
      embeddingText: product.embeddingText,
      url: product.url,
      imageUrl: product.imageUrl,
      productType: product.productType,
      discount: product.discount,
      variants: product.variants
    }));
  }

  /**
   * Validates and normalizes product data from a tool execution result.
   *
   * @param result - Raw tool response payload.
   * @returns Validated products, or an empty array when the shape is invalid.
   */
  private extractProductOutput(result: unknown): ProductOutput[] {
    if (!result || typeof result !== 'object') {
      return [];
    }

    const maybeProducts = (result as { products?: unknown }).products;
    if (!Array.isArray(maybeProducts)) {
      return [];
    }

    const formatted: ProductOutput[] = [];

    for (const entry of maybeProducts) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const product = entry as {
        title?: unknown;
        price?: unknown;
        currency?: unknown;
        embeddingText?: unknown;
        url?: unknown;
        imageUrl?: unknown;
        productType?: unknown;
        discount?: unknown;
        variants?: unknown;
      };

      if (typeof product.title !== 'string' || typeof product.currency !== 'string') {
        continue;
      }

      formatted.push({
        title: product.title,
        price: typeof product.price === 'number' ? product.price : undefined,
        currency: product.currency,
        embeddingText:
          typeof product.embeddingText === 'string'
            ? product.embeddingText
            : undefined,
        url: typeof product.url === 'string' ? product.url : undefined,
        imageUrl:
          typeof product.imageUrl === 'string' ? product.imageUrl : undefined,
        productType:
          typeof product.productType === 'string' ? product.productType : undefined,
        discount:
          typeof product.discount === 'string' ? product.discount : undefined,
        variants:
          typeof product.variants === 'string' ? product.variants : undefined
      });
    }

    return formatted;
  }

  /**
   * Validates and normalizes currency conversion data from a tool result.
   *
   * @param result - Raw tool response payload.
   * @returns Validated conversion, or `null` when required fields are missing.
   */
  private extractCurrencyConversion(
    result: unknown
  ): CurrencyConversionResult | null {
    if (!result || typeof result !== 'object') {
      return null;
    }

    const conversion = result as Partial<CurrencyConversionResult>;
    if (
      typeof conversion.amount !== 'number' ||
      typeof conversion.from !== 'string' ||
      typeof conversion.to !== 'string' ||
      typeof conversion.convertedAmount !== 'number' ||
      typeof conversion.rate !== 'number' ||
      typeof conversion.stale !== 'boolean'
    ) {
      return null;
    }

    return {
      amount: conversion.amount,
      from: conversion.from,
      to: conversion.to,
      convertedAmount: conversion.convertedAmount,
      rate: conversion.rate,
      stale: conversion.stale,
      message: conversion.message
    };
  }

  /**
   * Builds a product suggestion fallback when the model answers without
   * calling `searchProducts` but the user message looks product-related.
   *
   * @param messages - Current conversation history.
   * @param functionsExecuted - Mutable list of executed tool names.
   * @returns Fallback reply with products, or `null` when not applicable.
   */
  private async buildFallbackResponse(
    messages: ChatCompletionMessageParam[],
    functionsExecuted: string[]
  ): Promise<FallbackResponse | null> {
    if (functionsExecuted.includes('searchProducts')) {
      return null;
    }

    const userMessage = this.getLatestUserMessage(messages);
    if (!userMessage || !this.shouldForceProductSuggestions(userMessage)) {
      return null;
    }

    const products = await this.productsService.searchProducts(userMessage, 2);
    if (products.length === 0) {
      return null;
    }
    functionsExecuted.push('searchProducts');
    const productOutputs = this.mapProductsForOutput(products);

    return {
      message:
        'Thanks for reaching out. I found these options for you. Would you like something more specific (brand, budget, color, or category)?',
      products: productOutputs
    };
  }

  /**
   * Converts product prices to a target currency detected in the user message.
   *
   * @param products - Products returned by the tool loop.
   * @param targetCurrency - ISO currency code, or `null` to skip conversion.
   */
  private async convertProductsIfNeeded(
    products: ProductOutput[] | undefined,
    targetCurrency: string | null
  ): Promise<{
    products: ProductOutput[] | undefined;
    conversions: CurrencyConversionResult[];
  }> {
    if (!products || products.length === 0 || !targetCurrency) {
      return { products, conversions: [] };
    }

    const conversions: CurrencyConversionResult[] = [];
    const convertedProducts: ProductOutput[] = [];

    for (const product of products) {
      if (
        typeof product.price !== 'number' ||
        !Number.isFinite(product.price) ||
        product.price < 0
      ) {
        convertedProducts.push(product);
        continue;
      }

      const sourceCurrency = product.currency.toUpperCase();
      if (sourceCurrency === targetCurrency) {
        convertedProducts.push(product);
        continue;
      }

      const conversion = await this.currencyService.convertCurrencies(
        product.price,
        sourceCurrency,
        targetCurrency
      );
      conversions.push(conversion);
      convertedProducts.push({
        ...product,
        price: conversion.convertedAmount,
        currency: targetCurrency
      });
    }

    return { products: convertedProducts, conversions };
  }

  /**
   * Prepends an approximate price range when the user asks a generic price
   * question and structured products are available.
   *
   * @param userMessage - Original user input.
   * @param baseMessage - Assistant message after normalization.
   * @param products - Structured products for the response.
   */
  private buildFinalMessage(
    userMessage: string,
    baseMessage: string,
    products: ProductOutput[] | undefined
  ): string {
    if (
      !this.shouldIncludeApproximateRangeIntro(userMessage, products) ||
      !products ||
      products.length === 0
    ) {
      return baseMessage;
    }

    const prices = products
      .map((product) => product.price)
      .filter((value): value is number => typeof value === 'number');
    if (prices.length === 0) {
      return baseMessage;
    }

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const currency = products[0].currency;
    const rangeText =
      minPrice === maxPrice
        ? `${minPrice.toFixed(2)} ${currency}`
        : `${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)} ${currency}`;

    return `Great question. Based on our current catalog, similar items are usually around ${rangeText}.\n${baseMessage}`;
  }

  /**
   * Determines whether the response should include an approximate price range.
   *
   * @param userMessage - Original user input.
   * @param products - Structured products for the response.
   */
  private shouldIncludeApproximateRangeIntro(
    userMessage: string,
    products: ProductOutput[] | undefined
  ): boolean {
    if (!products || products.length === 0) {
      return false;
    }

    const normalized = userMessage.toLowerCase();
    const asksPrice = /(price|cost|how much|cu[aá]nto)/.test(normalized);
    const looksGeneric = !/\d/.test(normalized);

    return asksPrice && looksGeneric;
  }

  /**
   * Detects a target currency code from natural language or ISO aliases.
   *
   * @param message - User message to inspect.
   * @returns ISO currency code in uppercase, or `null` when not detected.
   */
  private detectRequestedCurrency(message: string): string | null {
    const normalized = message.toLowerCase();
    const directCode = normalized.match(/\b(usd|eur|cop|cad|mxn|gbp)\b/);
    if (directCode?.[1]) {
      return directCode[1].toUpperCase();
    }

    const aliases: Array<{ pattern: RegExp; code: string }> = [
      { pattern: /\b(euro|euros)\b/, code: 'EUR' },
      { pattern: /\b(canadian dollar|canadian dollars|cad)\b/, code: 'CAD' },
      { pattern: /\b(colombian peso|colombian pesos|peso colombiano|pesos colombianos)\b/, code: 'COP' },
      { pattern: /\b(us dollar|us dollars|dollar|dollars)\b/, code: 'USD' },
      { pattern: /\b(pound|pounds|sterling|libra|libras)\b/, code: 'GBP' },
      { pattern: /\b(mexican peso|mexican pesos|peso mexicano|pesos mexicanos)\b/, code: 'MXN' }
    ];

    for (const alias of aliases) {
      if (alias.pattern.test(normalized)) {
        return alias.code;
      }
    }

    return null;
  }

  /**
   * Returns the most recent plain-text user message from the conversation.
   *
   * @param messages - Conversation history.
   */
  private getLatestUserMessage(messages: ChatCompletionMessageParam[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') {
        continue;
      }

      if (typeof message.content === 'string') {
        return message.content;
      }
    }

    return '';
  }

  /**
   * Checks whether a message should trigger a forced product search fallback.
   *
   * @param message - User message to inspect.
   */
  private shouldForceProductSuggestions(message: string): boolean {
    const normalized = message.toLowerCase();
    const productIntentPattern =
      /(looking|search|find|need|gift|present|buy|price|cost|watch|phone|iphone|laptop|shoes|dress|sandals|product)/;
    const pureConversionPattern =
      /(how many|convert|exchange).*\d+.*(usd|eur|cop|cad|mxn|gbp)/;

    return productIntentPattern.test(normalized) && !pureConversionPattern.test(normalized);
  }

  /**
   * Clears stored conversation history for a session.
   *
   * @param sessionId - Session identifier to reset.
   * @returns `true` when a session existed and was deleted, otherwise `false`.
   * @throws BadRequestException when `sessionId` is empty.
   */
  resetSession(sessionId: string): boolean {
    const normalized = sessionId.trim();
    if (!normalized) {
      throw new BadRequestException('sessionId cannot be empty');
    }

    return this.sessionStore.delete(normalized);
  }

  /**
   * Removes duplicated product listings from the assistant text when products
   * are already returned in the structured `products` field.
   *
   * @param message - Raw assistant message from the model.
   * @param products - Structured products attached to the response.
   */
  private normalizeMessageForStructuredProducts(
    message: string,
    products: ProductOutput[] | undefined
  ): string {
    if (!products || products.length === 0) {
      return message;
    }

    const titles = products.map((product) => product.title.toLowerCase());
    const lines = message
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const filtered = lines.filter((line) => {
      const normalized = line.toLowerCase();
      const looksLikeNumberedItem = /^\d+[\).\:-]/.test(normalized);
      const hasProductTitle = titles.some((title) => normalized.includes(title));
      const hasPriceSnippet = /\d+([.,]\d+)?\s*(usd|eur|cop|cad|mxn|gbp)\b/i.test(line);

      return !looksLikeNumberedItem && !hasProductTitle && !hasPriceSnippet;
    });

    if (filtered.length > 0) {
      return filtered.join('\n');
    }

    return 'Here are two options that could work for you.';
  }
}
