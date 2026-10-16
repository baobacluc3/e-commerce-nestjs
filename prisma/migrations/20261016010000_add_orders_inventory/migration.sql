CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CANCELLED');
CREATE TYPE "InventoryMovementType" AS ENUM ('STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT');

CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "total_amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "orders_total_nonnegative_chk" CHECK ("total_amount" >= 0)
);

CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total" BIGINT NOT NULL,
    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_items_quantity_positive_chk" CHECK ("quantity" > 0),
    CONSTRAINT "order_items_price_nonnegative_chk" CHECK ("unit_price" >= 0),
    CONSTRAINT "order_items_line_total_matches_chk" CHECK ("line_total" = ("unit_price"::bigint * "quantity"::bigint))
);

CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inventory_quantity_nonnegative_chk" CHECK ("quantity" >= 0)
);

CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "inventory_id" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity_delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_product_id_key" ON "inventory"("product_id");
CREATE INDEX "orders_userId_created_at_id_idx" ON "orders"("userId", "created_at", "id");
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");
CREATE INDEX "inventory_movements_inventory_id_created_at_idx" ON "inventory_movements"("inventory_id", "created_at");
CREATE INDEX "inventory_movements_actor_id_idx" ON "inventory_movements"("actor_id");

ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
