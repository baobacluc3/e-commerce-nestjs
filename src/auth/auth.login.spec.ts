import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/user.service';
import { AuthService } from './auth.service';

describe('AuthService login', () => {
  let authService: AuthService;

  const accessSecret = 'access-secret-that-is-at-least-32-bytes-long';

  const refreshSecret = 'refresh-secret-that-is-at-least-32-bytes-long';

  const accessToken = 'signed-access-token';
  const refreshToken = 'signed-refresh-token';

  const usersServiceMock = {
    findByEmail: jest.fn(),
    findCredentialsByEmail: jest.fn(),
    createUser: jest.fn(),
  };

  const jwtServiceMock = {
    signAsync: jest.fn(),
  };

  const prismaServiceMock = {
    authSession: {
      create: jest.fn(),
    },
  };

  const configServiceMock = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        ACCESS_TOKEN_SECRET: accessSecret,
        REFRESH_TOKEN_SECRET: refreshSecret,
      };

      const value = values[key];

      if (!value) {
        throw new Error(`Missing ${key}`);
      }

      return value;
    }),

    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        ACCESS_TOKEN_TTL_SECONDS: '900',
        REFRESH_TOKEN_TTL_SECONDS: '2592000',
        JWT_ISSUER: 'ecommerce-api',
        JWT_AUDIENCE: 'ecommerce-api',
      };

      return values[key];
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    jwtServiceMock.signAsync.mockImplementation(
      async (payload: { type: 'access' | 'refresh' }) =>
        payload.type === 'access' ? accessToken : refreshToken,
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: usersServiceMock,
        },
        {
          provide: JwtService,
          useValue: jwtServiceMock,
        },
        {
          provide: PrismaService,
          useValue: prismaServiceMock,
        },
        {
          provide: ConfigService,
          useValue: configServiceMock,
        },
      ],
    }).compile();

    authService = moduleRef.get<AuthService>(AuthService);
  });

  it('returns access and refresh tokens for valid credentials', async () => {
    const password = 'VeryStrongPassword123!';

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    });

    usersServiceMock.findCredentialsByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'customer@example.com',
      passwordHash,
    });

    prismaServiceMock.authSession.create.mockResolvedValue({
      id: 'session-id',
    });

    const result = await authService.login({
      email: ' CUSTOMER@EXAMPLE.COM ',
      password,
    });

    expect(usersServiceMock.findCredentialsByEmail).toHaveBeenCalledWith(
      'customer@example.com',
    );

    expect(result).toEqual({
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 2592000,
    });

    expect(jwtServiceMock.signAsync).toHaveBeenCalledTimes(2);

    const expectedRefreshHash = createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    expect(prismaServiceMock.authSession.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        userId: 'user-1',
        refreshTokenHash: expectedRefreshHash,
        expiresAt: expect.any(Date),
      },
    });

    const refreshCall = jwtServiceMock.signAsync.mock.calls.find(
      ([payload]) => payload.type === 'refresh',
    );

    expect(refreshCall).toBeDefined();

    const refreshOptions = refreshCall?.[1];

    const sessionCreateData =
      prismaServiceMock.authSession.create.mock.calls[0][0].data;

    expect(refreshOptions.jwtid).toBe(sessionCreateData.id);
  });

  it('rejects an unknown email', async () => {
    usersServiceMock.findCredentialsByEmail.mockResolvedValue(null);

    await expect(
      authService.login({
        email: 'missing@example.com',
        password: 'SomePassword123!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(jwtServiceMock.signAsync).not.toHaveBeenCalled();

    expect(prismaServiceMock.authSession.create).not.toHaveBeenCalled();
  });

  it('rejects an incorrect password', async () => {
    const passwordHash = await argon2.hash('CorrectPassword123!', {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    });

    usersServiceMock.findCredentialsByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'customer@example.com',
      passwordHash,
    });

    await expect(
      authService.login({
        email: 'customer@example.com',
        password: 'WrongPassword123!',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid email or password',
    });

    expect(jwtServiceMock.signAsync).not.toHaveBeenCalled();

    expect(prismaServiceMock.authSession.create).not.toHaveBeenCalled();
  });
});
