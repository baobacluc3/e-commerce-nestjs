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
import { Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

import { RedisService } from '../redis/redis.service';
import {
  PRODUCT_CACHE_LOCK_TTL_MS,
  PRODUCT_CACHE_MAX_WAIT_ATTEMPTS,
  PRODUCT_CACHE_WAIT_MS,
  PRODUCT_DETAIL_TTL_SECONDS,
  PRODUCT_LIST_TTL_SECONDS,
  PRODUCT_LIST_VERSION_KEY,
  productDetailVersionKey,
} from './catalog-cache.constants';

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
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) { }

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
      const product = await this.prisma.product.create({
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

      await this.invalidateCatalogCaches([product.slug])
      return product
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
    const encodedSlug = encodeURIComponent(slug);

    return this.cacheAside(
      `catalog:products:detail:${encodedSlug}`,
      productDetailVersionKey(slug),
      PRODUCT_DETAIL_TTL_SECONDS,
      () => this.loadPublicProductBySlug(slug),
    );
  }

  private async loadPublicProductBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        slug,
        status: ProductStatus.PUBLISHED,
        deletedAt: null,
        category: {
          is: {
            isActive: true,
            deletedAt: null,
          },
        },
      },
      select: productSelect,
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async update(id: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: { id: true,slug:true },
    });

    if (!existing) throw new NotFoundException('Product not found');

    if (dto.categoryId !== undefined) {
      await this.ensureActiveCategory(dto.categoryId);
    }

    let updatedProduct
    try {
       updatedProduct =  await this.prisma.product.update({
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
    await this.invalidateCatalogCaches([existing.slug,updatedProduct.slug])
    return updatedProduct
  }

  async softDelete(id: string) {
  const existing = await this.prisma.product.findFirst({
    where: { id, deletedAt: null },
    select: { slug: true },
  });

  if (!existing) {
    throw new NotFoundException('Product not found');
  }

  const result = await this.prisma.product.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  if (result.count === 0) {
    throw new NotFoundException('Product not found');
  }

  await this.invalidateCatalogCaches([existing.slug]);

  return { message: 'Product deleted' };
}

  async searchPublic(query: ProductSearchDto) {
    // Explicit field order creates a stable cache key.
    const filters = {
      categoryId: query.categoryId ?? null,
      minPrice: query.minPrice ?? null,
      maxPrice: query.maxPrice ?? null,
      q: query.q?.trim() ?? null,
      sort: query.sort ?? ProductSort.NEWEST,
      limit: query.limit ?? 20,
      cursor: query.cursor ?? null,
    };

    const hash = createHash('sha256')
      .update(JSON.stringify(filters))
      .digest('hex');

    return this.cacheAside(
      `catalog:products:list:${hash}`,
      PRODUCT_LIST_VERSION_KEY,
      PRODUCT_LIST_TTL_SECONDS,
      () => this.search(query, true),
    );
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


  //The id tie-breaker is essential: multiple products can have the same price or creation timestamp. The cursor includes both sort values so that records are not skipped
  // simply because their primary sort values match.

  private async readCached<T>(key: string): Promise<{ hit: true, value: T } | { hit: false }> {
    const raw = await this.redis.get(key);

    if (raw === null) {
      return { hit: false };
    }

    try {
      return {
        hit: true,
        value: JSON.parse(raw) as T
      }
    } catch {
      return {
        hit: false
      }
    }
  }



  private async cacheAside<T>(
    logicalKey: string,
    versionKey: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    let version: string;

    // Cache failure must not make the product API unavailable.
    try {
      version = (await this.redis.get(versionKey)) ?? '0';
    } catch {
      return loader();
    }

    const cacheKey = `${logicalKey}:v${version}`;
    const lockKey = `${cacheKey}:lock`;

    try {
      const cached = await this.readCached<T>(cacheKey);

      if (cached.hit) {
        return cached.value;
      }
    } catch {
      return loader();
    }

    const lockToken = randomUUID();

    for (
      let attempt = 0;
      attempt < PRODUCT_CACHE_MAX_WAIT_ATTEMPTS;
      attempt++
    ) {
      let acquired: boolean;

      try {
        acquired = await this.redis.acquireLock(
          lockKey,
          lockToken,
          PRODUCT_CACHE_LOCK_TTL_MS,
        );
      } catch {
        return loader();
      }

      if (acquired) {
        try {
          // Another request may have populated the cache
          // just before we acquired the lock.
          try {
            const cached = await this.readCached<T>(cacheKey);

            if (cached.hit) {
              return cached.value;
            }
          } catch {
            return loader();
          }

          // Only the lock owner loads the database.
          const value = await loader();

          // Avoid caching stale data if a product changed while
          // product while the database query was running.
          try {
            const currentVersion =
              (await this.redis.get(versionKey)) ?? '0';

            if (currentVersion === version) {
              await this.redis.set(
                cacheKey,
                JSON.stringify(value),
                ttlSeconds,
              );
            }
          } catch (error) {
            this.logger.warn(
              `Could not populate cache: ${error instanceof Error ? error.message : 'Unknown error'
              }`,
            );
          }

          return value;
        } finally {
          try {
            await this.redis.releaseLock(lockKey, lockToken);
          } catch (error) {
            this.logger.warn(
              `Could not release cache lock: ${error instanceof Error ? error.message : 'Unknown error'
              }`,
            );
          }
        }
      }

      // Another request owns the lock. Wait for its result.
      await new Promise((resolve) =>
        setTimeout(resolve, PRODUCT_CACHE_WAIT_MS),
      );

      try {
        const currentVersion =
          (await this.redis.get(versionKey)) ?? '0';

        if (currentVersion !== version) {
          // Data was invalidated during the wait.
          return loader();
        }

        const cached = await this.readCached<T>(cacheKey);

        if (cached.hit) {
          return cached.value;
        }
      } catch {
        return loader();
      }
    }

    // Bounded waiting: do not block an API request indefinitely.
    return loader();
  }

  private async invalidateCatalogCaches(slugs: string[]) {
    const versionKeys = [
      ...new Set(slugs.filter(Boolean)),
    ].map(productDetailVersionKey);

    try {
      await Promise.all([
        ...versionKeys.map((key) => this.redis.increment(key)),
        this.redis.increment(PRODUCT_LIST_VERSION_KEY),
      ]);
    } catch (error) {
      this.logger.error(
        `Catalog cache invalidation failed: ${error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }
}
