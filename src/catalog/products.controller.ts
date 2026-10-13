import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductSearchDto } from './dto/product-search.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  findAll(@Query() query: ProductSearchDto) {
    return this.service.searchPublic(query);
  }

  @Get(':slug')
  findBySlug(@Param('slug') slug: string) {
    return this.service.findPublicBySlug(slug);
  }
}
