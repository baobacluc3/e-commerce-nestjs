import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Max, Min, ValidateNested } from 'class-validator';

export class ReservationItemDto {
  @IsString() sku!: string;
  @IsInt() @Min(1) @Max(10_000) quantity!: number;
}

export class CreateReservationDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => ReservationItemDto)
  items!: ReservationItemDto[];
}