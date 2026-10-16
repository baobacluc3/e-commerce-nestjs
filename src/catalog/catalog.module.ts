import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';

import { CategoriesService } from './categories.service';
import { ProductsService } from './products.service';

import { CategoriesController } from './categories.controller';
import { ProductsController } from './products.controller';

@Module({
  imports: [PrismaModule, AuthModule, RedisModule, RateLimitModule],
  controllers: [
    CategoriesController,
    ProductsController,
  ],
  providers: [CategoriesService, ProductsService],
})
export class CatalogModule {}
