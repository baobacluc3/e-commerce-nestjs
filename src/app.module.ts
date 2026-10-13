import { Module } from '@nestjs/common';

import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/user.module';
import { CatalogModule } from './catalog/catalog.module';

@Module({
  imports: [
    PrismaModule,
    CatalogModule,
    UsersModule,
    AuthModule,
    ConfigModule.forRoot({ isGlobal: true }),
  ],
})
export class AppModule {}
