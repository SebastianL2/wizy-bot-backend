import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ChatController } from '../src/chat/chat.controller';
import { ChatService } from '../src/chat/chat.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

describe('ChatController (integration)', () => {
  let app: INestApplication;

  const chatServiceMock = {
    processMessage: jest.fn().mockResolvedValue({
      response: 'Respuesta de prueba',
      metadata: {
        totalTokens: 42,
        functionsExecuted: ['searchProducts']
      }
    })
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: chatServiceMock }]
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true
      })
    );
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/chat returns a valid response', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/chat')
      .send({ message: 'hola' })
      .expect(200);

    expect(response.body.response).toBe('Respuesta de prueba');
  });

  it('POST /api/chat validates input payload', async () => {
    await request(app.getHttpServer())
      .post('/api/chat')
      .send({ message: '' })
      .expect(400);
  });
});
