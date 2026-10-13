# E-commerce API

A REST API built with NestJS, TypeScript, PostgreSQL, and Prisma. The current application provides customer registration and sign-in, refreshable sessions, and inventory operations for products and time-limited stock reservations. It is a backend foundation; it does not currently include a storefront, cart, payment integration, or order fulfillment workflow.

## What it does

- Registers customers and authenticates them with short-lived access tokens and rotating refresh tokens.
- Tracks products, on-hand stock, reserved stock, and stock movements.
- Lets administrators create products and adjust stock.
- Lets authenticated customers reserve available stock, inspect their reservations, and release or commit an active reservation.
- Expires abandoned reservations automatically so their stock becomes available again.

## How it works

The API is organized into NestJS modules. Controllers define HTTP routes and validate incoming DTOs; services contain business logic and use `PrismaService` to access PostgreSQL.

```text
prisma.config.ts
prisma/
  schema.prisma
  migrations/
src/
  auth/       registration, login, JWT/session lifecycle, authentication guard
  users/      user persistence and credential lookup
  inventory/  products, stock movements, reservations, role guard, expiry sweep
  prisma/     Prisma client connection lifecycle
  main.ts     HTTP bootstrap, Helmet, CORS, validation, shutdown hooks
```

### Authentication and access control

The JWT guard is global: routes require `Authorization: Bearer <accessToken>` unless marked with `@Public()`. New routes should be treated as authenticated by default. The `@CurrentUser()` decorator provides the authenticated user's ID and email. Routes that need a role use `@Roles(...)` and `RolesGuard`, which reads the user's current role from the database.

Passwords are hashed with Argon2id. Access and refresh tokens use separate secrets, HS256, and issuer/audience validation. Refresh tokens are stored as hashes in `AuthSession`; refreshing rotates the token, and reuse of a replaced token revokes the user's sessions. Expired sessions are cleaned up daily.

New users have the `CUSTOMER` role. There is no public endpoint for promoting a user to `ADMIN`; administrator provisioning must be handled through a trusted operational process.

### Inventory and reservations

`InventoryItem.onHand` is physical stock and `InventoryItem.reserved` is stock held for active reservations. Available stock is `onHand - reserved`. Stock changes are performed transactionally, with a `StockMovement` ledger entry for initial stock, adjustments, and committed reservations.

Reservation requests merge duplicate SKUs and update inventory in a transaction. A conditional database update only reserves stock when enough remains, preventing concurrent requests from overselling. Reservation keys are unique per user, and stock adjustment keys are unique in the movement ledger, making retries safe. A reservation is held for 15 minutes. A scheduled worker checks for expired holds every minute and releases their reserved quantities; it uses PostgreSQL row locking so multiple app instances can share the work.

Reservation states are `ACTIVE`, `COMMITTED`, `RELEASED`, and `EXPIRED`. Only an active, unexpired reservation can be committed. Committing reduces both `reserved` and `onHand`; releasing or expiring only reduces `reserved`.

## Requirements

- Node.js and npm (use a version compatible with the installed NestJS/TypeScript toolchain).
- PostgreSQL.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a PostgreSQL database and copy `.env.example` to `.env`. Set `DATABASE_URL` to the local database. Replace both token secrets with distinct random values of at least 32 bytes. Do not use development secrets in a deployed environment.

   The API requires `DATABASE_URL`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE`. Token TTLs have defaults, shown below. `PORT` defaults to `3000`; `CORS_ORIGINS` is an optional comma-separated allow-list.

   ```dotenv
   DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/ecommerce?schema=public"
   ACCESS_TOKEN_SECRET="replace-with-a-random-secret-at-least-32-bytes"
   REFRESH_TOKEN_SECRET="use-a-different-random-secret-at-least-32-bytes"
   ACCESS_TOKEN_TTL_SECONDS=900
   REFRESH_TOKEN_TTL_SECONDS=2592000
   JWT_ISSUER="ecommerce-api"
   JWT_AUDIENCE="ecommerce-api"
   PORT=3000
   # Optional:
   # CORS_ORIGINS="http://localhost:5173,https://shop.example.com"
   ```

3. Apply the Prisma schema and generate the client. The checked-in migration history currently contains only the original user and session migrations, while `schema.prisma` also defines inventory tables and newer session/user fields. For a local development database, create and apply a migration from the current schema:

   ```bash
   npx prisma migrate dev --name complete_current_schema
   npx prisma generate
   ```

   Review and commit the resulting migration. For a deployed database, use reviewed, committed migrations with `npx prisma migrate deploy`; do not use `migrate dev` against production.

4. Start the API:

   ```bash
   npm run start:dev
   ```

   The server listens on `http://localhost:3000` by default. `GET /` returns a simple `Hello World!` response.

