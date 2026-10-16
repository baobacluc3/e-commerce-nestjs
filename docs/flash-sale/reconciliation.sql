-- Run in pgAdmin/psql before reopening a paused campaign.
-- PostgreSQL is the source of truth; do not use Redis values to guess repairs.

-- 1. Stock invariant violations (should return zero rows).
SELECT campaign_id, product_id, allocated, available, reserved, sold,
       (available + reserved + sold) AS accounted_for
FROM flash_sale_stocks
WHERE available < 0
   OR reserved < 0
   OR sold < 0
   OR available + reserved + sold <> allocated;

-- 2. User quota problems (should return zero rows).
SELECT q.campaign_id, q.user_id, q.active_quantity, q.purchased_quantity,
       c.per_user_limit
FROM flash_sale_user_quotas q
JOIN flash_sale_campaigns c ON c.id = q.campaign_id
WHERE q.active_quantity < 0
   OR q.purchased_quantity < 0
   OR q.active_quantity + q.purchased_quantity > c.per_user_limit;

-- 3. Active reservations whose deadline passed (expire/reconcile these).
SELECT r.id AS reservation_id, r.order_id, r.campaign_id, r.user_id,
       r.expires_at, o.status AS order_status
FROM flash_sale_reservations r
JOIN orders o ON o.id = r.order_id
WHERE r.status = 'ACTIVE'::flash_sale_reservation_status
  AND r.expires_at <= clock_timestamp()
ORDER BY r.expires_at;

-- 4. Outbox backlog and oldest age (investigate sustained growth).
SELECT type, COUNT(*) AS pending,
       MIN(created_at) AS oldest_event,
       EXTRACT(EPOCH FROM (clock_timestamp() - MIN(created_at))) AS oldest_age_seconds
FROM outbox_events
WHERE delivered_at IS NULL
GROUP BY type
ORDER BY pending DESC;

-- 5. Stale outbox claims (usually a dispatcher crash or a long publish).
SELECT id, type, aggregate_id, attempts, locked_at, last_error
FROM outbox_events
WHERE delivered_at IS NULL
  AND locked_at < clock_timestamp() - INTERVAL '30 seconds'
ORDER BY locked_at;

-- 6. Webhooks that require manual/provider reconciliation.
SELECT e.event_id, e.event_type, e.outcome, e.received_at,
       e.payment_intent_id, p.order_id, p.status AS payment_status
FROM webhook_events e
LEFT JOIN payment_intents p ON p.id = e.payment_intent_id
WHERE e.outcome IN (
  'ORDER_CANCELLED_REFUND_REQUIRED'::"WebhookEventOutcome",
  'UNKNOWN_PAYMENT'::"WebhookEventOutcome",
  'AMOUNT_MISMATCH'::"WebhookEventOutcome"
)
ORDER BY e.received_at DESC
LIMIT 500;
