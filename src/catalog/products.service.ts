//This service ensures public requests only see published products in active categories. When a category is deactivated or soft-deleted, its products disappear from public listings without deleting the product records.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

import { Prisma } from '../generated/prisma/client';

import { ProductSearchDto, ProductSort } from './dto/product-search.dto';

type CursorPayload =
  | {
      v: 1;
      sort: ProductSort.NEWEST;
      id: string;
      createdAt: string;
    }
  | {
      v: 1;
      sort: ProductSort.PRICE_ASC | ProductSort.PRICE_DESC;
      id: string;
      price: number;
    };

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

const productSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  price: true,
  status: true,
  images: true,
  categoryId: true,
  createdAt: true,
  updatedAt: true,
  category: {
    select: { id: true, name: true, slug: true },
  },
} as const;

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureActiveCategory(categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: {
        id: categoryId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!category) {
      throw new BadRequestException('Category is unavailable');
    }
  }

  async create(dto: CreateProductDto) {
    await this.ensureActiveCategory(dto.categoryId);

    try {
      return await this.prisma.product.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
          price: dto.price,
          status: dto.status ?? ProductStatus.DRAFT,
          images: dto.images ?? [],
          categoryId: dto.categoryId,
        },
        select: productSelect,
      });
    } catch (error) {
      if (isPrismaCode(error, 'P2002')) {
        throw new ConflictException('Product slug already exists');
      }
      throw error;
    }
  }

  async findPublic(page = 1, limit = 20) {
    const where = {
      status: ProductStatus.PUBLISHED,
      deletedAt: null,
      category: {
        is: { isActive: true, deletedAt: null },
      },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: productSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findPublicBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        slug,
        status: ProductStatus.PUBLISHED,
        deletedAt: null,
        category: {
          is: { isActive: true, deletedAt: null },
        },
      },
      select: productSelect,
    });

    if (!product) throw new NotFoundException('Product not found');

    return product;
  }

  async findAllAdmin(page = 1, limit = 20) {
    const where = { deletedAt: null };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: productSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async update(id: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });

    if (!existing) throw new NotFoundException('Product not found');

    if (dto.categoryId !== undefined) {
      await this.ensureActiveCategory(dto.categoryId);
    }

    try {
      return await this.prisma.product.update({
        where: { id },
        data: { ...dto },
        select: productSelect,
      });
    } catch (error) {
      if (isPrismaCode(error, 'P2002')) {
        throw new ConflictException('Product slug already exists');
      }
      throw error;
    }
  }

  async softDelete(id: string) {
    const result = await this.prisma.product.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (result.count === 0) {
      throw new NotFoundException('Product not found');
    }

    return { message: 'Product deleted' };
  }

  async searchPublic(query: ProductSearchDto) {
    return this.search(query, true);
  }

  async searchAdmin(query: ProductSearchDto) {
    return this.search(query, false);
  }

  private async search(query: ProductSearchDto, publicOnly: boolean) {
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new BadRequestException('minPrice must not exceed maxPrice');
    }

    const cursor = this.decodeCursor(query.cursor, query.sort);

    const conditions: Prisma.ProductWhereInput[] = [{ deletedAt: null }];

    if (publicOnly) {
      conditions.push({
        status: ProductStatus.PUBLISHED,
        category: {
          is: {
            isActive: true,
            deletedAt: null,
          },
        },
      });
    }

    if (query.categoryId) {
      conditions.push({ categoryId: query.categoryId });
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const price: { gte?: number; lte?: number } = {};

      if (query.minPrice !== undefined) {
        price.gte = query.minPrice;
      }

      if (query.maxPrice !== undefined) {
        price.lte = query.maxPrice;
      }

      conditions.push({ price });
    }

    if (query.q) {
      conditions.push({
        OR: [
          {
            name: {
              contains: query.q,
              mode: 'insensitive',
            },
          },
          {
            description: {
              contains: query.q,
              mode: 'insensitive',
            },
          },
        ],
      });
    }

    if (cursor) {
      conditions.push(this.buildCursorWhere(cursor));
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      query.sort === ProductSort.PRICE_ASC
        ? [{ price: 'asc' }, { id: 'asc' }]
        : query.sort === ProductSort.PRICE_DESC
          ? [{ price: 'desc' }, { id: 'desc' }]
          : [{ createdAt: 'desc' }, { id: 'desc' }];

    const rows = await this.prisma.product.findMany({
      where: { AND: conditions },
      orderBy,
      take: query.limit + 1,
      select: productSelect,
    });

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;

    const last = data[data.length - 1];

    return {
      data,
      meta: {
        limit: query.limit,
        sort: query.sort,
        hasMore,
        nextCursor:
          hasMore && last ? this.encodeCursor(query.sort, last) : null,
      },
    };
  }

  private encodeCursor(
    sort: ProductSort,
    product: { id: string; price: number; createdAt: Date },
  ): string {
    const payload: CursorPayload =
      sort === ProductSort.NEWEST
        ? {
            v: 1,
            sort,
            id: product.id,
            createdAt: product.createdAt.toISOString(),
          }
        : {
            v: 1,
            sort,
            id: product.id,
            price: product.price,
          };

    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(
    value: string | undefined,
    sort: ProductSort,
  ): CursorPayload | null {
    if (!value) return null;

    try {
      const data = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      if (
        data.v !== 1 ||
        data.sort !== sort ||
        typeof data.id !== 'string' ||
        data.id.length === 0
      ) {
        throw new Error();
      }

      if (sort === ProductSort.NEWEST) {
        if (
          typeof data.createdAt !== 'string' ||
          Number.isNaN(Date.parse(data.createdAt))
        ) {
          throw new Error();
        }

        return {
          v: 1,
          sort,
          id: data.id,
          createdAt: data.createdAt,
        };
      }

      if (
        typeof data.price !== 'number' ||
        !Number.isSafeInteger(data.price) ||
        data.price < 0 ||
        data.price > 2147483647
      ) {
        throw new Error();
      }

      return {
        v: 1,
        sort,
        id: data.id,
        price: data.price,
      };
    } catch {
      throw new BadRequestException('Invalid cursor');
    }
  }

  private buildCursorWhere(cursor: CursorPayload): Prisma.ProductWhereInput {
    if (cursor.sort === ProductSort.NEWEST) {
      const createdAt = new Date(cursor.createdAt);

      return {
        OR: [
          { createdAt: { lt: createdAt } },
          {
            AND: [{ createdAt }, { id: { lt: cursor.id } }],
          },
        ],
      };
    }

    if (cursor.sort === ProductSort.PRICE_ASC) {
      return {
        OR: [
          { price: { gt: cursor.price } },
          {
            AND: [{ price: cursor.price }, { id: { gt: cursor.id } }],
          },
        ],
      };
    }

    return {
      OR: [
        { price: { lt: cursor.price } },
        {
          AND: [{ price: cursor.price }, { id: { lt: cursor.id } }],
        },
      ],
    };
  }

  //The id tie-breaker is essential: multiple products can have the same price or creation timestamp. The cursor includes both sort values so that records are not skipped simply because their primary sort values match.
}