## HTTP API

All request bodies are validated. Unknown properties are rejected, and DTO values are transformed where configured. Unless otherwise stated, endpoints require a bearer access token. IDs for reservation routes are UUIDs.

### Authentication

| Method | Path | Auth | Request | Result |
| --- | --- | --- | --- | --- |
| `POST` | `/auth/register` | Public | `{ "email": "person@example.com", "password": "secret123" }` | `201`; user ID, email, creation time |
| `POST` | `/auth/login` | Public | `{ "email": "person@example.com", "password": "secret123" }` | `200`; access and refresh tokens |
| `POST` | `/auth/refresh` | Public | `{ "refreshToken": "..." }` | `200`; rotated access and refresh tokens |
| `POST` | `/auth/logout` | Public | `{ "refreshToken": "..." }` | `204`; revokes that session when valid |
| `POST` | `/auth/logout-all` | Bearer | No body | `204`; revokes all sessions for the current user |

Registration normalizes email to lowercase and requires a valid email and a password of 6–128 characters. Login returns `accessToken`, `refreshToken`, `tokenType`, `accessTokenExpiresIn`, and `refreshTokenExpiresIn`.

### Inventory

| Method | Path | Access | Request | Result |
| --- | --- | --- | --- | --- |
| `POST` | `/inventory/products` | Admin | `{ "sku": "PHONE-001", "name": "Phone", "initialStock": 20 }` | `201`; product and initial stock |
| `POST` | `/inventory/products/:sku/adjust` | Admin | `Idempotency-Key` header; `{ "delta": 5, "reason": "Restock" }` | `200`; updated stock |
| `GET` | `/inventory/products/:sku` | Bearer | — | `200`; product name and on-hand, reserved, available quantities |
| `POST` | `/inventory/reservations` | Bearer | `Idempotency-Key` header; `{ "items": [{ "sku": "PHONE-001", "quantity": 1 }] }` | `201`; reservation |
| `GET` | `/inventory/reservations/:id` | Bearer, owner | — | `200`; reservation and items |
| `POST` | `/inventory/reservations/:id/release` | Bearer, owner | No body | `200`; released reservation |
| `POST` | `/inventory/reservations/:id/commit` | Bearer, owner | No body | `200`; committed reservation |

Both inventory idempotency keys must be sent as `Idempotency-Key` and contain 8–128 characters. Reservation items accept 1–50 entries; each quantity must be between 1 and 10,000. Product SKUs must match `^[A-Z0-9][A-Z0-9_-]{1,63}$`. Stock adjustment deltas may be from -1,000,000 to 1,000,000, excluding zero; an adjustment cannot reduce on-hand stock below the reserved quantity.

Typical errors use NestJS HTTP status codes: `400` for invalid input or missing idempotency keys, `401` for invalid/missing credentials, `403` for insufficient role access, `404` for unknown products or reservations, and `409` for conflicts such as insufficient stock or invalid reservation state.

### Example flow

Register and sign in to obtain a bearer token:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer@example.com","password":"secret123"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer@example.com","password":"secret123"}'
```

Use the returned access token to reserve stock. Replace the example token with the `accessToken` from login:

```bash
curl -X POST http://localhost:3000/inventory/reservations \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: checkout-attempt-001' \
  -d '{"items":[{"sku":"PHONE-001","quantity":1}]}'
```

Product creation and stock adjustment require an account whose database role is `ADMIN`.

## Development commands

```bash
npm run start:dev  # watch mode
npm run build       # compile
npm run lint        # lint src/ and test/
npm test            # unit tests
npm run test:e2e    # end-to-end tests
```

The test suite is still in progress. In particular, `test/inventory.e2e-spec.ts` is an unfinished scaffold and currently references test setup variables that are not defined; inventory e2e coverage needs repair before relying on `npm run test:e2e` as a complete verification.

## Schema changes and migrations

`prisma/schema.prisma` is the source of truth for the data model. When it changes, create and review a migration, then regenerate the client:

```bash
npx prisma migrate dev --name describe_the_change
npx prisma generate
```

Commit both the migration and generated client changes. Production deployment should apply committed migrations using `npx prisma migrate deploy`. Inventory operations rely on PostgreSQL transactions, conditional SQL updates, and `FOR UPDATE SKIP LOCKED`; the implementation is PostgreSQL-specific.
