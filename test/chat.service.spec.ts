import { ConfigService } from '@nestjs/config';
import { CurrencyService } from '../src/currency/currency.service';
import { ProductsService } from '../src/products/products.service';

jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest
            .fn()
            .mockResolvedValueOnce({
              usage: { total_tokens: 120 },
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'searchProducts',
                          arguments: '{"query":"iphone"}'
                        }
                      }
                    ]
                  }
                }
              ]
            })
            .mockResolvedValueOnce({
              usage: { total_tokens: 80 },
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'Te recomiendo iPhone 12 por 900 USD',
                    tool_calls: []
                  }
                }
              ]
            })
        }
      }
    }))
  };
});

import { ChatService } from '../src/chat/chat.service';

describe('ChatService', () => {
  let service: ChatService;
  let productsService: jest.Mocked<ProductsService>;
  let currencyService: jest.Mocked<CurrencyService>;

  beforeEach(() => {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'OPENAI_API_KEY') {
          return 'test-key';
        }
        if (key === 'OPENAI_MODEL') {
          return 'gpt-4o-mini';
        }
        return undefined;
      })
    } as unknown as ConfigService;

    productsService = {
      searchProducts: jest.fn().mockResolvedValue([
        {
          name: 'iPhone 12',
          description: 'smartphone',
          price: '900.0 USD',
          priceAmount: 900,
          currency: 'USD',
          productType: 'Technology',
          score: 10
        }
      ])
    } as unknown as jest.Mocked<ProductsService>;

    currencyService = {
      convertCurrencies: jest.fn()
    } as unknown as jest.Mocked<CurrencyService>;

    service = new ChatService(configService, productsService, currencyService);
  });

  it('completes function-calling flow and returns final response', async () => {
    const result = await service.processMessage({
      message: 'Busco un iphone'
    });

    expect(result.response).toContain('iPhone 12');
    expect(productsService.searchProducts).toHaveBeenCalledWith('iphone', 2);
    expect(result.metadata?.functionsExecuted).toContain('searchProducts');
  });
});
