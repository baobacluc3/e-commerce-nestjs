import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: {
        email,
      },
      select: {
        email: true,
        id: true,
        createdAt: true,
      },
    });
  }

  async createUser(input: CreateUserInput) {
    return this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
      },
    });
  }

  async findCredentialsByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true },
    });
  }
}
