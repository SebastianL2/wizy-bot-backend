import {
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
import { CurrencyService } from '../currency/currency.service';
import { ProductsService } from '../products/products.service';
import { ChatResponseDto } from './dto/chat-response.dto';
import { SendMessageDto } from './dto/send-message.dto';

interface OpenAiMessageResult {
  content: string;
  totalTokens: number;
  functionsExecuted: string[];
  messages: ChatCompletionMessageParam[];
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

      return {
        response: result.content,
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
        return {
          content:
            assistantMessage.content ??
            'I could not understand your request. Try asking for a product search or currency conversion.',
          totalTokens,
          functionsExecuted,
          messages
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
      messages
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
        content:
          'You are an e-commerce assistant. Use tools when needed. If query is unclear, reply with a polite clarification and examples.'
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
        products: products.map((product) => ({
          name: product.name,
          description: product.description,
          price: product.price,
          priceAmount: product.priceAmount,
          currency: product.currency
        }))
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
}
