import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../../common/config/app-config.service';
import { AuthService } from './auth.service';
import { CurrentAdmin, Public } from './admin-auth.guard';
import { LoginDto, RefreshDto } from './dto/auth.dto';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto, @Req() request: Request) {
    const result = await this.auth.login(body.email, body.password, {
      ip: this.clientIp(request),
      userAgent: request.headers['user-agent'],
    });

    return {
      ...result.tokens,
      admin: result.admin,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: RefreshDto, @Req() request: Request) {
    return this.auth.refresh(body.refreshToken, {
      ip: this.clientIp(request),
      userAgent: request.headers['user-agent'],
    });
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: RefreshDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  async me(@CurrentAdmin() admin: { id: string; email: string; displayName: string | null; role: string }) {
    return admin;
  }

  private clientIp(request: Request): string {
    if (this.appConfig.trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const first = raw?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.ip ?? 'unknown';
  }
}
