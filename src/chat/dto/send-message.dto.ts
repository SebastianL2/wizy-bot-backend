import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({
    example: 'Estoy buscando un telefono barato',
    description: 'User message for the chatbot'
  })
  @IsString({ message: 'message must be a string' })
  @IsNotEmpty({ message: 'message cannot be empty' })
  @MaxLength(1000, { message: 'message must not exceed 1000 characters' })
  message!: string;

  @ApiPropertyOptional({
    example: 'f17d7ad1-9c25-4ec8-892e-09f46f2f9af6',
    description:
      'Optional conversation session id. Reuse the same id to keep context between requests.'
  })
  @IsOptional()
  @IsString({ message: 'sessionId must be a string' })
  @MaxLength(100, { message: 'sessionId must not exceed 100 characters' })
  sessionId?: string;
}
