# Flash Sale Runbook (starter)

## Safety invariants

For each campaign/product, PostgreSQL must always satisfy:

`available >= 0`, `reserved >= 0`, `sold >= 0`, and `available + reserved + sold = allocated`.

For each campaign/user, `activeQuantity >= 0`, `purchasedQuantity >= 0`, and `activeQuantity + purchasedQuantity <= perUserLimit`.

PostgreSQL is authoritative. Redis is an admission/mirror layer. If the mirror cannot be trusted, close the campaign write gate rather than attempting to guess stock.

## 1. Reservation rate spikes / Redis unavailable

1. Check Redis health, latency, memory, and connectivity from the API and worker containers.
2. New reservation requests must fail closed while the Redis `fs:{campaignId}:ready` key is absent or `0`.
3. Read APIs should remain available; don't route catalog/detail reads through the reservation write gate.
4. Do not manually increase Redis stock hashes to make the campaign available.
5. After Redis returns, keep writes closed until a campaign has been paused and the mirror has been rebuilt from a stable PostgreSQL snapshot.

## 2. Close the campaign safely

1. Set the campaign state to `PAUSED` in PostgreSQL.
2. Close the Redis readiness key: `SET fs:{campaignId}:ready 0`.
3. Stop or drain workers/webhooks that mutate this campaign, or wait until in-flight handlers have completed. The write gate alone prevents new reservations, but payment/expiry handlers still need to settle.
4. Run `FlashSaleRedisMirrorService.rebuildPausedCampaign(campaignId)`.
5. Verify PostgreSQL stock and quota invariants. Compare the mirror's stock/quota hashes to the database snapshot.
6. Set the campaign to `ACTIVE` only when its scheduled window is valid, then run `openCampaignWrites(campaignId)`.
7. Make a small smoke reservation and confirm/cancel it before opening traffic.

Never run a mirror rebuild against an active campaign. The code rejects that call; use a maintenance window.

## 3. Reservations that do not expire

1. Inspect `flash_sale_reservations` for `status = 'ACTIVE'` and `expires_at <= now()`.
2. Inspect BullMQ's `flash-sale-expiration` waiting, delayed, active, and failed counts.
3. Check `outbox_events` for undelivered `FLASH_SALE_RESERVATION_EXPIRE` rows and `last_error`.
4. Re-run safe expiration jobs using the reservation ID. The database transaction checks `expires_at` using PostgreSQL time and locks order/reservation, so repeated jobs are safe.
5. If Redis mirror updates fail after the database transaction commits, the service closes the campaign write gate. Rebuild the mirror while paused; do not manually release stock twice.

## 4. Late payment / refund backlog

1. Query `webhook_events` for `ORDER_CANCELLED_REFUND_REQUIRED` outcomes and inspect the associated order/payment intent.
2. Confirm order state is `REFUND_PENDING` and payment intent is `REFUND_REQUIRED`.
3. Inspect undelivered `PAYMENT_REFUND_REQUESTED` outbox rows and the `flash-sale-refunds` queue.
4. Retry through the queue/outbox. The eventual real gateway refund must use `paymentIntentId` (or the provider's stable charge/reference) as its idempotency key.
5. Do not reopen the order or re-reserve the released stock because a late success webhook arrived.

## 5. Database / Redis counters disagree

1. Close the campaign write gate immediately.
2. Pause the campaign and drain in-flight reservation, payment, and expiry mutations.
3. Verify PostgreSQL invariants first; if the DB itself violates them, stop and use a reviewed reconciliation SQL script rather than inferring the correct value from Redis.
4. Rebuild Redis from PostgreSQL with `rebuildPausedCampaign`.
5. Compare each stock and user quota after rebuild. Keep writes closed if any mismatch remains.
6. Re-open only after `openCampaignWrites` succeeds and a smoke test confirms the ledger.

## 6. Operational notes

- Use PostgreSQL `clock_timestamp()` for expiry decisions. Redis TTL and worker scheduling are not the business-time authority.
- Queue delivery is at-least-once. Keep reservation/payment state transitions idempotent; use stable BullMQ job IDs.
- Keep correlation IDs across HTTP request, reservation/order IDs, outbox event IDs, webhook event IDs, and queue job IDs. Avoid user IDs and order IDs as Prometheus labels.
- The included refund processor only logs a fake refund. It is not safe for real payments until integrated with a provider and its idempotency API.
- Redis mirror repair in this starter repairs the provisional reservation crash window and provides a manual full rebuild. A continuously running full DB-vs-Redis drift detector, alerts, and staging load report are still required before production use.
