import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IdempotencyStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class IdempotencyCleanupService {
  private readonly logger = new Logger(IdempotencyCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async removeExpiredCompletedRecords() {
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: {
        status: IdempotencyStatus.COMPLETED,
        expiresAt: { lte: new Date() },
      },
    });
    if (result.count > 0) {
      this.logger.log(`Removed ${result.count} expired idempotency records`);
    }
  }
}
