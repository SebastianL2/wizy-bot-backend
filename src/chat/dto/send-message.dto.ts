import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({
    example: 'Estoy buscando un telefono barato',
    description: 'User message for the chatbot'
  })
  @IsString({ message: 'message must be a string' })
  @IsNotEmpty({ message: 'message cannot be empty' })
  @MaxLength(1000, { message: 'message must not exceed 1000 characters' })
  message!: string;
}
