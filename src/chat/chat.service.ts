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

interface OpenAiMessageResult {
  content: string;
  totalTokens: number;
  functionsExecuted: string[];
  messages: ChatCompletionMessageParam[];
  products?: ProductOutput[];
  conversions?: CurrencyConversionResult[];
}

interface FallbackResponse {
  message: string;
  products: ProductOutput[];
}

interface SessionState {
  messages: ChatCompletionMessageParam[];
  updatedAt: number;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxIterations = 5;
  private readonly maxSessionHistoryMessages = 30;
  private readonly sessionTtlMs = 60 * 60 * 1000;
  private readonly sessionStore = new Map<string, SessionState>();
  private readonly systemInstruction = [
    'You are a warm and proactive customer service assistant for an e-commerce store that must use function calling.',
    'Use searchProducts directly for product discovery queries without asking unnecessary clarifying questions.',
    'If the user request is generic or underspecified, always provide 2 relevant products first and then ask whether they want something more specific.',
    'When user asks for product price in another currency, first fetch 2 relevant products with searchProducts and then convert each price with convertCurrencies when numeric prices are available.',
    'When user asks pure currency conversion with explicit amount and currencies (e.g. "How many Canadian Dollars are 350 Euros"), call convertCurrencies directly.',
    'For generic price questions without a target currency (e.g. "How much does a watch cost?"), provide an approximate price range based on the relevant catalog products, do not convert currency, and then show 2 products.',
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

  private resolveSessionId(sessionId?: string): string {
    if (sessionId && sessionId.trim().length > 0) {
      return sessionId.trim();
    }

    return randomUUID();
  }

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

  private cleanupExpiredSessions(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.sessionStore.entries()) {
      if (now - session.updatedAt > this.sessionTtlMs) {
        this.sessionStore.delete(sessionId);
      }
    }
  }

  private parseToolArguments(rawArgs: string): Record<string, unknown> {
    try {
      return JSON.parse(rawArgs) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn('Invalid JSON arguments received from model');
      return {};
    }
  }

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

  private shouldForceProductSuggestions(message: string): boolean {
    const normalized = message.toLowerCase();
    const productIntentPattern =
      /(looking|search|find|need|gift|present|buy|price|cost|watch|phone|iphone|laptop|shoes|dress|sandals|product)/;
    const pureConversionPattern =
      /(how many|convert|exchange).*\d+.*(usd|eur|cop|cad|mxn|gbp)/;

    return productIntentPattern.test(normalized) && !pureConversionPattern.test(normalized);
  }

  resetSession(sessionId: string): boolean {
    const normalized = sessionId.trim();
    if (!normalized) {
      throw new BadRequestException('sessionId cannot be empty');
    }

    return this.sessionStore.delete(normalized);
  }

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
