import { Module } from '@nestjs/common';
import { CurrencyModule } from '../currency/currency.module';
import { ProductsModule } from '../products/products.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [ProductsModule, CurrencyModule],
  controllers: [ChatController],
  providers: [ChatService]
})
export class ChatModule {}
