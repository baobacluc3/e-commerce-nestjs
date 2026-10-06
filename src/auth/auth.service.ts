import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from '../users/user.service';
import { RegisterDto } from './dto/register.dto';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';
import { PrismaService } from '../prisma/prisma.service';
import { createHash, randomUUID } from 'node:crypto';

export interface RegisterResult {
  id: string;
  email: string;
  createdAt: Date;
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly accessTokenSecret: string;
  private readonly refreshTokenSecret: string;

  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;

  private readonly jwtIssuer: string;
  private readonly jwtAudience: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.accessTokenSecret = this.getSecret('ACCESS_TOKEN_SECRET');
    this.refreshTokenSecret = this.getSecret('REFRESH_TOKEN_SECRET');

    this.accessTokenTtlSeconds = this.getPositiveInteger(
      'ACCESS_TOKEN_TTL_SECONDS',
      900,
    );
    this.refreshTokenTtlSeconds = this.getPositiveInteger(
      'REFRESH_TOKEN_TTL_SECONDS',
      2592000,
    );

    if (this.accessTokenSecret === this.refreshTokenSecret) {
      throw new Error('2 key must be different');
    }

    this.jwtIssuer =
      this.configService.get<string>('JWT_ISSUER') ?? 'ecommerce-api';

    this.jwtAudience =
      this.configService.get<string>('JWT_AUDIENCE') ?? 'ecommerce-api';
  }

  async register(dto: RegisterDto): Promise<RegisterResult> {
    const email = dto.email.trim().toLowerCase();
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('email is already registered');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    try {
      return await this.usersService.createUser({ email, passwordHash });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email is already registered');
      }

      throw error;
    }
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.usersService.findCredentialsByEmail(email);
    if (!user) {
      throw this.invalidCredentials;
    }
    let passwordMatches = false;

    try {
      passwordMatches = await argon2.verify(user.passwordHash, dto.password);
    } catch {
      passwordMatches = false;
    }

    if (!passwordMatches) {
      throw this.invalidCredentials();
    }

    const sessionId = randomUUID();

    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      type: 'access',
    };

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      type: 'refresh',
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.accessTokenSecret,
        algorithm: 'HS256',
        expiresIn: this.accessTokenTtlSeconds,
        issuer: this.jwtIssuer,
        audience: this.jwtAudience,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshTokenSecret,
        algorithm: 'HS256',
        expiresIn: this.accessTokenTtlSeconds,
        issuer: this.jwtIssuer,
        audience: this.jwtAudience,
        jwtid: sessionId,
      }),
    ]);

    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + this.refreshTokenTtlSeconds * 1000);

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash,
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      accessTokenExpiresIn: this.accessTokenTtlSeconds,
      refreshTokenExpiresIn: this.refreshTokenTtlSeconds,
    };
  }

  private getSecret(key: string): string {
    const value = this.configService.getOrThrow<string>(key);
    if (Buffer.byteLength(value, 'utf8') < 32) {
      throw new Error(`${key} must contain at least 32 bytes`);
    }
    return value;
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private getPositiveInteger(key: string, defaultValue: number): number {
    const raw = this.configService.getOrThrow<string>(key);
    if (raw === undefined) {
      return defaultValue;
    }
    const value = Number(raw);

    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    return value;
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException('Invalid email or password');
  }
}
