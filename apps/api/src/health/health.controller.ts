import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type pg from 'pg';
import { Public } from '../common/decorators.js';

export const VERSION = process.env.S360_VERSION ?? '0.8.0';

/**
 * `/health/live`: the process answers (restart it if not). `/health/ready`: it can serve traffic, so the database
 * answers within 2 seconds (take it out of the load balancer if not). `/health` stays for older probes.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject('PG_POOL') private readonly pool: pg.Pool) {}

  private async database(): Promise<'up' | 'down'> {
    try {
      await Promise.race([
        this.pool.query('select 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
      ]);
      return 'up';
    } catch {
      return 'down';
    }
  }

  @Public()
  @Get()
  async health() {
    const database = await this.database();
    return { status: database === 'up' ? 'ok' : 'degraded', database, version: VERSION };
  }

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', version: VERSION, uptimeSeconds: Math.round(process.uptime()) };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const database = await this.database();
    if (database !== 'up') res.status(503);
    return { status: database === 'up' ? 'ready' : 'not_ready', database, version: VERSION };
  }
}
