import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/client';

export class ChangeOrderStatusDto {
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
