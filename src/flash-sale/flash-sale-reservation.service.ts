import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  AuditActorType,
  FlashSaleCampaignStatus,
  IdempotencyStatus,
  OrderStatus,
  Prisma,
  ProductStatus,
  ReservationStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { FlashSaleIdempotencyContext, FlashSaleItemRequest } from './flash-sale.types';
import { FlashSaleMetricsService } from './flash-sale.metrics';
import {
  campaignConfigKey,
  campaignExpiryKey,
  campaignQuotaKey,
  campaignProvisionalKey,
  campaignReadyKey,
  reservationKey,
  stockKey,
} from './flash-sale.keys';
import {
  FINALIZE_RESERVATION_LUA,
  RELEASE_RESERVATION_LUA,
  RESERVE_LUA,
} from './flash-sale.lua';

const HOLD_MS = 10 * 60 * 1000;
const PROVISIONAL_LEASE_MS = 90_000;
const REDIS_REPAIR_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ITEMS = 20;
const MAX_QUANTITY_PER_ITEM = 99;

interface DbCampaign {
  id: string;
  name: string;
  status: string;
  starts_at: Date;
  ends_at: Date;
  per_user_limit: number;
  db_now: Date;
}

interface DbStock {
  id: string;
  product_id: string;
  allocated: number;
  available: number;
  reserved: number;
  sold: number;
  version: number;
}

interface DbQuota {
  id: string;
  active_quantity: number;
  purchased_quantity: number;
}

function resultNumbers(result: unknown): number[] {
  if (!Array.isArray(result)) {
    throw new Error('Unexpected Redis Lua response');
  }
  return result.map(Number);
}

@Injectable()
export class FlashSaleReservationService {
  private readonly logger = new Logger(FlashSaleReservationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: FlashSaleMetricsService,
  ) {}

  async reserve(
    campaignId: string,
    userId: string,
    requestItems: FlashSaleItemRequest[],
    idempotency: FlashSaleIdempotencyContext,
    correlationId: string = randomUUID(),
  ) {
    const started = performance.now();
    let outcome = 'error';
    try {
      const response = await this.reserveInternal(
        campaignId,
        userId,
        requestItems,
        idempotency,
        correlationId,
      );
      outcome = 'accepted';
      return response;
    } catch (error) {
      if (error instanceof ConflictException) {
        outcome = error.message.includes('stock')
          ? 'sold_out_or_stock_conflict'
          : error.message.includes('quota')
            ? 'quota_rejected'
            : 'business_rejected';
      } else if (error instanceof ServiceUnavailableException) {
        outcome = 'unavailable';
      } else if (error instanceof BadRequestException) {
        outcome = 'invalid_request';
      }
      throw error;
    } finally {
      const durationMs = performance.now() - started;
      this.metrics.recordReservation(outcome, durationMs / 1000);
      this.logger.log(JSON.stringify({
        event: 'flash_sale_reservation_attempt',
        correlationId,
        campaignId,
        outcome,
        durationMs: Math.round(durationMs),
      }));
    }
  }

