import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';

describe('Registration (e2e)', () => {
  let app: INestApplication;

  const authServiceMock = {
    register: jest.fn(),
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

  it('POST /auth/register returns 201', async () => {
    const createdAt = new Date('2026-10-06T16:00:00.000Z');

    authServiceMock.register.mockResolvedValue({
      id: 'user-id',
      email: 'customer@example.com',
      createdAt,
    });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'customer@example.com',
        password: 'VeryStrongPassword123!',
      })
      .expect(201)
      .expect({
        id: 'user-id',
        email: 'customer@example.com',
        createdAt: createdAt.toISOString(),
      });
  });

  it('rejects an invalid email', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'not-an-email',
        password: 'VeryStrongPassword123!',
      })
      .expect(400);

    expect(authServiceMock.register).not.toHaveBeenCalled();
  });

  it('rejects a short password', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'customer@example.com',
        password: 'short',
      })
      .expect(400);
  });

  it('rejects unexpected properties', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'customer@example.com',
        password: 'VeryStrongPassword123!',
        role: 'ADMIN',
      })
      .expect(400);
  });
});
