import { IsBoolean, IsBooleanString } from 'class-validator';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  email!: string;

  @IsString()
  @MinLength(6, { message: 'Le mot de passe doit contenir au moins 6 caracteres' })
  password!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class CreateAdminDto {
  @IsString()
  email!: string;

  @IsString()
  @MinLength(10, { message: 'Le mot de passe doit contenir au moins 10 caracteres' })
  password!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  role?: 'OWNER' | 'ADMIN' | 'VIEWER';
}

export class UpdateAdminDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  role?: 'OWNER' | 'ADMIN' | 'VIEWER';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(10)
  password?: string;
}
