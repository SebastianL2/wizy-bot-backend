import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class ProductOutputDto {
  @ApiProperty({ example: 'iPhone 12' })
  title!: string;

  @ApiPropertyOptional({ example: 900 })
  price?: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiPropertyOptional({
    example: 'iPhone 12 Technology technology, celulares ...'
  })
  embeddingText?: string;

  @ApiPropertyOptional({
    example: 'https://wizybot-demo-store.myshopify.com/products/iphone-12'
  })
  url?: string;

  @ApiPropertyOptional({
    example:
      'https://cdn.shopify.com/s/files/1/0779/8125/3922/files/ScreenShot2023-06-21at4.49.19PM.png'
  })
  imageUrl?: string;

  @ApiPropertyOptional({ example: 'Technology' })
  productType?: string;

  @ApiPropertyOptional({ example: '1' })
  discount?: string;

  @ApiPropertyOptional({
    example: 'Color (Black, Blue, Red, Green, White), Capacity (64gb, 128gb)'
  })
  variants?: string;
}

class CurrencyConversionOutputDto {
  @ApiProperty({ example: 350 })
  amount!: number;

  @ApiProperty({ example: 'EUR' })
  from!: string;

  @ApiProperty({ example: 'CAD' })
  to!: string;

  @ApiProperty({ example: 517.23 })
  convertedAmount!: number;

  @ApiProperty({ example: 1.4778 })
  rate!: number;
}

class ChatMetadataDto {
  @ApiPropertyOptional({
    example: 355,
    description: 'Total tokens consumed by OpenAI calls'
  })
  totalTokens?: number;

  @ApiPropertyOptional({
    type: [String],
    example: ['searchProducts', 'convertCurrencies'],
    description: 'Functions executed during the tool-calling loop'
  })
  functionsExecuted?: string[];

  @ApiPropertyOptional({
    example: 'f17d7ad1-9c25-4ec8-892e-09f46f2f9af6',
    description: 'Conversation session id to continue chat context'
  })
  sessionId?: string;
}

export class ChatResponseDto {
  @ApiProperty({
    example: 'Here are two phones you might be interested in:',
    description: 'Assistant textual response'
  })
  message!: string;

  @ApiPropertyOptional({
    type: [ProductOutputDto],
    description: 'Relevant products when product search is involved'
  })
  products?: ProductOutputDto[];

  @ApiPropertyOptional({
    type: CurrencyConversionOutputDto,
    description: 'Single currency conversion result for pure conversion queries'
  })
  conversion?: CurrencyConversionOutputDto;

  @ApiPropertyOptional({
    type: [CurrencyConversionOutputDto],
    description: 'Multiple conversion results (for multi-product conversion)'
  })
  conversions?: CurrencyConversionOutputDto[];

  @ApiPropertyOptional({
    type: ChatMetadataDto,
    description: 'Optional metadata from LLM execution'
  })
  metadata?: ChatMetadataDto;
}
