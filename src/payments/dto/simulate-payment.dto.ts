import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class SimulatePaymentDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  duplicateCount = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(600000)
  delayMs?: number;
}
