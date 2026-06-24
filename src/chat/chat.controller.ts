import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags
} from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { ChatResponseDto } from './dto/chat-response.dto';
import { SendMessageDto } from './dto/send-message.dto';

@ApiTags('chat')
@Controller('api/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a user prompt to the chatbot' })
  @ApiBody({
    type: SendMessageDto,
    examples: {
      search: {
        summary: 'Search related products',
        value: { message: 'Estoy buscando un telefono' }
      }
    }
  })
  @ApiOkResponse({
    type: ChatResponseDto,
    description: 'LLM response with optional metadata'
  })
  @ApiBadRequestResponse({
    description: 'Validation failed for request payload'
  })
  @ApiInternalServerErrorResponse({
    description: 'Unexpected downstream error'
  })
  async chat(@Body() payload: SendMessageDto): Promise<ChatResponseDto> {
    return this.chatService.processMessage(payload);
  }
}
