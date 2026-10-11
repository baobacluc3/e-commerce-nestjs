import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import authConfig from './config/auth.config';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
  RefreshTokenPayload,
} from './types/auth.types';

const ALGORITHM = 'HS256' as const;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  get accessTtlSeconds(): number {
    return this.config.accessTokenTtlSeconds;
  }

  get refreshTtlSeconds(): number {
    return this.config.refreshTokenTtlSeconds;
  }

  signAccessToken(user: AuthenticatedUser): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      type: 'access',
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.accessTokenSecret,
      algorithm: ALGORITHM,
      expiresIn: this.config.accessTokenTtlSeconds,
      issuer: this.config.issuer,
      audience: this.config.audience,
    });
  }

  signRefreshToken(userId: string, sessionId: string): Promise<string> {
    const payload: RefreshTokenPayload = {
      sub: userId,
      type: 'refresh',
      nonce: randomUUID(),
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.refreshTokenSecret,
      algorithm: ALGORITHM,
      expiresIn: this.config.refreshTokenTtlSeconds, // was accessTokenTtlSeconds
      issuer: this.config.issuer,
      audience: this.config.audience,
      jwtid: sessionId,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    const payload = await this.verify<AccessTokenPayload>(
      token,
      this.config.accessTokenSecret,
    );
    if (payload.type !== 'access' || !payload.sub || !payload.email) {
      throw new UnauthorizedException('Invalid or expired token.');
    }
    return { id: payload.sub, email: payload.email };
  }

  async verifyRefreshToken(
    token: string,
  ): Promise<{ userId: string; sessionId: string }> {
    const payload = await this.verify<RefreshTokenPayload & { jti?: string }>(
      token,
      this.config.refreshTokenSecret,
    );
    if (payload.type !== 'refresh' || !payload.sub || !payload.jti) {
      throw new UnauthorizedException('Invalid or expired token.');
    }
    return { userId: payload.sub, sessionId: payload.jti };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async verify<T extends object>(token: string, secret: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token, {
        secret,
        algorithms: [ALGORITHM], // pinned: rejects "none" and algorithm confusion
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }
  }
}
