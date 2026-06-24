import { ConfigService } from '@nestjs/config';
import { ProductsService } from '../src/products/products.service';

describe('ProductsService', () => {
  let service: ProductsService;

  beforeEach(() => {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'PRODUCTS_CSV_PATH') {
          return `${process.cwd()}/test/fixtures/products.csv`;
        }
        return undefined;
      })
    } as unknown as ConfigService;

    service = new ProductsService(configService);
  });

  it('returns top related products for phone query', async () => {
    const result = await service.searchProducts('Busco un telefono', 2);

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].name).toContain('iPhone');
  });

  it('returns fallback products when no matches', async () => {
    const result = await service.searchProducts('tractor agricola', 2);

    expect(result).toHaveLength(2);
    expect(result[0].name.length).toBeGreaterThan(0);
  });
});
