import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '../generated/prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PaginationDto } from './dto/pagination.dto';
import { UsersService } from './user.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('users')
  findAll(@Query() query: PaginationDto) {
    return this.usersService.findAll(query.page, query.limit);
  }
}
