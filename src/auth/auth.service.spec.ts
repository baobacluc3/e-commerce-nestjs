import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client';
import { UsersService } from '../users/user.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let authService: AuthService;

  const usersServiceMock = {
    findByEmail: jest.fn(),
    createUser: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: usersServiceMock,
        },
      ],
    }).compile();

    authService = moduleRef.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('registers a user and hashes the password', async () => {
      const createdAt = new Date('2026-10-06T16:00:00.000Z');

      usersServiceMock.findByEmail.mockResolvedValue(null);

      usersServiceMock.createUser.mockImplementation(
        async ({ email }: { email: string; passwordHash: string }) => ({
          id: 'user-id',
          email,
          createdAt,
        }),
      );

      const password = 'VeryStrongPassword123!';

      const result = await authService.register({
        email: '  CUSTOMER@EXAMPLE.COM ',
        password,
      });

      expect(usersServiceMock.findByEmail).toHaveBeenCalledWith(
        'customer@example.com',
      );

      expect(usersServiceMock.createUser).toHaveBeenCalledTimes(1);

      const createInput = usersServiceMock.createUser.mock.calls[0][0];

      expect(createInput.email).toBe('customer@example.com');

      expect(createInput.passwordHash).not.toBe(password);

      expect(await argon2.verify(createInput.passwordHash, password)).toBe(
        true,
      );

      expect(result).toEqual({
        id: 'user-id',
        email: 'customer@example.com',
        createdAt,
      });
    });

    it('throws conflict when email already exists', async () => {
      usersServiceMock.findByEmail.mockResolvedValue({
        id: 'existing-user',
        email: 'customer@example.com',
        createdAt: new Date(),
      });

      await expect(
        authService.register({
          email: 'customer@example.com',
          password: 'VeryStrongPassword123!',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(usersServiceMock.createUser).not.toHaveBeenCalled();
    });

    it('handles a database unique constraint race condition', async () => {
      usersServiceMock.findByEmail.mockResolvedValue(null);

      const prismaError = Object.assign(
        Object.create(Prisma.PrismaClientKnownRequestError.prototype) as object,
        {
          code: 'P2002',
          clientVersion: '7.10.0',
        },
      );

      usersServiceMock.createUser.mockRejectedValue(prismaError);

      await expect(
        authService.register({
          email: 'customer@example.com',
          password: 'VeryStrongPassword123!',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
