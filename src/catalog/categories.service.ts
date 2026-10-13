import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCategoryDto) {
    try {
      return await this.prisma.category.create({ data: dto });
    } catch (error) {
      if (isPrismaCode(error, 'P2002')) {
        throw new ConflictException('Category slug already exists');
      }
      throw error;
    }
  }

  findPublic() {
    return this.prisma.category.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
      },
    });
  }

  async findPublicBySlug(slug: string) {
    const category = await this.prisma.category.findFirst({
      where: { slug, isActive: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
      },
    });

    if (!category) throw new NotFoundException('Category not found');

    return category;
  }

  findAllAdmin() {
    return this.prisma.category.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.category.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });

    if (!existing) throw new NotFoundException('Category not found');

    try {
      return await this.prisma.category.update({
        where: { id },
        data: dto,
      });
    } catch (error) {
      if (isPrismaCode(error, 'P2002')) {
        throw new ConflictException('Category slug already exists');
      }
      throw error;
    }
  }

  async softDelete(id: string) {
    const result = await this.prisma.category.updateMany({
      where: { id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        isActive: false,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Category not found');
    }

    return { message: 'Category deleted' };
  }
}
