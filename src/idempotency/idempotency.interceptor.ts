import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IdempotencyStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyContext } from './idempotency.types';
import { createHash } from 'node:crypto';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, concatMap, mergeMap } from 'rxjs/operators';

const TTL_MS = 24 * 60 * 60 * 1000;

interface IdempotentRequest {
  method: string;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: string };
  body?: unknown;
  query?: unknown;
  headers: Record<string, string | string[] | undefined>;
  user?: { id: string };
  idempotencyContext?: IdempotencyContext;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, stableValue(object[key])]),
    );
  }
  return value;
}

function hashRequest(scope: string, body: unknown, query: unknown): string {
  const canonical = JSON.stringify({
    scope,
    body: stableValue(body ?? {}),
    query: stableValue(query ?? {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function isPrismaUniqueError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<IdempotentRequest>();
    const userId = request.user?.id;
    if (!userId)
      throw new BadRequestException(
        'Authentication is required for idempotency',
      );

    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || !key.trim() || key.length > 255) {
      throw new BadRequestException('Provide a valid Idempotency-Key header');
    }

    const concretePath = request.originalUrl
      ? request.originalUrl.split('?')[0]
      : `${request.baseUrl ?? ''}${request.path ?? request.route?.path ?? ''}`;
    const scope = `${request.method}:${concretePath}`;
    const requestHash = hashRequest(scope, request.body, request.query);
    const reservation = await this.reserve(
      userId,
      scope,
      key.trim(),
      requestHash,
    );

    if (reservation.kind === 'replay') {
      context
        .switchToHttp()
        .getResponse<{ status: (code: number) => unknown }>()
        .status(reservation.status);
      return of(reservation.body);
    }

    request.idempotencyContext = reservation.context;
    return next.handle().pipe(
      concatMap(async (body) => {
        // Checkout completes this within its transaction; this is a fallback
        // for a handler that leaves the reservation in progress.
        await this.prisma.idempotencyRecord.updateMany({
          where: {
            id: reservation.context.recordId,
            status: IdempotencyStatus.IN_PROGRESS,
          },
          data: {
            status: IdempotencyStatus.COMPLETED,
            responseStatus: 201,
            responseBody: jsonValue(body),
          },
        });
        return body;
      }),
      catchError((error: unknown) =>
        from(
          this.prisma.idempotencyRecord.deleteMany({
            where: {
              id: reservation.context.recordId,
              status: IdempotencyStatus.IN_PROGRESS,
            },
          }),
        ).pipe(
          catchError(() => of({ count: 0 })),
          mergeMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  private async reserve(
    userId: string,
    scope: string,
    key: string,
    requestHash: string,
  ) {
    const uniqueKey = { userId_scope_key: { userId, scope, key } };
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: uniqueKey,
      });
      if (existing) {
        if (existing.expiresAt.getTime() <= Date.now()) {
          await this.prisma.idempotencyRecord.deleteMany({
            where: { id: existing.id, expiresAt: { lte: new Date() } },
          });
          continue;
        }
        if (existing.requestHash !== requestHash) {
          throw new UnprocessableEntityException(
            'This Idempotency-Key was already used with a different request',
          );
        }
        if (existing.status === IdempotencyStatus.COMPLETED) {
          if (
            existing.responseStatus === null ||
            existing.responseBody === null
          ) {
            throw new InternalServerErrorException(
              'Stored idempotency response is incomplete',
            );
          }
          return {
            kind: 'replay' as const,
            status: existing.responseStatus,
            body: existing.responseBody,
          };
        }
        const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
        if (
          existing.status === IdempotencyStatus.IN_PROGRESS &&
          existing.createdAt < staleBefore
        ) {
          await this.prisma.idempotencyRecord.deleteMany({
            where: {
              id: existing.id,
              status: IdempotencyStatus.IN_PROGRESS,
              createdAt: { lt: staleBefore },
            },
          });
          continue;
        }
        throw new ConflictException(
          'A request with this Idempotency-Key is still in progress',
        );
      }

      try {
        const record = await this.prisma.idempotencyRecord.create({
          data: {
            userId,
            scope,
            key,
            requestHash,
            status: IdempotencyStatus.IN_PROGRESS,
            expiresAt: new Date(Date.now() + TTL_MS),
          },
        });
        return {
          kind: 'reserved' as const,
          context: { recordId: record.id, userId, scope, key, requestHash },
        };
      } catch (error) {
        if (!isPrismaUniqueError(error)) throw error;
        // A concurrent request won the unique-key race; inspect its row again.
      }
    }
    throw new ConflictException(
      'Could not reserve this Idempotency-Key; retry the request',
    );
  }
}
