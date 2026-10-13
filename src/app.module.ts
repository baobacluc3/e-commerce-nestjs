import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [PrismaModule, ConfigModule.forRoot({ isGlobal: true }), ThrottlerModule.forRoot([{
    ttl:60_000,
    limit:100,
    skipIf: () => process.env.NODE_ENV === 'test',
  }]),ScheduleModule.forRoot(), AuthModule],
  controllers: [AppController],
  providers: [AppService, {provide:APP_GUARD,useClass:ThrottlerModule}],
})
export class AppModule {}

//APP_GUARD is a NestJS special provider token for registering a global guard.
//ThrottlerGuard checks incoming requests against the throttling rules configured in ThrottlerModule.
