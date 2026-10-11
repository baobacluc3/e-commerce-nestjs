import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule'; 
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateReservationDto } from './dto/create-reservation.dto';

const RESERVATION_TTL_MS = 15 * 60_000;
type Tx = Prisma.TransactionClient;

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

@Injectable()
export class InventoryService {
  private readonly log = new Logger(InventoryService.name);
  constructor(private readonly prisma: PrismaService) {}

  // ---------- Products / stock ----------

  async createProduct(dto: CreateProductDto, actorId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            sku: dto.sku,
            name: dto.name,
            inventory: { create: { onHand: dto.initialStock } },
          },
        });
        if (dto.initialStock > 0) {
          await tx.stockMovement.create({
            data: { productId: product.id, type: 'INITIAL', delta: dto.initialStock, actorId },
          });
        }
        return { ...product, onHand: dto.initialStock, reserved: 0, available: dto.initialStock };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('SKU already exists');
      throw e;
    }
  }

  async getStock(sku: string) {
    const p = await this.prisma.product.findUnique({
      where: { sku },
      include: { inventory: true },
    });
    if (!p?.inventory) throw new NotFoundException('Product not found');
    const { onHand, reserved } = p.inventory;
    return { sku: p.sku, name: p.name, onHand, reserved, available: onHand - reserved };
  }

  async adjustStock(sku: string, dto: AdjustStockDto, actorId: string, idempotencyKey: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const product = await this.requireProduct(tx, sku);
        // Ledger insert first: a replayed key aborts here, before touching stock.
        await tx.stockMovement.create({
          data: {
            productId: product.id, type: 'ADJUSTMENT', delta: dto.delta,
            reason: dto.reason, actorId, idempotencyKey,
          },
        });
        // Atomic guard: cannot go below reserved (which also implies >= 0).
        const n = await tx.$executeRaw`
          UPDATE "InventoryItem"
          SET "onHand" = "onHand" + ${dto.delta}, "updatedAt" = now()
          WHERE "productId" = ${product.id}
            AND "onHand" + ${dto.delta} >= "reserved"`;
        if (n === 0) throw new ConflictException('Adjustment would drop stock below reserved quantity');
      });
    } catch (e) {
      // Same key replayed: the first call already applied it.
      if (!isUniqueViolation(e)) throw e;
    }
    return this.getStock(sku);
  }

  // ---------- Reservations ----------

  async reserve(userId: string, idempotencyKey: string, dto: CreateReservationDto) {
    // Merge duplicate SKUs; sort for a deterministic lock order (deadlock avoidance).
    const merged = new Map<string, number>();
    for (const i of dto.items) merged.set(i.sku, (merged.get(i.sku) ?? 0) + i.quantity);
    const items = [...merged].sort(([a], [b]) => (a < b ? -1 : 1));

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const products = await tx.product.findMany({
          where: { sku: { in: items.map(([s]) => s) } },
          select: { id: true, sku: true },
        });
        const idBySku = new Map(products.map((p) => [p.sku, p.id]));
        const missing = items.filter(([s]) => !idBySku.has(s)).map(([s]) => s);
        if (missing.length) throw new NotFoundException(`Unknown SKU(s): ${missing.join(', ')}`);

        // Insert first: a retried key violates the unique index before stock is touched.
        const reservation = await tx.reservation.create({
          data: {
            userId, idempotencyKey,
            expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
            items: {
              create: items.map(([sku, quantity]) => ({ productId: idBySku.get(sku)!, quantity })),
            },
          },
        });

        for (const [sku, qty] of items) {
          const n = await tx.$executeRaw`
            UPDATE "InventoryItem"
            SET "reserved" = "reserved" + ${qty}, "updatedAt" = now()
            WHERE "productId" = ${idBySku.get(sku)!}
              AND "onHand" - "reserved" >= ${qty}`;
          if (n === 0) throw new ConflictException(`Insufficient stock for ${sku}`); // rolls back all
        }
        return reservation.id;
      });
      return this.getReservation(userId, id);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = await this.prisma.reservation.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
        if (existing) return this.getReservation(userId, existing.id);
      }
      throw e;
    }
  }

  async release(userId: string, reservationId: string) {
    return this.finish(userId, reservationId, 'RELEASED');
  }

  async commit(userId: string, reservationId: string) {
    return this.finish(userId, reservationId, 'COMMITTED');
  }

  private async finish(userId: string, reservationId: string, target: 'RELEASED' | 'COMMITTED') {
    await this.prisma.$transaction(async (tx) => {
      // Single-winner transition. Commit additionally requires the hold not to have expired.
      const claimed = await tx.reservation.updateMany({
        where: {
          id: reservationId, userId, status: 'ACTIVE',
          ...(target === 'COMMITTED' ? { expiresAt: { gt: new Date() } } : {}),
        },
        data: { status: target },
      });

      if (claimed.count === 0) {
        const r = await tx.reservation.findFirst({ where: { id: reservationId, userId } });
        if (!r) throw new NotFoundException('Reservation not found');
        if (r.status === target) return; // idempotent repeat
        throw new ConflictException(`Reservation is ${r.status.toLowerCase()}`);
      }

      const items = await tx.reservationItem.findMany({
        where: { reservationId }, orderBy: { productId: 'asc' }, // consistent lock order
      });
      for (const { productId, quantity } of items) {
        if (target === 'RELEASED') {
          await tx.$executeRaw`
            UPDATE "InventoryItem" SET "reserved" = "reserved" - ${quantity}, "updatedAt" = now()
            WHERE "productId" = ${productId}`;
        } else {
          await tx.$executeRaw`
            UPDATE "InventoryItem"
            SET "reserved" = "reserved" - ${quantity}, "onHand" = "onHand" - ${quantity}, "updatedAt" = now()
            WHERE "productId" = ${productId}`;
          await tx.stockMovement.create({
            data: {
              productId, type: 'COMMIT', delta: -quantity,
              reason: `reservation:${reservationId}`, actorId: userId,
            },
          });
        }
      }
    });
    return this.getReservation(userId, reservationId);
  }

  async getReservation(userId: string, id: string) {
    const r = await this.prisma.reservation.findFirst({
      where: { id, userId },
      include: { items: true },
    });
    if (!r) throw new NotFoundException('Reservation not found');
    return r;
  }

  // ---------- Expiry sweeper ----------

  @Interval(60_000)
  async expireStale(batch = 100) {
    try {
      const ids = await this.prisma.$transaction(async (tx) => {
        // SKIP LOCKED: multiple app instances can sweep without blocking each other.
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Reservation"
          WHERE status = 'ACTIVE' AND "expiresAt" <= now()
          ORDER BY "expiresAt" LIMIT ${batch}
          FOR UPDATE SKIP LOCKED`;
        for (const { id } of rows) {
          await tx.reservation.update({ where: { id }, data: { status: 'EXPIRED' } });
          const items = await tx.reservationItem.findMany({
            where: { reservationId: id }, orderBy: { productId: 'asc' },
          });
          for (const { productId, quantity } of items) {
            await tx.$executeRaw`
              UPDATE "InventoryItem" SET "reserved" = "reserved" - ${quantity}, "updatedAt" = now()
              WHERE "productId" = ${productId}`;
          }
        }
        return rows.map((r) => r.id);
      });
      if (ids.length) this.log.log(`Expired ${ids.length} reservations`);
    } catch (e) {
      this.log.error('Expiry sweep failed', e as Error);
    }
  }

  private async requireProduct(tx: Tx, sku: string) {
    const p = await tx.product.findUnique({ where: { sku }, select: { id: true } });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }
}