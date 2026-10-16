import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ReservationStatus } from '../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { FlashSaleMetricsService } from './flash-sale.metrics';
import {
  campaignConfigKey,
  campaignExpiryKey,
  campaignProvisionalKey,
  campaignQuotaKey,
  campaignReadyKey,
  reservationKey,
  stockKey,
} from './flash-sale.keys';
import {
  CONFIRM_RESERVATION_LUA,
  FINALIZE_RESERVATION_LUA,
  GET_RESERVATION_MIRROR_LUA,
  LIST_DUE_PROVISIONALS_LUA,
  REBUILD_CAMPAIGN_MIRROR_LUA,
  RELEASE_RESERVATION_LUA,
} from './flash-sale.lua';

interface MirrorStock {
  productId: string;
  allocated: number;
  available: number;
  reserved: number;
  sold: number;
  version: number;
}

@Injectable()
export class FlashSaleRedisMirrorService {
  private readonly logger = new Logger(FlashSaleRedisMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: FlashSaleMetricsService,
  ) {}

  /**
   * Maintenance operation, not a public HTTP endpoint.
   * Before calling, pause the campaign and all workers/webhooks that mutate
   * its reservation/stock state. This prevents the PostgreSQL snapshot from
   * becoming stale while Redis is rebuilt.
   */
  async rebuildPausedCampaign(campaignId: string) {
    const readyKey = campaignReadyKey(campaignId);

    const statusCheck = await this.prisma.flashSaleCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!statusCheck) {
      throw new NotFoundException('Flash-sale campaign not found');
    }
    if (statusCheck.status === 'ACTIVE') {
      throw new ConflictException(
        'Pause the campaign before rebuilding its Redis mirror',
      );
    }

    // Fail closed only after confirming this is a paused/non-active campaign.
    // Re-read the snapshot after closing the gate.
    await this.redis.set(readyKey, '0', 30 * 24 * 60 * 60);

