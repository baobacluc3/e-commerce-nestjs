import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';

describe('Login endpoint', () => {
  let app: INestApplication;

  const authServiceMock = {
    register: jest.fn(),
    login: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authServiceMock,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/login returns tokens', async () => {
    authServiceMock.login.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 2592000,
    });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: ' CUSTOMER@EXAMPLE.COM ',
        password: 'VeryStrongPassword123!',
      })
      .expect(200)
      .expect({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenType: 'Bearer',
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 2592000,
      });

    expect(authServiceMock.login).toHaveBeenCalledWith({
      email: 'customer@example.com',
      password: 'VeryStrongPassword123!',
    });
  });

  it('rejects an invalid email', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'invalid-email',
        password: 'Password123!',
      })
      .expect(400);

    expect(authServiceMock.login).not.toHaveBeenCalled();
  });

  it('rejects an empty password', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'customer@example.com',
        password: '',
      })
      .expect(400);
  });

  it('rejects unexpected fields', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'customer@example.com',
        password: 'Password123!',
        role: 'ADMIN',
      })
      .expect(400);
  });
});
