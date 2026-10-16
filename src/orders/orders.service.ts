import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  InventoryMovementType,
  AuditActorType,
  IdempotencyStatus,
  OrderStatus,
  Prisma,
  ProductStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStateMachine } from './order-state-machine';
import { OrderQueuesService } from './order-queues.service';
import { PAYMENT_TIMEOUT_MS } from './order-queues.constants';
import { IdempotencyContext } from '../idempotency/idempotency.types';

type LockedInventory = { id: string; quantity: number; version: number };
type OrderResponseSource = {
  id: string;
  status: OrderStatus;
  currency: string;
  totalAmount: bigint;
  createdAt: Date;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    lineTotal: bigint;
  }>;
};

const MAX_BIGINT = 9_223_372_036_854_775_807n;

@Injectable()
export class OrdersService {
  private readonly stateMachine = new OrderStateMachine();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderQueues: OrderQueuesService,
  ) {}

  async createFromCart(userId: string, idempotency: IdempotencyContext) {
    const committed = await this.prisma.$transaction(
      async (tx) => {
        const cartLocks = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "carts" WHERE "userId" = ${userId} FOR UPDATE
        `;
        if (cartLocks.length === 0)
          throw new BadRequestException('Your cart is empty');

        const cart = await tx.cart.findUnique({
          where: { userId },
          select: {
            id: true,
            items: { select: { productId: true, quantity: true } },
          },
        });
        if (!cart || cart.items.length === 0)
          throw new BadRequestException('Your cart is empty');

        const items = [...cart.items].sort((a, b) =>
          a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
        );

        for (const item of items) {
          await tx.$executeRaw`
            INSERT INTO "inventory" ("id", "product_id", "quantity", "version", "created_at", "updated_at")
            VALUES (${randomUUID()}, ${item.productId}, 0, 0, NOW(), NOW())
            ON CONFLICT ("product_id") DO NOTHING
          `;
        }

        const inventoryByProduct = new Map<string, LockedInventory>();
        for (const item of items) {
          const rows = await tx.$queryRaw<LockedInventory[]>`
            SELECT "id", "quantity", "version" FROM "inventory"
            WHERE "product_id" = ${item.productId} FOR UPDATE
          `;
          if (!rows[0]) throw new NotFoundException('Inventory not found');
          inventoryByProduct.set(item.productId, rows[0]);
        }

        const products = await tx.product.findMany({
          where: { id: { in: items.map((item) => item.productId) } },
          select: {
            id: true,
            name: true,
            price: true,
            status: true,
            deletedAt: true,
            category: { select: { isActive: true, deletedAt: true } },
          },
        });
        const productById = new Map(
          products.map((product) => [product.id, product]),
        );

        for (const item of items) {
          const product = productById.get(item.productId);
          const inventory = inventoryByProduct.get(item.productId);
          if (
            !product ||
            product.status !== ProductStatus.PUBLISHED ||
            product.deletedAt !== null ||
            !product.category.isActive ||
            product.category.deletedAt !== null
          )
            throw new ConflictException(
              'A product in your cart is unavailable',
            );
          if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
            throw new BadRequestException('Invalid cart quantity');
          }
          if (product.price < 0)
            throw new BadRequestException('Invalid product price');
          if (!inventory || inventory.quantity < item.quantity) {
            throw new ConflictException(
              `Insufficient stock for ${product.name}`,
            );
          }
        }

        const orderItems = items.map((item) => {
          const product = productById.get(item.productId)!;
          return {
            productId: product.id,
            productName: product.name,
            unitPrice: product.price,
            quantity: item.quantity,
            lineTotal: BigInt(product.price) * BigInt(item.quantity),
          };
        });
        const totalAmount = orderItems.reduce(
          (sum, item) => sum + item.lineTotal,
          0n,
        );
        if (totalAmount > MAX_BIGINT)
          throw new BadRequestException(
            'Order total exceeds the supported limit',
          );

        const order = await tx.order.create({
          data: {
            userId,
            status: OrderStatus.PENDING_PAYMENT,
            currency: 'VND',
            totalAmount,
            items: { create: orderItems },
          },
          select: {
            id: true,
            status: true,
            currency: true,
            totalAmount: true,
            createdAt: true,
            items: {
              select: {
                id: true,
                productId: true,
                productName: true,
                unitPrice: true,
                quantity: true,
                lineTotal: true,
              },
            },
          },
        });

        const initialHistory = await tx.orderStatusHistory.create({
          data: {
            orderId: order.id,
            fromStatus: null,
            toStatus: OrderStatus.PENDING_PAYMENT,
            actorId: userId,
            actorType: AuditActorType.USER,
            reason: 'Order created from cart',
          },
          select: { id: true },
        });

        for (const item of items) {
          const inventory = inventoryByProduct.get(item.productId)!;
          const updated = await tx.inventory.updateMany({
            where: {
              productId: item.productId,
              quantity: { gte: item.quantity },
            },
            data: {
              quantity: { decrement: item.quantity },
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1)
            throw new ConflictException(
              'Insufficient stock; please retry checkout',
            );
          await tx.inventoryMovement.create({
            data: {
              inventoryId: inventory.id,
              type: InventoryMovementType.STOCK_OUT,
              quantityDelta: -item.quantity,
              reason: `Order ${order.id}`,
              actorId: userId,
              actorType: AuditActorType.USER,
            },
          });
        }

        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        const response = this.serializeOrder(order);
        const responseBody = JSON.parse(
          JSON.stringify(response),
        ) as Prisma.InputJsonValue;
        const completed = await tx.idempotencyRecord.updateMany({
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
            responseBody,
          },
        });
        if (completed.count !== 1) {
          throw new ConflictException(
            'Idempotency reservation is no longer valid',
          );
        }
        return { order, initialHistoryId: initialHistory.id, response };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    await this.orderQueues.scheduleExpiration(
      committed.order.id,
      committed.order.createdAt,
    );
    await this.orderQueues.notifyStatusChange(committed.initialHistoryId);
    return committed.response;
  }

  async findMyOrders(userId: string, page: number, limit: number) {
    const where = { userId };
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          currency: true,
          totalAmount: true,
          createdAt: true,
          items: {
            select: {
              id: true,
              productId: true,
              productName: true,
              unitPrice: true,
              quantity: true,
              lineTotal: true,
            },
          },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      data: orders.map((order) => this.serializeOrder(order)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async cancelMyOrder(
    orderId: string,
    userId: string,
    reason = 'Customer requested cancellation',
  ) {
    return this.changeStatus(
      orderId,
      OrderStatus.CANCELLED,
      userId,
      AuditActorType.USER,
      reason,
      {
        ownerId: userId,
        customerCancellation: true,
      },
    );
  }

  async expirePendingOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, createdAt: true },
    });
    if (!order || order.status !== OrderStatus.PENDING_PAYMENT) {
      return { kind: 'skipped' as const };
    }

    const expiresAt = order.createdAt.getTime() + PAYMENT_TIMEOUT_MS;
    if (Date.now() < expiresAt) return { kind: 'not-due' as const, expiresAt };

    const result = await this.changeStatus(
      orderId,
      OrderStatus.CANCELLED,
      null,
      AuditActorType.SYSTEM,
      'Automatically cancelled after 30 minutes without payment',
      { skipIfNoLongerPending: true },
    );
    if (!result) return { kind: 'skipped' as const };
    return { kind: 'expired' as const };
  }

  private async changeStatus(
    orderId: string,
    nextStatus: OrderStatus,
    actorId: string | null,
    actorType: AuditActorType,
    reason: string,
    options: {
      ownerId?: string;
      customerCancellation?: boolean;
      skipIfNoLongerPending?: boolean;
    } = {},
  ) {
    const cleanReason = reason.trim();
    if (!cleanReason || cleanReason.length > 500) {
      throw new ConflictException('A valid reason is required');
    }

    const committed = await this.prisma.$transaction(
      async (tx) => {
        const rows = options.ownerId
          ? await tx.$queryRaw<
              Array<{ id: string; userId: string; status: OrderStatus }>
            >`
              SELECT "id", "userId", "status" FROM "orders"
              WHERE "id" = ${orderId} AND "userId" = ${options.ownerId} FOR UPDATE
            `
          : await tx.$queryRaw<
              Array<{ id: string; userId: string; status: OrderStatus }>
            >`
              SELECT "id", "userId", "status" FROM "orders"
              WHERE "id" = ${orderId} FOR UPDATE
            `;
        const order = rows[0];
        if (!order) throw new NotFoundException('Order not found');
        if (
          options.skipIfNoLongerPending &&
          order.status !== OrderStatus.PENDING_PAYMENT
        ) {
          return null;
        }
        if (
          options.customerCancellation &&
          order.status !== OrderStatus.PENDING_PAYMENT
        ) {
          throw new ConflictException(
            'Customers can only cancel unpaid orders',
          );
        }
        if (!this.stateMachine.canTransition(order.status, nextStatus)) {
          throw new ConflictException(
            `Cannot transition from ${order.status} to ${nextStatus}`,
          );
        }

        await tx.order.update({
          where: { id: orderId },
          data: { status: nextStatus },
        });

        if (nextStatus === OrderStatus.CANCELLED) {
          const items = await tx.orderItem.findMany({
            where: { orderId },
            select: { productId: true, quantity: true },
          });
          items.sort((a, b) =>
            a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
          );

          for (const item of items) {
            const inventories = await tx.$queryRaw<
              Array<{ id: string; quantity: number }>
            >`
              SELECT "id", "quantity" FROM "inventory"
              WHERE "product_id" = ${item.productId} FOR UPDATE
            `;
            const inventory = inventories[0];
            if (!inventory) {
              throw new InternalServerErrorException(
                `Missing inventory for product ${item.productId}`,
              );
            }
            if (inventory.quantity + item.quantity > 2_147_483_647) {
              throw new InternalServerErrorException(
                'Restocked quantity exceeds the database limit',
              );
            }
            await tx.inventory.update({
              where: { productId: item.productId },
              data: {
                quantity: { increment: item.quantity },
                version: { increment: 1 },
              },
            });
            await tx.inventoryMovement.create({
              data: {
                inventoryId: inventory.id,
                type: InventoryMovementType.STOCK_IN,
                quantityDelta: item.quantity,
                reason: `Order ${orderId} cancelled`,
                actorId,
                actorType,
              },
            });
          }
        }

        const history = await tx.orderStatusHistory.create({
          data: {
            orderId,
            fromStatus: order.status,
            toStatus: nextStatus,
            actorId,
            actorType,
            reason: cleanReason,
          },
        });
        const updated = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: {
            id: true,
            status: true,
            currency: true,
            totalAmount: true,
            createdAt: true,
            items: {
              select: {
                id: true,
                productId: true,
                productName: true,
                unitPrice: true,
                quantity: true,
                lineTotal: true,
              },
            },
          },
        });
        return { order: updated, historyId: history.id };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );

    if (!committed) return null;
    await this.orderQueues.notifyStatusChange(committed.historyId);
    return this.serializeOrder(committed.order);
  }

  private serializeOrder(order: OrderResponseSource) {
    return {
      id: order.id,
      status: order.status,
      currency: order.currency,
      totalAmount: order.totalAmount.toString(),
      createdAt: order.createdAt,
      items: order.items.map((item) => ({
        ...item,
        lineTotal: item.lineTotal.toString(),
      })),
    };
  }
}
