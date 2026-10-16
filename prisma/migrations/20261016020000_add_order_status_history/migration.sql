ALTER TYPE "OrderStatus" RENAME VALUE 'PENDING' TO 'PENDING_PAYMENT';
ALTER TYPE "OrderStatus" ADD VALUE 'PAID';
ALTER TYPE "OrderStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "OrderStatus" ADD VALUE 'SHIPPING';
ALTER TYPE "OrderStatus" ADD VALUE 'COMPLETED';

ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';

CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history"("order_id", "created_at");
CREATE INDEX "order_status_history_actor_id_created_at_idx" ON "order_status_history"("actor_id", "created_at");

ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
