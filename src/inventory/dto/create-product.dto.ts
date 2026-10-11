import { IsInt, IsNotEmpty, IsString, Matches, MaxLength, Min } from 'class-validator';

export class CreateProductDto {
  @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{1,63}$/) sku!: string;
  @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @IsInt() @Min(0) initialStock!: number;
}