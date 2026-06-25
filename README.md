# WizBot Backend - NestJS Function Calling API

REST API built with NestJS + TypeScript that provides an intelligent chatbot with OpenAI Chat Completions and Function Calling.

## Features

- `POST /api/chat` endpoint that receives `{ "message": "string" }`
- Optional `sessionId` to keep conversation context across requests
- OpenAI function-calling loop with multiple tool turns
- Product search tool over `full_stack_test_products_list_rmk.csv`
- Currency conversion tool with Open Exchange Rates API
- Exchange rate cache up to 1 hour
- Global validation, structured error handling, and Swagger docs

## Prerequisites

- Node.js v18+
- npm v9+ (or Yarn equivalent)
- Docker + Docker Compose (optional, for containerized run)
- OpenAI API key
- Open Exchange Rates App ID

## Environment Variables

Copy `.env.example` into `.env` and fill required values:

```bash
cp .env.example .env
```

Variables:

- `PORT`: HTTP server port (`3005` default)
- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_MODEL`: OpenAI model for Chat Completions
- `OPEN_EXCHANGE_APP_ID`: App ID from Open Exchange Rates
- `PRODUCTS_CSV_PATH`: CSV path (`./full_stack_test_products_list_rmk.csv` by default)

## Installation & Run

```bash
npm install
npm run build
npm run start:dev
```

Default local port: `3005`

## Run with Docker (recommended)

1. Prepare env:

```bash
cp .env.example .env
```

2. Build and run backend:

```bash
docker-compose up --build
```

3. Stop services:

```bash
docker-compose down
```

Services started by compose:

- Backend: `http://localhost:3005`
- Swagger: `http://localhost:3005/api/docs`

## API Documentation (Swagger)

- URL: [http://localhost:3005/api/docs](http://localhost:3005/api/docs)
- Includes request/response schemas and possible error codes

## Main Endpoint

- Method: `POST`
- URL: `http://localhost:3005/api/chat`
- Headers: `Content-Type: application/json`
- Body:

```json
{
  "message": "string",
  "sessionId": "optional-string"
}
```

- Response:

```json
{
  "message": "string",
  "products": [
    {
      "title": "iPhone 12",
      "price": 900,
      "currency": "USD"
    }
  ],
  "metadata": {
    "totalTokens": 120,
    "functionsExecuted": ["searchProducts"],
    "sessionId": "f17d7ad1-9c25-4ec8-892e-09f46f2f9af6"
  }
}
```

Reuse the same `sessionId` value in the next request to continue the same conversation.

## Reset Session Endpoint

- Method: `DELETE`
- URL: `http://localhost:3005/api/chat/:sessionId`
- Purpose: manually clear stored conversation history for that session

Example:

```bash
curl -X DELETE http://localhost:3005/api/chat/f17d7ad1-9c25-4ec8-892e-09f46f2f9af6
```

## cURL Examples

```bash
curl -X POST http://localhost:3005/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Estoy buscando un teléfono"}'
```

```bash
curl -X POST http://localhost:3005/api/chat \
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

The test suite lives under `test/` and uses **Jest**. Tests are split into **unit tests** (`*.spec.ts`) and **integration tests** (`*.int-spec.ts`).

### Commands

```bash
# Run all unit tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run integration tests (HTTP layer)
npm run test:e2e

# Run unit tests with coverage report
npm run test:cov
```

Run a single file:

```bash
npm run test -- chat.service.spec.ts
npm run test -- products.service.spec.ts
npm run test:e2e -- chat.controller.int-spec.ts
```

### Test structure

```text
test/
├── chat.service.spec.ts          # Unit tests for ChatService
├── products.service.spec.ts      # Unit tests for ProductsService
├── currency.service.spec.ts      # Unit tests for CurrencyService
├── chat.controller.int-spec.ts   # Integration tests for ChatController
├── jest-e2e.json                 # Jest config for integration tests
└── fixtures/
    └── products.csv              # Minimal product catalog for unit tests
```

### Unit tests

| File | Service | What it validates |
|------|---------|-------------------|
| `chat.service.spec.ts` | `ChatService` | OpenAI function-calling flow (mocked), product search with up to 10 candidates, selection of 2 products for the response, currency conversion on product prices, and approximate price range messages |
| `products.service.spec.ts` | `ProductsService` | Product search by query, fallback when no matches, recipient-based filtering (e.g. dad gift queries exclude female-only products) |
| `currency.service.spec.ts` | `CurrencyService` | USD → EUR conversion using mocked Open Exchange Rates API, stale-cache fallback when the API fails |

Unit tests mock external dependencies (OpenAI, axios, CSV path) so they run offline and do not require API keys.

### Integration tests

| File | Scope | What it validates |
|------|-------|-------------------|
| `chat.controller.int-spec.ts` | `ChatController` | `POST /api/chat` returns 200 with a valid body, empty `message` returns 400, `DELETE /api/chat/:sessionId` resets session |

Integration tests boot a NestJS app with a mocked `ChatService` and use **supertest** against the HTTP layer (validation pipes and exception filters included).

### Fixtures

`test/fixtures/products.csv` is a small catalog used by `ProductsService` unit tests. It includes sample Technology, Home, Clothing, and Makeup products so search, fallback, and recipient-profile logic can be tested without loading the full production CSV.

### Coverage

Coverage is collected from `src/**/*.ts`, excluding `main.ts`, `*.module.ts`, and DTO files.

Thresholds (see `package.json` → `jest.coverageThreshold`):

| Metric | Minimum |
|--------|---------|
| Branches | 40% |
| Functions | 70% |
| Lines | 70% |
| Statements | 70% |

Report output: `coverage/` (generated after `npm run test:cov`).

## How to get API keys

1. OpenAI
   - Go to [https://platform.openai.com](https://platform.openai.com)
   - Create an API key from your account dashboard
2. Open Exchange Rates
   - Go to [https://openexchangerates.org/](https://openexchangerates.org/)
   - Sign up and copy your `App ID`
