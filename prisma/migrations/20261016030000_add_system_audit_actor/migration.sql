CREATE TYPE "AuditActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

ALTER TABLE "order_status_history"
    ALTER COLUMN "actor_id" DROP NOT NULL,
    ADD COLUMN "actor_type" "AuditActorType" NOT NULL DEFAULT 'USER';

ALTER TABLE "inventory_movements"
    ALTER COLUMN "actor_id" DROP NOT NULL,
    ADD COLUMN "actor_type" "AuditActorType" NOT NULL DEFAULT 'USER';

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