    const campaign = await this.prisma.flashSaleCampaign.findUnique({
      where: { id: campaignId },
      include: {
        stocks: true,
        quotas: {
          where: {
            OR: [
              { activeQuantity: { gt: 0 } },
              { purchasedQuantity: { gt: 0 } },
            ],
          },
        },
        reservations: {
          where: { status: 'ACTIVE' },
          include: { items: true },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException('Flash-sale campaign not found');
    }
    if (campaign.status === 'ACTIVE') {
      throw new ConflictException(
        'Pause the campaign before rebuilding its Redis mirror',
      );
    }

    const stocks: MirrorStock[] = campaign.stocks.map((stock) => ({
      productId: stock.productId,
      allocated: stock.allocated,
      available: stock.available,
      reserved: stock.reserved,
      sold: stock.sold,
      version: stock.version,
    }));

    const quotas = campaign.quotas.map((quota) => ({
      userId: quota.userId,
      activeQuantity: quota.activeQuantity,
      purchasedQuantity: quota.purchasedQuantity,
    }));

    const reservations = campaign.reservations.map((reservation) => {
      const items = reservation.items
        .map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        }))
        .sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);

      return {
        id: reservation.id,
        userId: reservation.userId,
        status: reservation.status,
        items,
        quantity: items.reduce((sum, item) => sum + item.quantity, 0),
        expiresAtMs: reservation.expiresAt.getTime(),
      };
    });

    // scanKeys must use Redis SCAN, not KEYS, so it doesn't block Redis.
    const existingKeys = await this.redis.scanKeys(`fs:{${campaignId}}:*`);
    const keys = [
      readyKey,
      ...existingKeys.filter((key) => key !== readyKey),
    ];

    const response = await this.redis.evalScript(
      REBUILD_CAMPAIGN_MIRROR_LUA,
      keys,
      [
        campaignId,
        campaign.perUserLimit,
        JSON.stringify(stocks),
        JSON.stringify(quotas),
        JSON.stringify(reservations),
      ],
    );

    this.logger.warn(
      `Rebuilt flash-sale Redis mirror for ${campaignId}; ` +
      `stocks=${stocks.length} quotas=${quotas.length} activeReservations=${reservations.length}. ` +
      'The Redis write gate remains closed until the campaign is explicitly re-activated.',
    );

    return response;
  }


  /**
   * Repairs the crash window between Redis provisional admission and the
   * Postgres commit/finalize steps. Only ACTIVE campaigns are scanned here;
   * paused campaigns are rebuilt explicitly by an operator.
   */
  @Interval(10_000)
  async reconcileDueProvisionals() {
    let campaigns: Array<{ id: string }>;
    try {
      campaigns = await this.prisma.flashSaleCampaign.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });
    } catch (error) {
      this.logger.warn(`Could not list active flash-sale campaigns: ${error instanceof Error ? error.message : 'unknown error'}`);
      return;
    }

    for (const campaign of campaigns) {
      let ids: string[];
      try {
        const result = await this.redis.evalScript(
          LIST_DUE_PROVISIONALS_LUA,
          [campaignProvisionalKey(campaign.id)],
          [campaign.id],
        );
        if (!Array.isArray(result)) continue;
        ids = result.map(String);
      } catch (error) {
        this.logger.warn(`Could not inspect provisional reservations for ${campaign.id}`);
        continue;
      }

      for (const id of ids) {
        try {
          await this.reconcileOneProvisional(campaign.id, id);
        } catch (error) {
          this.logger.error(
            `Failed to reconcile provisional reservation ${id}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
          try {
            await this.closeWriteGate(campaign.id, `provisional reconciliation failed for ${id}`);
          } catch {
            // Redis outage is already fail-closed at admission.
          }
        }
      }
    }
  }

  private async reconcileOneProvisional(campaignId: string, id: string) {
    const redisReservationKey = reservationKey(campaignId, id);
    const mirrorRaw = await this.redis.evalScript(
      GET_RESERVATION_MIRROR_LUA,
      [redisReservationKey],
      [],
    );
    if (typeof mirrorRaw !== 'string') {
      await this.closeWriteGate(campaignId, `invalid Redis reservation mirror ${id}`);
      return;
    }

    const mirrorData = JSON.parse(mirrorRaw) as {
      status?: string;
      userId?: string;
      items?: string;
    };
    if (mirrorData.status !== 'PROVISIONAL' || !mirrorData.userId || !mirrorData.items) {
      return; // another repair/transition already changed the key
    }

    const databaseReservation = await this.prisma.reservation.findUnique({
      where: { id },
      select: {
        id: true,
        campaignId: true,
        userId: true,
        status: true,
        expiresAt: true,
        items: { select: { productId: true, quantity: true } },
      },
    });

    const redisItems = JSON.parse(mirrorData.items) as Array<{
      productId: string;
      quantity: number;
    }>;
    const items = (databaseReservation?.items ?? redisItems)
      .map((item) => ({ productId: item.productId, quantity: item.quantity }))
      .sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);

    const expiryKey = campaignExpiryKey(campaignId);
    const provisionalKey = campaignProvisionalKey(campaignId);
    const quotaKey = campaignQuotaKey(campaignId, mirrorData.userId);
    const stockKeys = items.map((item) => stockKey(campaignId, item.productId));

    if (!databaseReservation) {
      // Redis admitted a provisional hold, but no DB transaction committed.
      const released = await this.redis.evalScript(
        RELEASE_RESERVATION_LUA,
        [redisReservationKey, provisionalKey, expiryKey, quotaKey, ...stockKeys],
        [id, 'PROVISIONAL', 'RELEASED'],
      );
      if (!Array.isArray(released) || Number(released[0]) !== 1) {
        await this.closeWriteGate(campaignId, `could not release orphan provisional ${id}`);
      }
      return;
    }

    if (databaseReservation.status === ReservationStatus.ACTIVE) {
      const finalized = await this.redis.evalScript(
        FINALIZE_RESERVATION_LUA,
        [redisReservationKey, provisionalKey, expiryKey],
        [databaseReservation.expiresAt.getTime(), id],
      );
      if (!Array.isArray(finalized) || Number(finalized[0]) !== 1) {
        await this.closeWriteGate(campaignId, `could not finalize committed reservation ${id}`);
      }
      return;
    }

    if (databaseReservation.status === ReservationStatus.CONFIRMED) {
      const finalized = await this.redis.evalScript(
        FINALIZE_RESERVATION_LUA,
        [redisReservationKey, provisionalKey, expiryKey],
        [databaseReservation.expiresAt.getTime(), id],
      );
      if (!Array.isArray(finalized) || Number(finalized[0]) !== 1) {
        await this.closeWriteGate(campaignId, `could not finalize confirmed reservation ${id}`);
        return;
      }
      const confirmed = await this.redis.evalScript(
        CONFIRM_RESERVATION_LUA,
        [redisReservationKey, provisionalKey, expiryKey, quotaKey, ...stockKeys],
        [id],
      );
      if (!Array.isArray(confirmed) || Number(confirmed[0]) !== 1) {
        await this.closeWriteGate(campaignId, `could not mirror confirmation ${id}`);
      }
      return;
    }

    if (
      databaseReservation.status === ReservationStatus.EXPIRED ||
      databaseReservation.status === ReservationStatus.RELEASED
    ) {
      const target = databaseReservation.status;
      const released = await this.redis.evalScript(
        RELEASE_RESERVATION_LUA,
        [redisReservationKey, provisionalKey, expiryKey, quotaKey, ...stockKeys],
        [id, 'PROVISIONAL', target],
      );
      if (!Array.isArray(released) || Number(released[0]) !== 1) {
        await this.closeWriteGate(campaignId, `could not mirror terminal reservation ${id}`);
      }
      return;
    }

    await this.closeWriteGate(campaignId, `unsupported reservation status ${databaseReservation.status}`);
  }

  async openCampaignWrites(campaignId: string) {
    // Close the gate before verification. A request that acquired a provisional
    // hold before the close remains visible in this ZSET and prevents reopening.
    await this.redis.set(campaignReadyKey(campaignId), '0', 30 * 24 * 60 * 60);
    const provisionalCount = await this.redis.zcard(campaignProvisionalKey(campaignId));
    if (provisionalCount > 0) {
      this.metrics.recordReconciliationFailure('provisional_holds_pending');
      throw new ConflictException(
        'Cannot open campaign while provisional Redis holds remain; reconcile or rebuild first',
      );
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "flash_sale_campaigns"
      WHERE "id" = ${campaignId}
        AND "status" = 'ACTIVE'::flash_sale_campaign_status
        AND "starts_at" <= clock_timestamp()
        AND "ends_at" > clock_timestamp()
    `;
    if (rows.length !== 1) {
      throw new ConflictException('Campaign must be active and within its scheduled window');
    }

    const stocks = await this.prisma.flashSaleStock.findMany({
      where: { campaignId },
      select: {
        productId: true,
        allocated: true,
        available: true,
        reserved: true,
        sold: true,
        version: true,
      },
    });
    for (const stock of stocks) {
      if (
        stock.allocated < 0 || stock.available < 0 || stock.reserved < 0 || stock.sold < 0 ||
        stock.available + stock.reserved + stock.sold !== stock.allocated
      ) {
        throw new ConflictException('Campaign stock invariant failed');
      }
    }

    const stockLedgerMismatch = await this.prisma.$queryRaw<Array<{ product_id: string }>>`
      SELECT s."product_id"
      FROM "flash_sale_stocks" s
      LEFT JOIN (
        SELECT ri."product_id",
          SUM(ri."quantity") FILTER (WHERE r."status" = 'ACTIVE'::flash_sale_reservation_status) AS active_qty,
          SUM(ri."quantity") FILTER (WHERE r."status" = 'CONFIRMED'::flash_sale_reservation_status) AS confirmed_qty
        FROM "flash_sale_reservations" r
        JOIN "flash_sale_reservation_items" ri ON ri."reservation_id" = r."id"
        WHERE r."campaign_id" = ${campaignId}
        GROUP BY ri."product_id"
      ) ledger ON ledger."product_id" = s."product_id"
      WHERE s."campaign_id" = ${campaignId}
        AND (
          s."reserved" <> COALESCE(ledger.active_qty, 0)
          OR s."sold" <> COALESCE(ledger.confirmed_qty, 0)
        )
      LIMIT 20
    `;
    if (stockLedgerMismatch.length > 0) {
      this.metrics.recordReconciliationFailure('stock_ledger_mismatch');
      throw new ConflictException(
        'Campaign reservation ledger does not match reserved/sold stock counters',
      );
    }

    const quotaMismatch = await this.prisma.$queryRaw<Array<{ user_id: string }>>`
      WITH ledger AS (
        SELECT r."user_id",
          SUM(ri."quantity") FILTER (WHERE r."status" = 'ACTIVE'::flash_sale_reservation_status) AS active_qty,
          SUM(ri."quantity") FILTER (WHERE r."status" = 'CONFIRMED'::flash_sale_reservation_status) AS purchased_qty
        FROM "flash_sale_reservations" r
        JOIN "flash_sale_reservation_items" ri ON ri."reservation_id" = r."id"
        WHERE r."campaign_id" = ${campaignId}
        GROUP BY r."user_id"
      ), mismatches AS (
        SELECT q."user_id"
        FROM "flash_sale_user_quotas" q
        LEFT JOIN ledger l ON l."user_id" = q."user_id"
        WHERE q."campaign_id" = ${campaignId}
          AND (
            q."active_quantity" <> COALESCE(l.active_qty, 0)
            OR q."purchased_quantity" <> COALESCE(l.purchased_qty, 0)
            OR q."active_quantity" + q."purchased_quantity" > (
              SELECT c."per_user_limit" FROM "flash_sale_campaigns" c WHERE c."id" = ${campaignId}
            )
          )
        UNION
        SELECT l."user_id"
        FROM ledger l
        LEFT JOIN "flash_sale_user_quotas" q
          ON q."campaign_id" = ${campaignId} AND q."user_id" = l."user_id"
        WHERE q."id" IS NULL
      )
      SELECT "user_id" FROM mismatches LIMIT 20
    `;
    if (quotaMismatch.length > 0) {
      this.metrics.recordReconciliationFailure('quota_ledger_mismatch');
      throw new ConflictException(
        'Campaign purchase quota ledger does not match reservation state',
      );
    }

    // Never open the admission gate merely because PostgreSQL is consistent.
    // Verify Redis actually matches the authoritative stock/quota/reservation
    // snapshot as well; otherwise a missing quota key could bypass user limits.
    const config = await this.redis.hmget(
      campaignConfigKey(campaignId),
      'perUserLimit',
    );
    if (Number(config[0]) !== (await this.prisma.flashSaleCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { perUserLimit: true },
    })).perUserLimit) {
      this.metrics.recordReconciliationFailure('redis_config_mismatch');
      throw new ConflictException('Redis campaign config does not match PostgreSQL');
    }

    for (const stock of stocks) {
      const mirror = await this.redis.hmget(
        stockKey(campaignId, stock.productId),
        'allocated', 'available', 'reserved', 'sold', 'version',
      );
      const expected = [stock.allocated, stock.available, stock.reserved, stock.sold, stock.version];
      if (mirror.some((value) => value === null) ||
          mirror.some((value, index) => Number(value) !== expected[index])) {
        this.metrics.recordReconciliationFailure('redis_stock_mismatch');
        throw new ConflictException(`Redis stock mirror mismatch for product ${stock.productId}`);
      }
    }

    const nonzeroQuotas = await this.prisma.flashSaleUserQuota.findMany({
      where: {
        campaignId,
        OR: [
          { activeQuantity: { gt: 0 } },
          { purchasedQuantity: { gt: 0 } },
        ],
      },
      select: { userId: true, activeQuantity: true, purchasedQuantity: true },
    });
    for (const quota of nonzeroQuotas) {
      const mirror = await this.redis.hmget(
        campaignQuotaKey(campaignId, quota.userId),
        'activeQuantity', 'purchasedQuantity',
      );
      if (
        mirror[0] === null || mirror[1] === null ||
        Number(mirror[0]) !== quota.activeQuantity ||
        Number(mirror[1]) !== quota.purchasedQuantity
      ) {
        this.metrics.recordReconciliationFailure('redis_quota_mismatch');
        throw new ConflictException(`Redis user quota mirror mismatch for user ${quota.userId}`);
      }
    }

    const activeReservations = await this.prisma.reservation.findMany({
      where: { campaignId, status: ReservationStatus.ACTIVE },
      select: {
        id: true,
        campaignId: true,
        userId: true,
        expiresAt: true,
        items: { select: { productId: true, quantity: true } },
      },
    });
    for (const reservation of activeReservations) {
      const result = await this.redis.evalScript(
        GET_RESERVATION_MIRROR_LUA,
        [reservationKey(campaignId, reservation.id)],
        [],
      );
      if (typeof result !== 'string') {
        this.metrics.recordReconciliationFailure('redis_reservation_mismatch');
        throw new ConflictException(`Redis reservation mirror missing for ${reservation.id}`);
      }
      const mirror = JSON.parse(result) as {
        status?: string | null;
        userId?: string | null;
        campaignId?: string | null;
        items?: string | null;
        expiresAtMs?: string | null;
        expiryScore?: string | null;
      };
      const expectedItems = reservation.items
        .map((item) => ({ productId: item.productId, quantity: item.quantity }))
        .sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
      let mirroredItems: Array<{ productId: string; quantity: number }> = [];
      try {
        const parsedItems = JSON.parse(mirror.items ?? '[]') as Array<{ productId: string; quantity: number }>;
        mirroredItems = parsedItems
          .map((item) => ({ productId: String(item.productId), quantity: Number(item.quantity) }))
          .sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
      } catch {
        // Handled by the mismatch comparison below.
      }
      if (
        mirror.status !== 'ACTIVE' ||
        mirror.userId !== reservation.userId ||
        mirror.campaignId !== reservation.campaignId ||
        Number(mirror.expiresAtMs) !== reservation.expiresAt.getTime() ||
        Number(mirror.expiryScore) !== reservation.expiresAt.getTime() ||
        JSON.stringify(mirroredItems) !== JSON.stringify(expectedItems)
      ) {
        this.metrics.recordReconciliationFailure('redis_reservation_mismatch');
        throw new ConflictException(`Redis reservation mirror mismatch for ${reservation.id}`);
      }
    }

    await this.redis.set(
      campaignReadyKey(campaignId),
      '1',
      30 * 24 * 60 * 60,
    );
    return { ready: true, campaignId, stocks: stocks.length };
  }

  /** Best-effort guard used after compensation/mirror-update failures. */
  async closeWriteGate(campaignId: string, reason: string) {
    this.metrics.recordReconciliationFailure('write_gate_closed');
    this.logger.error(`Closing flash-sale write gate ${campaignId}: ${reason}`);
    await this.redis.set(
      campaignReadyKey(campaignId),
      '0',
      30 * 24 * 60 * 60,
    );
  }
}
