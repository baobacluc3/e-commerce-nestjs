import { Controller, Get, Param } from '@nestjs/common';
import { CategoriesService } from './categories.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get()
  findAll() {
    return this.service.findPublic();
  }

  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.service.findPublicBySlug(slug);
  }
}
