import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { PrismaService } from '../prisma/prisma.service';

const ACCESS_TOKEN_TTL = 15 * 60; // seconds
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // milliseconds
const INVALID_CREDENTIALS = 'Invalid email or password';

type AuthUser = {
  id: string;
  email: string;
};

type AuthResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: AuthUser;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    let user: AuthUser;

    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
        },
        select: {
          id: true,
          email: true,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException('Email already registered');
      }

      throw error;
    }

    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
      },
    });

    if (!user) {
      // Avoid an immediate response when the email does not exist.
      await argon2.hash(dto.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const validPassword = await argon2.verify(user.passwordHash, dto.password);

    if (!validPassword) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.issueTokens({
      id: user.id,
      email: user.email,
    });
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const now = new Date();

    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });

    if (
      !current ||
      current.revokedAt ||
      current.expiresAt.getTime() <= now.getTime()
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: current.userId },
      select: { id: true, email: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const nextRefreshToken = randomBytes(32).toString('base64url');

    // Atomically consume the old token and create the replacement.
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.refreshToken.updateMany({
        where: {
          id: current.id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });

      // Prevent two simultaneous requests from using the same token.
      if (result.count !== 1) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(nextRefreshToken),
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL),
        },
      });
    });

    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email },
      { expiresIn: ACCESS_TOKEN_TTL },
    );

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL,
      user,
    };
  }

  async logout(refreshToken: string): Promise<{ message: string }> {
    await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash: hashToken(refreshToken),
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    // Same response even if the token is unknown or already revoked.
    return { message: 'Logged out' };
  }

  private async issueTokens(user: AuthUser): Promise<AuthResponse> {
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email },
      { expiresIn: ACCESS_TOKEN_TTL },
    );

    const refreshToken = randomBytes(32).toString('base64url');

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL),
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL,
      user,
    };
  }
}
