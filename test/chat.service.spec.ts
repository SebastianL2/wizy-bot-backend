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
          embeddingText: 'iPhone 12 smartphone',
          url: 'https://example.com/iphone-12',
          imageUrl: 'https://example.com/iphone-12.png',
          price: '900.0 USD',
          priceAmount: 900,
          currency: 'USD',
          productType: 'Technology',
          discount: '1',
          variants: 'Capacity (64gb, 128gb)',
          score: 10
        },
        {
          name: 'iPhone 13',
          description: 'smartphone',
          embeddingText: 'iPhone 13 smartphone',
          url: 'https://example.com/iphone-13',
          imageUrl: 'https://example.com/iphone-13.png',
          price: '1099.0 USD',
          priceAmount: 1099,
          currency: 'USD',
          productType: 'Technology',
          discount: '0',
          variants: 'Capacity (128gb, 256gb)',
          score: 9
        }
      ])
    } as unknown as jest.Mocked<ProductsService>;

    currencyService = {
      convertCurrencies: jest.fn().mockImplementation(async (amount, from, to) => ({
        amount,
        from,
        to,
        convertedAmount: Number((amount * 0.91).toFixed(2)),
        rate: 0.91,
        stale: false
      }))
    } as unknown as jest.Mocked<CurrencyService>;

    service = new ChatService(configService, productsService, currencyService);
  });

  it('completes function-calling flow and returns final response', async () => {
    const result = await service.processMessage({
      message: 'Busco un iphone'
    });

    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain('iPhone 12');
    expect(result.products?.[0]).toEqual({
      title: 'iPhone 12',
      price: 900,
      currency: 'USD',
      embeddingText: 'iPhone 12 smartphone',
      url: 'https://example.com/iphone-12',
      imageUrl: 'https://example.com/iphone-12.png',
      productType: 'Technology',
      discount: '1',
      variants: 'Capacity (64gb, 128gb)'
    });
    expect(productsService.searchProducts).toHaveBeenCalledWith('iphone', 2);
    expect(result.metadata?.functionsExecuted).toContain('searchProducts');
  });

  it('converts product prices to requested currency and adds approximate range intro', async () => {
    const result = await service.processMessage({
      message: 'What is the price of the watch in Euros'
    });

    expect(currencyService.convertCurrencies).toHaveBeenCalled();
    expect(result.products?.every((product) => product.currency === 'EUR')).toBe(true);
    expect(result.message).toContain('similar items are usually around');
  });

  it('adds approximate range intro for generic price question without currency', async () => {
    const result = await service.processMessage({
      message: 'How much does a watch costs?'
    });

    expect(currencyService.convertCurrencies).not.toHaveBeenCalled();
    expect(result.message).toContain('similar items are usually around');
    expect(result.products?.length).toBeGreaterThanOrEqual(1);
  });
});
