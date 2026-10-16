-- REVIEW BEFORE APPLYING. This migration assumes the Task 1-5 tables exist.
-- If your PostgreSQL enum has a different name or lacks a listed value,
-- reconcile it with your current schema before running this migration.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TYPE "PaymentIntentStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "PaymentIntentStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

ALTER TABLE "orders" ADD COLUMN "correlation_id" VARCHAR(100);
CREATE INDEX "orders_correlation_id_idx" ON "orders"("correlation_id");

CREATE TYPE "flash_sale_campaign_status" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');
CREATE TYPE "flash_sale_reservation_status" AS ENUM ('PROVISIONAL', 'ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED');

CREATE TABLE "flash_sale_campaigns" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "status" "flash_sale_campaign_status" NOT NULL DEFAULT 'DRAFT',
  "starts_at" TIMESTAMPTZ NOT NULL,
  "ends_at" TIMESTAMPTZ NOT NULL,
  "per_user_limit" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flash_sale_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flash_sale_campaigns_dates_chk" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "flash_sale_campaigns_user_limit_chk" CHECK ("per_user_limit" > 0)
);

CREATE INDEX "flash_sale_campaigns_status_dates_idx"
  ON "flash_sale_campaigns"("status", "starts_at", "ends_at");

CREATE TABLE "flash_sale_stocks" (
  "id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "allocated" INTEGER NOT NULL,
  "available" INTEGER NOT NULL,
  "reserved" INTEGER NOT NULL DEFAULT 0,
  "sold" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flash_sale_stocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flash_sale_stocks_campaign_product_key" UNIQUE ("campaign_id", "product_id"),
  CONSTRAINT "flash_sale_stocks_campaign_fk" FOREIGN KEY ("campaign_id") REFERENCES "flash_sale_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_stocks_product_fk" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_stocks_nonnegative_chk" CHECK ("allocated" >= 0 AND "available" >= 0 AND "reserved" >= 0 AND "sold" >= 0 AND "version" >= 0),
  CONSTRAINT "flash_sale_stocks_invariant_chk" CHECK ("available" + "reserved" + "sold" = "allocated")
);
CREATE INDEX "flash_sale_stocks_product_idx" ON "flash_sale_stocks"("product_id");

CREATE TABLE "flash_sale_user_quotas" (
  "id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "active_quantity" INTEGER NOT NULL DEFAULT 0,
  "purchased_quantity" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flash_sale_user_quotas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flash_sale_user_quotas_campaign_user_key" UNIQUE ("campaign_id", "user_id"),
  CONSTRAINT "flash_sale_user_quotas_campaign_fk" FOREIGN KEY ("campaign_id") REFERENCES "flash_sale_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_user_quotas_user_fk" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_user_quotas_nonnegative_chk" CHECK ("active_quantity" >= 0 AND "purchased_quantity" >= 0 AND "version" >= 0)
);

CREATE TABLE "flash_sale_reservations" (
  "id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "status" "flash_sale_reservation_status" NOT NULL DEFAULT 'ACTIVE',
  "idempotency_key" VARCHAR(255) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flash_sale_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flash_sale_reservations_order_key" UNIQUE ("order_id"),
  CONSTRAINT "flash_sale_reservations_campaign_fk" FOREIGN KEY ("campaign_id") REFERENCES "flash_sale_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_reservations_user_fk" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_reservations_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "flash_sale_reservations_status_expiry_idx" ON "flash_sale_reservations"("status", "expires_at");
CREATE INDEX "flash_sale_reservations_campaign_created_idx" ON "flash_sale_reservations"("campaign_id", "created_at");

CREATE TABLE "flash_sale_reservation_items" (
  "id" TEXT NOT NULL,
  "reservation_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "product_name" VARCHAR(200) NOT NULL,
  "unit_price" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "flash_sale_reservation_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flash_sale_reservation_items_reservation_product_key" UNIQUE ("reservation_id", "product_id"),
  CONSTRAINT "flash_sale_reservation_items_reservation_fk" FOREIGN KEY ("reservation_id") REFERENCES "flash_sale_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_reservation_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "flash_sale_reservation_items_values_chk" CHECK ("unit_price" >= 0 AND "quantity" > 0)
);

CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "type" VARCHAR(100) NOT NULL,
  "aggregate_id" VARCHAR(200) NOT NULL,
  "payload" JSONB NOT NULL,
  "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMPTZ,
  "delivered_at" TIMESTAMPTZ,
  "last_error" VARCHAR(2000),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outbox_events_delivery_idx" ON "outbox_events"("delivered_at", "available_at");
CREATE INDEX "outbox_events_type_created_idx" ON "outbox_events"("type", "created_at");
