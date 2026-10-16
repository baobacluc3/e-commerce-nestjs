# Flash Sale Reservation & Order Orchestration — Design Proposal

**Status:** For technical review before implementation  
**Stack:** NestJS + TypeScript, Prisma 7, PostgreSQL, Redis Lua, BullMQ, Prometheus/Grafana, k6  
**Targets:** 500 concurrent requests against 100 units: exactly 100 successful reservations; reservation lifetime 10 minutes; target staging load 1,500+ order requests/s and p95 under 300 ms (to be measured, not assumed).

## 1. Decision summary

**PostgreSQL is the durable source of truth. Redis is the atomic fast admission layer and reservation mirror, not the sole correctness boundary.** Redis Lua checks and reserves all requested campaign SKUs atomically, so depleted-stock requests can be rejected before they create database contention. A PostgreSQL transaction then performs authoritative conditional stock updates and writes the reservation, order, idempotency result, audit history, and outbox events atomically. If Redis is unavailable or not reconciled, new flash-sale writes fail closed with `503`; product and inventory read APIs remain available. PostgreSQL's guarded updates still prevent overselling if Redis state is stale.

Campaign stock is allocated from normal sellable stock before the campaign opens. Each campaign SKU tracks `available`, `reserved`, and `sold`, with invariant `available + reserved + sold = allocated`. Reservation moves units `available -> reserved`; payment confirmation moves `reserved -> sold`; expiry/failure moves `reserved -> available`. Add database `CHECK` constraints for non-negative counters, and perform all counter changes in a transaction.

Use Redis Lua for low-latency all-or-nothing multi-SKU admission; use PostgreSQL row locks and guarded updates for durable correctness. Lock all SKU rows in ascending `productId` order. This deliberately favours correctness and predictable recovery over accepting writes while Redis is unhealthy.

## 2. Main data model

- `FlashSaleCampaign`: state, start/end time, per-user quantity limit, campaign configuration/version.
- `FlashSaleStock`: unique `(campaignId, productId)`, `allocated`, `available`, `reserved`, `sold`, `version`; `CHECK` all counters non-negative and total invariant maintained in service/transaction.
- `Reservation`: unique ID, user/campaign, status (`ACTIVE`, `CONFIRMED`, `RELEASED`, `EXPIRED`), `expiresAt`, idempotency key/hash, created/updated timestamps.
- `ReservationItem`: reservation, product, quantity, immutable name/price snapshot.
- `FlashSaleUserQuota`: one row per `(campaignId, userId)`; active reserved quantity and purchased quantity, guarded against the campaign's configured maximum in the same DB transaction.
- `Order`, `OrderItem`, `OrderStatusHistory`, `WebhookEvent`, `PaymentIntent`: reuse existing modules; extend states with `EXPIRED`, `REFUND_PENDING`, and `REFUNDED` as needed.
- `OutboxEvent`: durable work requests for reservation expiry, notifications, and refunds. A dispatcher publishes outbox rows to BullMQ and marks them delivered. This closes the failure window between DB commit and queue insertion.

Idempotency is persisted in PostgreSQL with unique `(userId, campaignId/route, key)`, a canonical request hash, 24-hour expiry, and stored response. Same key + same body replays; same key + different body returns `422`; a concurrent in-progress request waits briefly or returns `409`. A stale-claim recovery policy handles a process crash before completion.

## 3. Reservation and payment flow

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as NestJS API
  participant R as Redis Lua
  participant D as PostgreSQL
  participant Q as BullMQ / Outbox dispatcher

  C->>A: POST reservation + Idempotency-Key
  A->>D: Claim/check idempotency key
  alt same key already completed
    D-->>A: Stored response
    A-->>C: Replay prior response
  else new key
    A->>R: Lua: check all SKUs and user quota; reserve all or none
    alt insufficient Redis capacity / Redis unavailable
      R-->>A: Reject (or 503 if unavailable)
      A-->>C: 409 sold out / 503 unavailable
    else provisional Redis hold
      R-->>A: Hold accepted
      A->>D: Transaction: lock SKUs sorted; guarded DB reserve; create order/items/reservation/audit/idempotency/outbox
      alt DB transaction fails
        D-->>A: Rollback
        A->>R: Idempotent compensation/release provisional hold
        A-->>C: Conflict / retryable failure
      else DB commit succeeds
        D-->>A: Durable reservation + response
        A->>R: Finalize provisional hold with 10-minute logical expiry
        A-->>C: PENDING_PAYMENT + expiresAt
        Q->>D: Dispatch durable expiry outbox event
        Q->>Q: Schedule delayed expiry job
      end
    end
  end
