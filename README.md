# WizBot Backend - NestJS Function Calling API

REST API built with NestJS + TypeScript that provides an intelligent chatbot with OpenAI Chat Completions and Function Calling.

## Features

- `POST /api/chat` endpoint that receives `{ "message": "string" }`
- OpenAI function-calling loop with multiple tool turns
- Product search tool over `Full Stack Test products_list.csv`
- Currency conversion tool with Open Exchange Rates API
- Exchange rate cache up to 1 hour
- Global validation, structured error handling, and Swagger docs

## Prerequisites

- Node.js v18+
- npm v9+ (or Yarn equivalent)
- OpenAI API key
- Open Exchange Rates App ID

## Environment Variables

Copy `.env.example` into `.env` and fill required values:

```bash
cp .env.example .env
```

Variables:

- `PORT`: HTTP server port (`3000` default)
- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_MODEL`: OpenAI model for Chat Completions
- `OPEN_EXCHANGE_APP_ID`: App ID from Open Exchange Rates
- `PRODUCTS_CSV_PATH`: CSV path (`./Full Stack Test products_list.csv` by default)

## Installation & Run

```bash
npm install
npm run build
npm run start:dev
```

## API Documentation (Swagger)

- URL: [http://localhost:3000/api/docs](http://localhost:3000/api/docs)
- Includes request/response schemas and possible error codes

## Main Endpoint

- Method: `POST`
- URL: `http://localhost:3000/api/chat`
- Headers: `Content-Type: application/json`
- Body:

```json
{ "message": "string" }
```

- Response:

```json
{
  "response": "string",
  "metadata": {
    "totalTokens": 120,
    "functionsExecuted": ["searchProducts"]
  }
}
```

## cURL Examples

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Estoy buscando un teléfono"}'
```

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "¿Cuál es el precio del iPhone en Euros?"}'
```

## Use Cases

- Product recommendation:
  - "Necesito unas sandalias para niño"
- Price conversion:
  - "Convierte 300 USD a COP"
- Multi-tool query:
  - "¿Cuánto cuesta el iPhone en EUR?"

## Testing

```bash
npm run test
npm run test:e2e
npm run test:cov
```

Coverage threshold is set to **70%** globally.

## How to get API keys

1. OpenAI
   - Go to [https://platform.openai.com](https://platform.openai.com)
   - Create an API key from your account dashboard
2. Open Exchange Rates
   - Go to [https://openexchangerates.org/](https://openexchangerates.org/)
   - Sign up and copy your `App ID`
