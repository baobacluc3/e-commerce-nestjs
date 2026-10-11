import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    // Runs after the global JWT guard, so request.user is set.
    const userId: string | undefined = ctx.switchToHttp().getRequest().user?.id;
    const user = userId
      ? await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
      : null;
    if (!user || !required.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}