  private async reserveInternal(
    campaignId: string,
    userId: string,
    requestItems: FlashSaleItemRequest[],
    idempotency: FlashSaleIdempotencyContext,
    correlationId: string,
  ) {
    if (idempotency.userId !== userId) {
      throw new BadRequestException('Invalid idempotency context');
    }

    const items = this.normalizeItems(requestItems);
    const reservationId = randomUUID();
    const itemsJson = JSON.stringify(items);
    const redisReservationKey = reservationKey(campaignId, reservationId);
    const readyKey = campaignReadyKey(campaignId);
    const expiryKey = campaignExpiryKey(campaignId);
    const provisionalKey = campaignProvisionalKey(campaignId);
    const quotaKey = campaignQuotaKey(campaignId, userId);
    const configKey = campaignConfigKey(campaignId);
    const stockKeys = items.map((item) => stockKey(campaignId, item.productId));

    let admission: number[];
    const redisStarted = performance.now();
    try {
      admission = resultNumbers(
        await this.redis.evalScript(
          RESERVE_LUA,
          [readyKey, redisReservationKey, provisionalKey, quotaKey, configKey, ...stockKeys],
          [
            reservationId,
            userId,
            campaignId,
            HOLD_MS,
            PROVISIONAL_LEASE_MS,
            itemsJson,
          ],
        ),
      );
      this.metrics.recordRedisScript(
        'reserve',
        'ok',
        (performance.now() - redisStarted) / 1000,
      );
    } catch (error) {
      this.metrics.recordRedisScript(
        'reserve',
        'error',
        (performance.now() - redisStarted) / 1000,
      );
      this.logger.warn(`Redis admission failed for campaign ${campaignId}`);
      throw new ServiceUnavailableException(
        'Flash sale is temporarily unavailable; please retry',
      );
    }

    const admissionCode = admission[0];
    if (admissionCode !== 1) {
      if (admissionCode === 0) {
        throw new ConflictException('Insufficient flash-sale stock');
      }
      if (admissionCode === -3) {
        throw new ConflictException('Campaign purchase limit reached');
      }
      if (admissionCode === -5) {
        throw new BadRequestException('Invalid reservation items');
      }
      if (admissionCode === -1 || admissionCode === -4) {
        await this.markCampaignNotReady(
          campaignId,
          admissionCode === -4 ? 'missing Redis stock mirror' : 'campaign mirror not ready or incomplete',
        );
      }
      throw new ServiceUnavailableException(
        'Flash-sale inventory is not ready; please retry shortly',
      );
    }

    let committed: {
      response: {
        orderId: string;
        reservationId: string;
        status: 'PENDING_PAYMENT';
        expiresAt: string;
        currency: 'VND';
        totalAmount: string;
        items: Array<{
          productId: string;
          productName: string;
          quantity: number;
          unitPrice: number;
          lineTotal: string;
        }>;
      };
      expiresAt: Date;
    };

    const databaseStarted = performance.now();
    try {
      committed = await this.prisma.$transaction(
        async (tx) => {
          const campaignRows = await tx.$queryRaw<DbCampaign[]>`
            SELECT
              "id",
              "name",
              "status"::text AS "status",
              "starts_at",
              "ends_at",
              "per_user_limit",
              clock_timestamp() AS "db_now"
            FROM "flash_sale_campaigns"
            WHERE "id" = ${campaignId}
          `;
          const campaign = campaignRows[0];

          if (!campaign) {
            throw new NotFoundException('Flash-sale campaign not found');
          }

          const initialDbNow = campaign.db_now;
          if (
            campaign.status !== FlashSaleCampaignStatus.ACTIVE ||
            campaign.starts_at > initialDbNow ||
            campaign.ends_at <= initialDbNow
          ) {
            throw new ConflictException('Flash-sale campaign is not active');
          }

          // Lock stock rows one at a time in stable order to avoid lock-order deadlocks.
          for (const item of items) {
            const rows = await tx.$queryRaw<DbStock[]>`
              SELECT
                "id", "product_id", "allocated", "available", "reserved", "sold", "version"
              FROM "flash_sale_stocks"
              WHERE "campaign_id" = ${campaignId}
                AND "product_id" = ${item.productId}
              FOR UPDATE
            `;

            if (!rows[0]) {
              throw new ConflictException('Product is not part of this campaign');
            }
            if (rows[0].available < item.quantity) {
              throw new ConflictException('Insufficient flash-sale stock');
            }
          }

          const products = await tx.product.findMany({
            where: {
              id: { in: items.map((item) => item.productId) },
              status: ProductStatus.PUBLISHED,
              deletedAt: null,
              category: {
                is: { isActive: true, deletedAt: null },
              },
            },
            select: {
              id: true,
              name: true,
              price: true,
            },
          });
          const productById = new Map(products.map((product) => [product.id, product]));

          if (productById.size !== items.length) {
            throw new ConflictException('A product is unavailable');
          }

          const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
          const quotaId = randomUUID();
          await tx.$executeRaw`
            INSERT INTO "flash_sale_user_quotas"
              ("id", "campaign_id", "user_id", "active_quantity", "purchased_quantity", "version", "created_at", "updated_at")
            VALUES
              (${quotaId}, ${campaignId}, ${userId}, 0, 0, 0, clock_timestamp(), clock_timestamp())
            ON CONFLICT ("campaign_id", "user_id") DO NOTHING
          `;

          const quotaRows = await tx.$queryRaw<DbQuota[]>`
            SELECT "id", "active_quantity", "purchased_quantity"
            FROM "flash_sale_user_quotas"
            WHERE "campaign_id" = ${campaignId} AND "user_id" = ${userId}
            FOR UPDATE
          `;
          const quota = quotaRows[0];
          if (!quota) {
            throw new ConflictException('Could not lock campaign purchase quota');
          }
          if (
            quota.active_quantity + quota.purchased_quantity + totalQuantity >
            campaign.per_user_limit
          ) {
            throw new ConflictException('Campaign purchase limit reached');
          }

          const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`
            SELECT clock_timestamp() AS "now"
            FROM "flash_sale_campaigns"
            WHERE "id" = ${campaignId}
              AND "status" = 'ACTIVE'::flash_sale_campaign_status
              AND "starts_at" <= clock_timestamp()
              AND "ends_at" > clock_timestamp()
          `;
          const dbNow = clockRows[0]?.now;
          if (!dbNow) {
            throw new ConflictException('Flash-sale campaign is not active');
          }

          const orderItems = items.map((item) => {
            const product = productById.get(item.productId)!;
            if (!Number.isSafeInteger(product.price) || product.price < 0) {
              throw new ConflictException('Product has an invalid price');
            }
            return {
              productId: item.productId,
              productName: product.name,
              unitPrice: product.price,
              quantity: item.quantity,
              lineTotal: BigInt(product.price) * BigInt(item.quantity),
            };
          });

          const totalAmount = orderItems.reduce((sum, item) => sum + item.lineTotal, 0n);
          const expiresAt = new Date(dbNow.getTime() + HOLD_MS);

          const order = await tx.order.create({
            data: {
              userId,
              status: OrderStatus.PENDING_PAYMENT,
              currency: 'VND',
              totalAmount,
              correlationId,
              items: { create: orderItems },
            },
            select: { id: true, createdAt: true, correlationId: true },
          });

          await tx.reservation.create({
            data: {
              id: reservationId,
              campaignId,
              userId,
              orderId: order.id,
              status: ReservationStatus.ACTIVE,
              idempotencyKey: idempotency.key,
              requestHash: idempotency.requestHash,
              expiresAt,
              items: {
                create: orderItems.map((item) => ({
                  productId: item.productId,
                  productName: item.productName,
                  unitPrice: item.unitPrice,
                  quantity: item.quantity,
                })),
              },
            },
          });

          for (const item of items) {
            const updated = await tx.flashSaleStock.updateMany({
              where: {
                campaignId,
                productId: item.productId,
                available: { gte: item.quantity },
              },
              data: {
                available: { decrement: item.quantity },
                reserved: { increment: item.quantity },
                version: { increment: 1 },
              },
            });
            if (updated.count !== 1) {
              throw new ConflictException('Insufficient flash-sale stock');
            }
          }

          await tx.flashSaleUserQuota.update({
            where: { campaignId_userId: { campaignId, userId } },
            data: {
              activeQuantity: { increment: totalQuantity },
              version: { increment: 1 },
            },
          });

          const initialHistory = await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: null,
              toStatus: OrderStatus.PENDING_PAYMENT,
              actorId: userId,
              actorType: AuditActorType.USER,
              reason: `Flash-sale reservation ${reservationId} created`,
            },
            select: { id: true },
          });

          await tx.outboxEvent.create({
            data: {
              type: 'ORDER_STATUS_CHANGED',
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                historyId: initialHistory.id,
                correlationId,
                toStatus: OrderStatus.PENDING_PAYMENT,
              } as Prisma.InputJsonValue,
            },
          });

