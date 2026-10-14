import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

import { CategoriesService } from './categories.service';
import { ProductsService } from './products.service';

import { CategoriesController } from './categories.controller';
import { AdminCategoriesController } from './admin-categories.controller';
import { ProductsController } from './products.controller';
import { AdminProductsController } from './admin-products.controller';

@Module({
  imports: [PrismaModule, AuthModule, RedisModule],
  controllers: [
    CategoriesController,
    AdminCategoriesController,
    ProductsController,
    AdminProductsController,
  ],
  providers: [CategoriesService, ProductsService],
})
export class CatalogModule {}
