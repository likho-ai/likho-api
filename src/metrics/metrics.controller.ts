import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.guard.js';
import { MetricsService } from './metrics.service.js';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Prometheus text; open like /healthz (nothing in it is a secret, and the gateway does not route it). */
  @Public()
  @Get('metrics')
  scrape(@Req() request: Request, @Res() response: Response): void {
    this.metrics.scrape(request, response);
  }
}