          await tx.outboxEvent.create({
            data: {
              type: 'FLASH_SALE_RESERVATION_EXPIRE',
              aggregateId: reservationId,
              payload: {
                reservationId,
                campaignId,
                orderId: order.id,
                correlationId,
                expiresAt: expiresAt.toISOString(),
              } as Prisma.InputJsonValue,
            },
          });

          const response = {
            orderId: order.id,
            reservationId,
            status: 'PENDING_PAYMENT' as const,
            expiresAt: expiresAt.toISOString(),
            currency: 'VND' as const,
            totalAmount: totalAmount.toString(),
            items: orderItems.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              lineTotal: item.lineTotal.toString(),
            })),
          };

          const saved = await tx.idempotencyRecord.updateMany({
            where: {
              id: idempotency.recordId,
              userId,
              scope: idempotency.scope,
              key: idempotency.key,
              requestHash: idempotency.requestHash,
              status: IdempotencyStatus.IN_PROGRESS,
            },
            data: {
              status: IdempotencyStatus.COMPLETED,
              responseStatus: 201,
              responseBody: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue,
            },
          });

          if (saved.count !== 1) {
            throw new ConflictException('Idempotency reservation is no longer valid');
          }

          return { response, expiresAt };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
      this.metrics.recordDatabaseTransaction(
        'reserve',
        'committed',
        (performance.now() - databaseStarted) / 1000,
      );
    } catch (error) {
      this.metrics.recordDatabaseTransaction(
        'reserve',
        'rolled_back',
        (performance.now() - databaseStarted) / 1000,
      );
      // PostgreSQL rejected the reservation: compensate Redis's provisional hold.
      try {
        const releaseKeys = [
          redisReservationKey,
          provisionalKey,
          expiryKey,
          quotaKey,
          ...stockKeys,
        ];
        const released = resultNumbers(
          await this.redis.evalScript(
            RELEASE_RESERVATION_LUA,
            releaseKeys,
            [reservationId, 'PROVISIONAL', 'RELEASED'],
          ),
        );
        if (released[0] !== 1) {
          await this.markCampaignNotReady(campaignId, 'provisional compensation drift');
        } else {
          // The DB rejected a hold that Redis admitted. Even after a successful
          // compensation, this means the two mirrors disagreed or business state
          // changed during admission. Stop writes until an operator reconciles.
          await this.markCampaignNotReady(
            campaignId,
            'PostgreSQL rolled back after Redis admission; reconciliation required',
          );
        }
      } catch {
        await this.markCampaignNotReady(campaignId, 'Redis compensation failed');
      }
      throw error;
    }

    // Do not fail an already-committed order merely because the Redis mirror
    // could not be finalized. Close writes for this campaign and reconcile.
    try {
      const finalized = resultNumbers(
        await this.redis.evalScript(
          FINALIZE_RESERVATION_LUA,
          [redisReservationKey, provisionalKey, expiryKey],
          [committed.expiresAt.getTime(), reservationId],
        ),
      );
      if (finalized[0] !== 1) {
        await this.markCampaignNotReady(campaignId, 'could not finalize Redis reservation');
      }
    } catch {
      await this.markCampaignNotReady(campaignId, 'Redis finalization failed after DB commit');
    }

    return committed.response;
  }

  private normalizeItems(requestItems: FlashSaleItemRequest[]): FlashSaleItemRequest[] {
    if (!Array.isArray(requestItems) || requestItems.length < 1 || requestItems.length > MAX_ITEMS) {
      throw new BadRequestException(`Provide 1–${MAX_ITEMS} unique products`);
    }

    const seen = new Set<string>();
    const items = requestItems.map((item) => {
      if (
        !item || typeof item.productId !== 'string' || !item.productId.trim() ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_ITEM
      ) {
        throw new BadRequestException('Invalid flash-sale item');
      }
      if (seen.has(item.productId)) {
        throw new BadRequestException('Duplicate product IDs are not allowed');
      }
      seen.add(item.productId);
      return { productId: item.productId, quantity: item.quantity };
    });

    return items.sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
  }

  private async markCampaignNotReady(campaignId: string, reason: string) {
    this.metrics.recordReconciliationFailure('campaign_not_ready');
    this.logger.error(`Flash-sale campaign ${campaignId} marked not-ready: ${reason}`);
    try {
      await this.redis.set(
        campaignReadyKey(campaignId),
        '0',
        REDIS_REPAIR_KEY_TTL_SECONDS,
      );
    } catch {
      // If Redis itself is unavailable, Lua admission already fails closed.
    }
  }
}
