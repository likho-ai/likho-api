import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.guard.js';
import { BusService } from '../bus/bus.service.js';
import { DbService } from '../db/db.module.js';
import { LiveService } from '../live/live.service.js';

@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly bus: BusService,
    private readonly live: LiveService,
  ) {}

  @Public()
  @Get('healthz')
  alive(): string {
    return 'ok\n';
  }

  @Public()
  @Get('readyz')
  async ready(@Res() res: Response): Promise<void> {
    const checks = await Promise.allSettled([this.db.ping(), this.live.ping()]);
    const ok = checks.every((c) => c.status === 'fulfilled' && c.value) && this.bus.connected;
    res
      .status(ok ? 200 : 503)
      .type('text/plain')
      .send(ok ? 'ready\n' : 'not ready\n');
  }
}
