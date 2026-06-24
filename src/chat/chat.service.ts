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
import { CurrencyService } from '../currency/currency.service';
import { ProductsService } from '../products/products.service';
import { ChatResponseDto } from './dto/chat-response.dto';
import { SendMessageDto } from './dto/send-message.dto';

interface OpenAiMessageResult {
  content: string;
  totalTokens: number;
  functionsExecuted: string[];
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxIterations = 5;

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
    const result = await this.runFunctionCallingLoop(payload.message);

    return {
      response: result.content,
      metadata: {
        totalTokens: result.totalTokens,
        functionsExecuted: result.functionsExecuted
      }
    };
  }

  private async runFunctionCallingLoop(message: string): Promise<OpenAiMessageResult> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are an e-commerce assistant. Use tools when needed. If query is unclear, reply with a polite clarification and examples.'
      },
      { role: 'user', content: message }
    ];

    let totalTokens = 0;
    const functionsExecuted: string[] = [];

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
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
          functionsExecuted
        };
      }

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        const args = this.parseToolArguments(toolCall.function.arguments);
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
      functionsExecuted
    };
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
