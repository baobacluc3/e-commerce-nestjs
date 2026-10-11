import { IsInt, IsOptional, IsString, MaxLength, NotEquals, Max, Min } from 'class-validator';

export class AdjustStockDto {
  @IsInt() @Min(-1_000_000) @Max(1_000_000) @NotEquals(0) delta!: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}