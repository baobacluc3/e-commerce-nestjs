import {
  BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { Roles } from './guards/roles.decorator';
import { RolesGuard } from './guards/roles.guard';
import { InventoryService } from './inventory.service';

const requireKey = (key?: string) => {
  if (!key || key.length < 8 || key.length > 128) {
    throw new BadRequestException('Idempotency-Key header (8-128 chars) is required');
  }
  return key;
};

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('products') @Roles('ADMIN') @UseGuards(RolesGuard)
  createProduct(@Body() dto: CreateProductDto, @CurrentUser() user: AuthenticatedUser) {
    return this.inventory.createProduct(dto, user.id);
  }

  @Post('products/:sku/adjust') @HttpCode(200) @Roles('ADMIN') @UseGuards(RolesGuard)
  adjust(
    @Param('sku') sku: string, @Body() dto: AdjustStockDto,
    @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.inventory.adjustStock(sku, dto, user.id, requireKey(key));
  }

  @Get('products/:sku')
  stock(@Param('sku') sku: string) {
    return this.inventory.getStock(sku);
  }

  @Post('reservations')
  reserve(
    @Body() dto: CreateReservationDto, @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.inventory.reserve(user.id, requireKey(key), dto);
  }

  @Get('reservations/:id')
  getReservation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inventory.getReservation(user.id, id);
  }

  @Post('reservations/:id/release') @HttpCode(200)
  release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inventory.release(user.id, id);
  }

  @Post('reservations/:id/commit') @HttpCode(200)
  commit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inventory.commit(user.id, id);
  }
}
