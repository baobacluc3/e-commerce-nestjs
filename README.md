# E-commerce API

A NestJS REST API using TypeScript, PostgreSQL, and Prisma. It currently provides customer registration and authentication with refreshable sessions.

## What it does

- Registers customers and authenticates them with short-lived access tokens and rotating refresh tokens.
- Protects routes by default with bearer-token authentication.
- Cleans up expired sessions daily.

## Requirements

- Node.js and npm compatible with the installed NestJS and TypeScript versions.
- PostgreSQL.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE`.

3. Apply migrations and generate the Prisma client:

   ```bash
   npx prisma migrate dev
   npx prisma generate
   ```

4. Start the API:

   ```bash
   npm run start:dev
   ```

## Authentication endpoints

| Method | Path | Access |
| --- | --- | --- |
| `POST` | `/auth/register` | Public |
| `POST` | `/auth/login` | Public |
| `POST` | `/auth/refresh` | Public |
| `POST` | `/auth/logout` | Public |
| `POST` | `/auth/logout-all` | Bearer token |

## Development commands

```bash
npm run start:dev
npm run build
npm run lint
npm test
npm run test:e2e
```
