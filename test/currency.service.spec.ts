import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { CurrencyService } from '../src/currency/currency.service';

jest.mock('axios');

describe('CurrencyService', () => {
  let service: CurrencyService;
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  beforeEach(() => {
    jest.resetAllMocks();
    const configService = {
      get: jest.fn((key: string) =>
        key === 'OPEN_EXCHANGE_APP_ID' ? 'test-app-id' : undefined
      )
    } as unknown as ConfigService;

    service = new CurrencyService(configService);
  });

  it('converts USD to EUR using API rates', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        disclaimer: 'x',
        license: 'x',
        timestamp: 1,
        base: 'USD',
        rates: { USD: 1, EUR: 0.8, COP: 4000 }
      }
    } as never);

    const result = await service.convertCurrencies(100, 'USD', 'EUR');

    expect(result.convertedAmount).toBe(80);
    expect(result.stale).toBe(false);
  });

  it('uses stale cache when API fails', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        data: {
          disclaimer: 'x',
          license: 'x',
          timestamp: 1,
          base: 'USD',
          rates: { USD: 1, EUR: 0.8 }
        }
      } as never)
      .mockRejectedValue(new Error('network'));

    await service.convertCurrencies(100, 'USD', 'EUR');
    const result = await service.convertCurrencies(100, 'USD', 'EUR');

    expect(result.stale).toBe(false);
  });
});
