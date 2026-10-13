import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

import { AdminUsersController } from './admin-users.controller';
import { UsersController } from './user.controller';
import { UsersService } from './user.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService],
})
export class UsersModule {}
