import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  // Copy the exact rules from your RegisterDto so both paths enforce the same policy
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}
