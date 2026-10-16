# Phase 7 integration checklist

This is a merge checklist for the existing application. Do not copy the schema fragment or migration blindly over existing models or migration history.

## A. Schema and database

- [ ] Merge `prisma/schema.fragment.prisma` and `patches/schema-relations.md` into the live schema, including `Order.correlationId`.
- [ ] Check the existing enum names and table mappings, especially `OrderStatus`, `PaymentIntentStatus`, `AuditActorType`, and `IdempotencyStatus`.
- [ ] Apply `PaymentIntentStatus.REFUNDED` as described in `patches/payment-refund-state.md` and make the existing payment-intent endpoint idempotent using `patches/payment-intent-idempotency.md`.
- [ ] Verify the DB has `OrderStatus.EXPIRED`, `REFUND_PENDING`, `REFUNDED` and audit actor fields used by the code.
- [ ] Review `prisma/migration.sql` against the actual migration history in a disposable database first.
- [ ] Run `npx prisma validate`, `npx prisma migrate deploy` in test, and `npx prisma generate`.
- [ ] Verify raw SQL identifiers match your actual column names (`orders."userId"`, `flash_sale_*` snake_case tables).
- [ ] Verify constraints: stock counters are non-negative, `available + reserved + sold = allocated`, quantities are positive, and campaign time/limit are valid.

## B. Application wiring

- [ ] Add `evalScript`, `set`, `scanKeys`, `hmget`, and `zcard` to the existing Redis service as shown in `src/redis/redis.service.required-patch.md`.
- [ ] Register `ScheduleModule.forRoot()` exactly once.
- [ ] Register `FlashSaleModule` in `AppModule`.
- [ ] Ensure `OrdersModule` exports `OrderQueuesService`.
- [ ] Confirm `FlashSaleModule` registers both BullMQ queues and the expiration/outbox/refund processors.
- [ ] Ensure ConfigModule loads `REDIS_URL`, `JWT_ACCESS_SECRET`, `PAYMENT_WEBHOOK_SECRET`, and other existing config as appropriate.
- [ ] Merge `patches/idempotency-scope-fix.md` and `patches/idempotency-stale-claim.md` into the actual idempotency interceptor.
- [ ] Route the existing payment webhook only after raw-body HMAC verification; merge `patches/payment-webhook-adapter.md`.
- [ ] Merge `patches/metrics-integration.md` into the existing `/metrics` endpoint.
- [ ] Verify cancellation/payment/refund state transitions use the pure `OrderStateMachine`.

## C. Campaign setup and safe opening

1. Create a campaign in `PAUSED` state and seed each SKU's allocation in PostgreSQL.
2. Call `rebuildPausedCampaign(campaignId)` while writes and lifecycle mutation workers are paused/drained.
3. Verify PostgreSQL stock and user-quota ledger checks pass.
4. Activate the campaign only inside its configured time window.
5. Call the restricted operations method `openCampaignWrites(campaignId)`.
6. Run a one-unit smoke reservation, then expire/cancel or confirm it, and check the DB ledger before opening user traffic.

Never expose mirror rebuild or gate opening as an unprotected public endpoint. Protect them with an operator-only command or admin access policy and audit log.

## D. Required tests

- [ ] `tests/order-state-machine.spec.ts`: all state pairs.
- [ ] `tests/flash-sale-reservation.integration.spec.template.ts`: 500 contenders versus 100 inventory, exactly 100 admitted; multi-SKU failed admission does not partially reserve.
- [ ] `tests/flash-sale-idempotency.e2e.spec.template.ts`: ten concurrent identical requests, exactly one order/reservation; RateLimitGuard is bypassed only within this test so the rate limit does not mask idempotency.
- [ ] `tests/flash-sale-lifecycle.integration.spec.template.ts`: duplicate event ID, expiry/payment race, late success/refund, duplicate cancellation, payment failure followed by success.
- [ ] Run `tests/flash-sale-webhook-signature.e2e.spec.template.ts` against the actual webhook controller, verifying 401 and no DB changes.
- [ ] Test Redis unavailable before admission: request fails closed and PostgreSQL remains unchanged.
- [ ] Simulate process crash after DB commit but before direct Redis mirror update; the mirror outbox must repair it.
- [ ] Simulate Redis data loss: missing/closed ready key rejects reservations until maintenance rebuild and integrity checks pass.

## E. Load and deployment

- [ ] Seed enough distinct users/tokens and enough stock for the intended run; don't reuse empty carts or idempotency keys.
- [ ] Configure staging rate limits above the test concurrency or separate rate-limit testing from throughput testing.
- [ ] Run `load-tests/flash-sale-reserve.js` at 100, 250, and 500+ concurrent requests for scarce-stock correctness.
- [ ] Run `load-tests/flash-sale-throughput.js` with `K6_RPS=1500` for sustained target-rate experiments; use a sufficiently large pool of seeded users, raise staging rate limits deliberately, and note that most requests should be expected business rejections after the SKU sells out.
- [ ] Confirm `flash_sale_reservation_attempts_total`, Redis script latency, DB transaction latency, outbox age, queue depth, and late-payment refund metrics are visible.
- [ ] Record measured p95 and throughput; don't claim 1,500 req/s / 300 ms until staging results support it.
- [ ] Get two reviews of migrations, locking, webhook routing, and failure recovery before production.
