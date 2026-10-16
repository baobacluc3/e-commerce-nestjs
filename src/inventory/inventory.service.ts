import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  InventoryMovementType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async stockIn(
    productId: string,
    quantity: number,
    reason: string,
    actorId: string,
  ) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new BadRequestException(
        'Stock quantity must be a positive integer',
      );
    }
    if (!reason.trim())
      throw new BadRequestException('A stock movement reason is required');

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundException('Product not found');

      const inventory = await tx.inventory.upsert({
        where: { productId },
        create: { productId, quantity },
        update: {
          quantity: { increment: quantity },
          version: { increment: 1 },
        },
      });

      await tx.inventoryMovement.create({
        data: {
          inventoryId: inventory.id,
          type: InventoryMovementType.STOCK_IN,
          quantityDelta: quantity,
          reason,
          actorId,
          actorType: AuditActorType.USER,
        },
      });
      return inventory;
    });
  }
}
