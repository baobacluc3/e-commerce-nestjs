import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMeDto } from './dto/update-me.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    if (dto.name === undefined) {
      return this.getMe(userId);
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { name: dto.name },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });
  }

}
