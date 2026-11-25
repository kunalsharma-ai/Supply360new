import { Controller, Get, Inject } from '@nestjs/common';
import type pg from 'pg';
import { Public } from '../common/decorators.js';

@Controller('health')
export class HealthController {
  constructor(@Inject('PG_POOL') private readonly pool: pg.Pool) {}
  @Public()
  @Get()
  async health() {
    let database: 'up' | 'down' = 'up';
    try {
      await this.pool.query('select 1');
    } catch {
      database = 'down';
    }
    return { status: database === 'up' ? 'ok' : 'degraded', database, version: '0.1.0' };
  }
}
