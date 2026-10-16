import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { performance } from 'node:perf_hooks';

import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const startedAt = performance.now();
    if (req.path === '/metrics') return next();

    res.on('finish', () => {
      const route = req.route?.path
        ? `${req.baseUrl ?? ''}${req.route.path}`
        : 'unmatched';
      this.metrics.observeRequest(
        req.method,
        route,
        res.statusCode,
        (performance.now() - startedAt) / 1000,
      );
    });

    next();
  }
}
