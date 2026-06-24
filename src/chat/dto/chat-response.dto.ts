import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
    example: 'Te recomiendo iPhone 12 por 900.00 USD.',
    description: 'Assistant final response'
  })
  response!: string;

  @ApiPropertyOptional({
    type: ChatMetadataDto,
    description: 'Optional metadata from LLM execution'
  })
  metadata?: ChatMetadataDto;
}
