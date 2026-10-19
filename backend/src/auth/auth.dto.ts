import { IsEmail, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { SR_CODE_REGEX } from '../lib/sr-code';

/** Students send { srCode, password }; the teacher sends { email, password }. */
export class LoginDto {
  @ValidateIf((o: LoginDto) => o.email === undefined)
  @IsString()
  @Matches(SR_CODE_REGEX, { message: 'srCode must look like 23-12345' })
  srCode?: string;

  @ValidateIf((o: LoginDto) => o.srCode === undefined)
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for your new password' })
  @MaxLength(72)
  newPassword!: string;
}
