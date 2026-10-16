import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { IdempotencyContext } from './idempotency.types';

export const IdempotencyRequest = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<{
      idempotencyContext?: IdempotencyContext;
    }>();
    return request.idempotencyContext;
  },
);
