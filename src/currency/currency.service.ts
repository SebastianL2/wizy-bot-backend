import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import {
  CurrencyConversionResult,
  ExchangeRatesResponse
} from './interfaces/exchange-rates.interface';

/** Cached exchange-rate payload with fetch timestamp. */
interface RatesCache {
  fetchedAt: number;
  payload: ExchangeRatesResponse;
}

/**
 * Converts amounts between supported currencies using Open Exchange Rates
 * with in-memory caching and stale-cache fallback.
 */
@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);
  private readonly ratesEndpoint = 'https://openexchangerates.org/api/latest.json';
  private readonly maxCacheAgeMs = 60 * 60 * 1000;
  private readonly timeoutMs = 5000;
  private readonly maxRetries = 3;

  private cache: RatesCache | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Converts an amount from one currency to another using latest exchange rates.
   *
   * Rates are fetched from Open Exchange Rates (USD base) and may be served
   * from cache when the live API is unavailable.
   *
   * @param amount - Positive numeric amount to convert.
   * @param from - Source currency code (case-insensitive).
   * @param to - Target currency code (case-insensitive).
   * @returns Conversion result including rate, converted amount, and stale flag.
   * @throws BadRequestException when amount is invalid or a currency is unsupported.
   * @throws ServiceUnavailableException when rates cannot be fetched and no cache exists.
   */
  async convertCurrencies(
    amount: number,
    from: string,
    to: string
  ): Promise<CurrencyConversionResult> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('amount must be a positive number');
    }

    const source = from.toUpperCase();
    const target = to.toUpperCase();

    const { payload, stale } = await this.getExchangeRates();
    const rates = payload.rates;

    if (!rates[source]) {
      throw new BadRequestException(`Currency not supported: ${source}`);
    }

    if (!rates[target]) {
      throw new BadRequestException(`Currency not supported: ${target}`);
    }

    const amountInUsd = source === 'USD' ? amount : amount / rates[source];
    const convertedAmount = target === 'USD' ? amountInUsd : amountInUsd * rates[target];
    const rate = convertedAmount / amount;

    return {
      amount,
      from: source,
      to: target,
      convertedAmount: Number(convertedAmount.toFixed(2)),
      rate: Number(rate.toFixed(6)),
      stale,
      message: stale
        ? 'Exchange rates are from cache because live API was unavailable.'
        : undefined
    };
  }

  /**
   * Returns fresh or cached exchange rates, retrying failed API calls.
   *
   * Uses a one-hour in-memory cache. When all retries fail, returns stale
   * cached data if available.
   *
   * @throws ServiceUnavailableException when live fetch fails and cache is empty.
   */
  private async getExchangeRates(): Promise<{
    payload: ExchangeRatesResponse;
    stale: boolean;
  }> {
    if (this.cache && Date.now() - this.cache.fetchedAt <= this.maxCacheAgeMs) {
      return { payload: this.cache.payload, stale: false };
    }

    const appId = this.configService.get<string>('OPEN_EXCHANGE_APP_ID');
    if (!appId) {
      throw new ServiceUnavailableException(
        'Missing OPEN_EXCHANGE_APP_ID environment variable'
      );
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        this.logger.debug(`Fetching exchange rates (attempt ${attempt})`);
        const response = await axios.get<ExchangeRatesResponse>(this.ratesEndpoint, {
          timeout: this.timeoutMs,
          params: { app_id: appId }
        });

        this.cache = {
          fetchedAt: Date.now(),
          payload: response.data
        };

        return { payload: response.data, stale: false };
      } catch (error) {
        this.logger.warn(`Open Exchange Rates call failed on attempt ${attempt}`);
        if (attempt === this.maxRetries) {
          return this.handleRatesFailure(error);
        }
      }
    }

    return this.handleRatesFailure();
  }

  /**
   * Handles exchange-rate fetch failures after retries are exhausted.
   *
   * Falls back to stale cache when possible; otherwise throws an HTTP 503 error.
   *
   * @param error - Optional underlying request error.
   * @throws ServiceUnavailableException when no cached rates are available.
   */
  private handleRatesFailure(
    error?: unknown
  ): Promise<{ payload: ExchangeRatesResponse; stale: boolean }> {
    if (this.cache) {
      this.logger.warn('Returning stale exchange rates from cache');
      return Promise.resolve({ payload: this.cache.payload, stale: true });
    }

    const message =
      error instanceof AxiosError
        ? error.message
        : 'Could not fetch exchange rates and no cache is available';

    this.logger.error('Exchange rates unavailable', message);
    throw new ServiceUnavailableException(
      'Exchange rates service is temporarily unavailable'
    );
  }
}
