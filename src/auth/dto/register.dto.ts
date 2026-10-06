import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;
}
