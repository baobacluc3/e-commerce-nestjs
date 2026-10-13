//The JWT guard authenticates first. The roles guard then decides whether the authenticated user has permission. A user without the required role receives 403 Forbidden.

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../generated/prisma/client';

import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!roles?.length) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: { role: Role } }>();

    return !!request.user && roles.includes(request.user.role);
  }
}
