import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'fixed-window',
    ip: { limit: 60, windowMs: 60_000 },
    redisFailure: 'open',
  })
  findAll() {
    return this.service.findPublic();
  }

  @Get(':slug')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    algorithm: 'fixed-window',
    ip: { limit: 60, windowMs: 60_000 },
    redisFailure: 'open',
  })
  findBySlug(@Param('slug') slug: string) {
    return this.service.findPublicBySlug(slug);
  }
}
