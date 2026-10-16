import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

const MAX_ITEM_QUANTITY = 99;

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  private async getOrCreateCart(tx: Prisma.TransactionClient, userId: string) {
    return tx.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { id: true },
    });
  }

  private async lockCart(tx: Prisma.TransactionClient, cartId: string) {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "carts" WHERE "id" = ${cartId} FOR UPDATE
    `;
  }

  private async ensureProductAvailable(
    tx: Prisma.TransactionClient,
    productId: string,
  ) {
    const product = await tx.product.findFirst({
      where: {
        id: productId,
        status: ProductStatus.PUBLISHED,
        deletedAt: null,
        category: { is: { isActive: true, deletedAt: null } },
      },
      select: { id: true },
    });

    if (!product) throw new NotFoundException('Product is unavailable');
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    await this.addItemWithRetry(userId, dto, 0);
    return this.getCart(userId);
  }

  private async addItemWithRetry(
    userId: string,
    dto: AddCartItemDto,
    attempt: number,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.ensureProductAvailable(tx, dto.productId);
        const cart = await this.getOrCreateCart(tx, userId);
        await this.lockCart(tx, cart.id);
        const existing = await tx.cartItem.findUnique({
          where: {
            cartId_productId: { cartId: cart.id, productId: dto.productId },
          },
          select: { id: true },
        });

        if (!existing) {
          await tx.cartItem.create({
            data: {
              cartId: cart.id,
              productId: dto.productId,
              quantity: dto.quantity,
            },
          });
          return;
        }

        const updated = await tx.cartItem.updateMany({
          where: {
            id: existing.id,
            quantity: { lte: MAX_ITEM_QUANTITY - dto.quantity },
          },
          data: { quantity: { increment: dto.quantity } },
        });
        if (updated.count !== 1) {
          throw new ConflictException('Maximum quantity reached for this product');
        }
      });
    } catch (error) {
      if (isPrismaCode(error, 'P2002') && attempt < 2) {
        return this.addItemWithRetry(userId, dto, attempt + 1);
      }
      if (isPrismaCode(error, 'P2004')) {
        throw new BadRequestException('Invalid cart quantity');
      }
      throw error;
    }
  }

  async getCart(userId: string) {
    const cart = await this.prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                slug: true,
                price: true,
                images: true,
                status: true,
                deletedAt: true,
                category: { select: { isActive: true, deletedAt: true } },
              },
            },
          },
        },
      },
    });

    const items = cart.items.map((item) => {
      const product = item.product;
      const available =
        product.status === ProductStatus.PUBLISHED &&
        product.deletedAt === null &&
        product.category.isActive &&
        product.category.deletedAt === null;
      return {
        id: item.id,
        productId: product.id,
        quantity: item.quantity,
        product: {
          id: product.id,
          name: product.name,
          slug: product.slug,
          price: product.price,
          images: product.images,
        },
        available,
        lineTotal: available ? product.price * item.quantity : null,
      };
    });

    return {
      id: cart.id,
      currency: 'VND',
      items,
      subtotal: items.reduce((total, item) => total + (item.lineTotal ?? 0), 0),
    };
  }

  async updateItem(userId: string, productId: string, dto: UpdateCartItemDto) {
    await this.prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findUnique({ where: { userId }, select: { id: true } });
      if (!cart) throw new NotFoundException('Cart item not found');
      await this.lockCart(tx, cart.id);
      await this.ensureProductAvailable(tx, productId);
      const result = await tx.cartItem.updateMany({
        where: { cartId: cart.id, productId },
        data: { quantity: dto.quantity },
      });
      if (result.count !== 1) throw new NotFoundException('Cart item not found');
    });
    return this.getCart(userId);
  }

  async removeItem(userId: string, productId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findUnique({ where: { userId }, select: { id: true } });
      if (!cart) throw new NotFoundException('Cart item not found');
      await this.lockCart(tx, cart.id);
      return tx.cartItem.deleteMany({ where: { cartId: cart.id, productId } });
    });
    if (result.count === 0) throw new NotFoundException('Cart item not found');
    return this.getCart(userId);
  }
}
