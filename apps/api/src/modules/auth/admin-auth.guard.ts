import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import type { Request } from 'express';
import { AuthService, AuthenticatedAdmin } from './auth.service';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/** Injects the authenticated administrator in a controller handler. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedAdmin =>
    context.switchToHttp().getRequest<Request & { admin?: AuthenticatedAdmin }>().admin!,
);

/**
 * Verifies the `Authorization: Bearer <jwt>` header.
 * Blocks revoked / deactivated accounts even if the token is still valid.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { admin?: AuthenticatedAdmin }>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Jeton d’authentification manquant');
    }

    const token = header.slice(7).trim();
    const admin = await this.auth.validateAccessToken(token);
    request.admin = admin;
    return true;
  }
}

/** Restricts a route to the given admin roles. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { admin?: AuthenticatedAdmin }>();
    const role = request.admin?.role;
    if (!role || !required.includes(role)) {
      throw new UnauthorizedException('Droits insuffisants pour cette operation');
    }
    return true;
  }
}