```

```mermaid
sequenceDiagram
  autonumber
  participant P as Payment provider
  participant W as Webhook API
  participant D as PostgreSQL
  participant R as Redis
  participant Q as Expiry worker

  par Successful payment callback
    P->>W: Signed payment event
    W->>W: Verify HMAC on raw bytes
    W->>D: Transaction: unique eventId; lock order then reservation; use DB time
  and Expiry job becomes due
    Q->>D: Transaction: lock same order then reservation; use DB time
  end
  Note over D: Row locks serialize the race; only one transition can win.
  alt Payment wins before expiresAt
    D->>D: ACTIVE -> CONFIRMED; reserved -> sold; order -> PAID; audit/outbox
  else Expiry wins, or payment is received after expiresAt
    D->>D: ACTIVE -> EXPIRED; reserved -> available; order -> EXPIRED
    D->>D: Persist payment event; late success -> REFUND_PENDING + refund outbox
  end
  D-->>R: Apply idempotent mirror update after commit
  Q->>D: Recheck any delayed/retried jobs; terminal states are no-ops
```

### State/race rules

All expiry and payment-success code paths lock records in one order: **Order → Reservation → campaign stock rows sorted by `productId` → user quota**. They use PostgreSQL time (`CURRENT_TIMESTAMP`/`clock_timestamp()`), not app-server clocks. BullMQ delays are triggers, not the authority on whether a reservation is expired.

- Payment is eligible only if the reservation is still active and DB time is before `expiresAt`. It confirms the reservation and marks the order paid; the expiry worker becomes a no-op.
- If expiry wins, it releases the reservation once, marks the order `EXPIRED`, and records history. A later valid success webhook is still inserted in `WebhookEvent`, moves the order to `REFUND_PENDING`, and creates a refund outbox task. It never takes back stock or silently discards the event.
- Worker retries are safe because transitions condition on the current reservation status. `ACTIVE -> EXPIRED/CONFIRMED` can happen only once. Stock movements and status-history records are written in the same transaction as their state change.
- Invalid HMAC is rejected with `401` before any mutation. `eventId` has a unique DB constraint; duplicate event ID + identical payload is acknowledged, while reuse with a different payload is quarantined/rejected.

## 4. Redis Lua keys, TTL, and consistency

Use campaign-scoped keys sharing a Redis Cluster hash tag, e.g. `fs:{campaignId}:stock:{productId}`, `fs:{campaignId}:reservation:{reservationId}`, and `fs:{campaignId}:expiry`. Lua first checks every SKU and the per-user quota, then decrements counters and writes a provisional reservation in one atomic script. The script validates all requested products before changing any counter, so multi-item carts are all-or-nothing. All SKU IDs are sorted before DB locking as well.

Treat 10 minutes as a **logical reservation TTL** stored as `expiresAt` plus an expiry sorted-set entry; do not rely on automatic key expiry to return units—Redis key expiration does not atomically increment stock counters. Keep reservation state long enough for reconciliation. A short provisional lease (for a request that reserved Redis but never committed PostgreSQL) is recovered by a sweeper; a Lua release checks state and can restore capacity only once.

Redis is a mirror/accelerator; DB conditional updates remain authoritative. If DB rejects a provisional hold, compensate Redis with an idempotent Lua release. If compensation fails, reconciliation repairs the mirror. If Redis restarts, loses state, or fails health checks, set the campaign write gate to not-ready; rebuild counters and reservation state from PostgreSQL before reopening writes. While Redis is unavailable, return `503` for new reservation requests rather than falling back to an uncontrolled hot DB write path. Read APIs continue using their own bounded DB capacity/cache path.

A scheduled reconciliation process compares Redis with PostgreSQL, identifies orphan provisional holds and active reservations missing from Redis, repairs counters, and reports drift. Rebuilds must gate writes for the affected campaign or use a versioned atomic swap; never overwrite live counters from a stale snapshot while new reservations are running.

## 5. Throughput, isolation, and observability

- Let Lua reject sold-out requests before they hit PostgreSQL. Keep transactions short: no Redis/network calls, payment-provider calls, logging I/O, or queue calls inside DB transactions.
- PostgreSQL guarded updates + sorted row locks are the correctness backstop. A single hot SKU remains a serialized resource; the 1,500 req/s target must be validated in staging and is not guaranteed by architecture alone.
- Put write traffic behind rate limits and a bounded concurrency/bulkhead. Use separate worker/pool budgets for read APIs so checkout pressure cannot consume every DB connection. Set transaction/statement timeouts and reject overload early.
- Emit structured logs with `correlationId`, `reservationId`, `orderId`, `campaignId`, `eventId`, and outcome (avoid card/payment secrets and raw idempotency keys). Propagate correlation ID through HTTP, outbox, BullMQ job data, and webhook event handling.
- Prometheus: reservation attempts/success/rejections, oversell guard rejections, active/expired reservations, Redis script latency/errors, DB transaction latency/lock waits, webhook duplicate/late counts, outbox age/backlog, queue waiting/active/failed depth, HTTP p95/p99 and 5xx/429/503 rates. Alert on outbox age, stuck active reservations past TTL, Redis-not-ready, and reconciliation drift.

## 6. Test and release gates

1. Unit tests: full state-transition matrix; Lua all-or-none behavior; quota boundaries; expiry/payment winner rules.
2. Integration: 500 concurrent requests against 100 units yields exactly 100 durable active reservations; 10 parallel calls with one key create one order; multi-SKU failure leaves every SKU unchanged; duplicate webhook 5+ times changes state once; late webhook produces `REFUND_PENDING`; crash/retry of release restores stock once; Redis outage rejects writes without oversell.
3. k6 staged ramps (10/50/100/250/500+ VUs) with unique users/keys and prepared carts, then measure throughput, p95/p99, errors, queue depth, DB lock waits, and Redis latency. Report actual findings; do not claim 1,500 req/s or p95 < 300 ms without measurements.
4. Rollout: schema backward-compatible migration first; deploy code that understands old/new states; seed campaign and Redis mirror; verify reconciliation/readiness; enable a small test campaign; gradually open traffic.

## 7. Initial runbook

- **Expiry backlog/stuck job:** check BullMQ failed/delayed depth and oldest outbox age; retry idempotently; run a DB sweep for `ACTIVE` reservations with `expiresAt <= DB time`. Do not manually increment Redis stock before checking DB reservation status.
- **Redis/DB drift or Redis restart:** close writes for the campaign; rebuild Redis stock and active reservation state from PostgreSQL; run invariant checks (`available + reserved + sold = allocated`, no negative counters, expired reservations not active); reopen only after drift reaches zero.
- **Late payment:** confirm `WebhookEvent` and `REFUND_PENDING` audit history; process the durable refund outbox; do not re-open the reservation or reduce stock a second time.
- **Suspected oversell:** stop new campaign writes, preserve logs/metrics, reconcile reservation and movement ledgers against stock rows, and resume only after an operator validates invariants.

**Review questions:** approve PostgreSQL as the correctness source, Redis fail-closed behavior during incidents, DB-time expiry semantics, campaign-level write gate during rebuild, and the refund policy for payment callbacks received after reservation expiry.

## References

- [Redis Lua scripting and atomic execution](https://redis.io/docs/latest/interact/programmability/eval-intro/)
- [PostgreSQL row locking (`SELECT ... FOR UPDATE`)](https://www.postgresql.org/docs/current/sql-select.html)
- [Prisma transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)
- [BullMQ delayed jobs](https://docs.bullmq.io/guide/jobs/delayed)
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)
