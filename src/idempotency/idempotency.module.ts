import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IdempotencyCleanupService } from './idempotency-cleanup.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

@Module({
  imports: [PrismaModule],
  providers: [IdempotencyInterceptor, IdempotencyCleanupService],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {}
