import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { RolesGuard } from './guards/roles.guard';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, RolesGuard],
})
export class InventoryModule {}