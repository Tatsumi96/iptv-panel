import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AdminAuthGuard, RolesGuard } from './admin-auth.guard';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, AdminAuthGuard, RolesGuard],
  exports: [AuthService, AdminAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
