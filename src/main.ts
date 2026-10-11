import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  // Comma-separated allow-list, e.g. CORS_ORIGINS=https://shop.example.com
  const origins = process.env.CORS_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins?.length) {
    app.enableCors({ origin: origins });
  }

  // Behind a reverse proxy/load balancer, uncomment so req.ip (and rate
  // limiting) use the real client IP:
  // app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableShutdownHooks(); // makes PrismaService.onModuleDestroy actually run

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();