import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductSearchDto } from './dto/product-search.dto';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'fixed-window',
    ip: { limit: 60, windowMs: 60_000 },
    user: { limit: 120, windowMs: 60_000 },
    redisFailure: 'open',
  })
  findAll(@Query() query: ProductSearchDto) {
    return this.service.searchPublic(query);
  }

  @Get(':slug')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'fixed-window',
    ip: { limit: 60, windowMs: 60_000 },
    user: { limit: 120, windowMs: 60_000 },
    redisFailure: 'open',
  })
  findBySlug(@Param('slug') slug: string) {
    return this.service.findPublicBySlug(slug);
  }
}
