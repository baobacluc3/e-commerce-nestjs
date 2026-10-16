CREATE TYPE "PaymentIntentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'REFUND_REQUIRED');
CREATE TYPE "WebhookEventOutcome" AS ENUM (
    'RECEIVED',
    'PROCESSED',
    'UNKNOWN_PAYMENT',
    'AMOUNT_MISMATCH',
    'ORDER_CANCELLED_REFUND_REQUIRED',
    'ORDER_ALREADY_PROCESSED',
    'ORDER_NOT_PAYABLE'
);

CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "checkout_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payment_intent_id" TEXT,
    "event_type" VARCHAR(100) NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" "WebhookEventOutcome" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_intents_order_id_key" ON "payment_intents"("order_id");
CREATE UNIQUE INDEX "payment_intents_provider_reference_key" ON "payment_intents"("provider_reference");
CREATE UNIQUE INDEX "webhook_events_event_id_key" ON "webhook_events"("event_id");
CREATE INDEX "webhook_events_payment_intent_id_received_at_idx" ON "webhook_events"("payment_intent_id", "received_at");
CREATE INDEX "webhook_events_outcome_received_at_idx" ON "webhook_events"("outcome", "received_at");

ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_payment_intent_id_fkey"
    FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
