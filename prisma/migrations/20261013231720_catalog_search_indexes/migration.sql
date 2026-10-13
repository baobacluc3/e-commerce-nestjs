-- DropIndex
DROP INDEX "Product_categoryId_status_deletedAt_idx";

-- DropIndex
DROP INDEX "Product_status_deletedAt_createdAt_idx";

-- CreateIndex
CREATE INDEX "product_status_deleted_created_id_idx" ON "Product"("status", "deletedAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "product_status_deleted_price_id_idx" ON "Product"("status", "deletedAt", "price", "id");

-- CreateIndex
CREATE INDEX "product_category_status_deleted_created_id_idx" ON "Product"("categoryId", "status", "deletedAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "product_category_status_deleted_price_id_idx" ON "Product"("categoryId", "status", "deletedAt", "price", "id");

CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CreateIndex
CREATE INDEX "product_name_trgm_idx" ON "Product" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "product_description_trgm_idx" ON "Product" USING GIN ("description" gin_trgm_ops);
