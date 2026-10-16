import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_KEY } from './rate-limit.decorator';
import { RateLimitOptions } from './rate-limit.types';

interface RateLimitRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: { id?: string };
}

interface RateLimitResponse {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) return true;

    const request = context.switchToHttp().getRequest<RateLimitRequest>();
    const response = context.switchToHttp().getResponse<RateLimitResponse>();
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const userId = request.user?.id;
    const scope = [context.getClass().name, context.getHandler().name].join(
      ':',
    );

    let decision;
    try {
      decision = await this.rateLimitService.consume(
        options,
        scope,
        ip,
        userId,
      );
    } catch (error) {
      this.logger.error(
        `Rate-limit Redis failure: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      if (options.redisFailure === 'open') return true;
      throw new ServiceUnavailableException(
        'Rate limiting is temporarily unavailable',
      );
    }

    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(decision.retryAfterMs / 1000),
      );
      response.setHeader('Retry-After', String(retryAfterSeconds));
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
