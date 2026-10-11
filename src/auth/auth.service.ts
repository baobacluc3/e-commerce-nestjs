import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/user.service';
import type { RequestMeta, TokenResponse } from './types/auth.types';
import { TokenService } from './token.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

const ARGON2_OPTIONS = { type: argon2.argon2id } as const;
const INVALID_REFRESH = 'Invalid refresh token.';

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

@Injectable()
export class AuthService implements OnModuleInit {
  /** Verified against when the email is unknown, so timing doesn't leak existence. */
  private dummyHash!: string;

  constructor(
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash(
      randomBytes(16).toString('hex'),
      ARGON2_OPTIONS,
    );
  }

  async register(dto: RegisterDto) {
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);
    const user = await this.users.createUser({
      email: dto.email,
      passwordHash,
    });
    return { id: user.id, email: user.email, createdAt: user.createdAt };
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<TokenResponse> {
    const user = await this.users.findCredentialsByEmail(dto.email);

    // Always run one Argon2 verification, whether or not the user exists.
    const valid = await argon2.verify(
      user?.passwordHash ?? this.dummyHash,
      dto.password,
    );
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const sessionId = randomUUID(); // becomes the refresh token's jti
    const refreshToken = await this.tokens.signRefreshToken(user.id, sessionId);

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash: this.tokens.hash(refreshToken),
        expiresAt: this.refreshExpiry(),
        userAgent: meta.userAgent?.slice(0, 512),
        ip: meta.ip,
      },
    });

    return this.buildResponse(user, refreshToken);
  }

  /**
   * Rotation: the session ID stays the same, but the stored hash is replaced
   * with the hash of the new refresh token. Presenting an older token for a
   * live session therefore means it was already rotated out (replay), and all
   * of that user's sessions are revoked.
   */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const { userId, sessionId } = await this.tokens.verifyRefreshToken(refreshToken);

    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { id: true, email: true } } },
    });

    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt !== null ||
      session.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    const presentedHash = this.tokens.hash(refreshToken);

    if (!safeEqualHex(session.refreshTokenHash, presentedHash)) {
      await this.revokeAllSessions(userId); // reuse detected
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    const newRefreshToken = await this.tokens.signRefreshToken(userId, sessionId);

    // Compare-and-swap: only one of two concurrent refreshes can win.
    const { count } = await this.prisma.authSession.updateMany({
      where: {
        id: sessionId,
        refreshTokenHash: presentedHash,
        revokedAt: null,
      },
      data: {
        refreshTokenHash: this.tokens.hash(newRefreshToken),
        expiresAt: this.refreshExpiry(), // sliding expiry
      },
    });
    if (count !== 1) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    return this.buildResponse(session.user, newRefreshToken);
  }

  /** Idempotent: never reveals whether the token was valid. */
  async logout(refreshToken: string): Promise<void> {
    try {
      const { userId, sessionId } = await this.tokens.verifyRefreshToken(refreshToken);
      await this.prisma.authSession.updateMany({
        where: {
          id: sessionId,
          userId,
          refreshTokenHash: this.tokens.hash(refreshToken),
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.revokeAllSessions(userId);
  }

  private async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000);
  }

  private async buildResponse(
    user: { id: string; email: string },
    refreshToken: string,
  ): Promise<TokenResponse> {
    return {
      accessToken: await this.tokens.signAccessToken(user),
      refreshToken,
      tokenType: 'Bearer',
      accessTokenExpiresIn: this.tokens.accessTtlSeconds,
      refreshTokenExpiresIn: this.tokens.refreshTtlSeconds,
    };
  }
}
