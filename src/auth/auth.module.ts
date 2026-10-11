import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import authConfig from './config/auth.config';
import { UsersModule } from '../users/user.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { SessionCleanupService } from './services/session-cleanup.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    UsersModule,
    ConfigModule.forFeature(authConfig),
    JwtModule.register({}), // secrets are passed per call in TokenService
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    SessionCleanupService,
    { provide: APP_GUARD, useClass: JwtAuthGuard }, // protected by default
  ],
  exports: [TokenService],
})
export class AuthModule {}
