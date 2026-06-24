export interface ExchangeRatesResponse {
  disclaimer: string;
  license: string;
  timestamp: number;
  base: string;
  rates: Record<string, number>;
}

export interface CurrencyConversionResult {
  amount: number;
  from: string;
  to: string;
  convertedAmount: number;
  rate: number;
  stale: boolean;
  message?: string;
}
