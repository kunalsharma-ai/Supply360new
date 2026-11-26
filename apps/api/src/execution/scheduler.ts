import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { tenants, type Db } from '@s360/db';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { FieldworkService } from '../fieldwork/fieldwork.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { ExecutionService } from './execution.service.js';

const LOCK = 360_004;

/**
 * Runs the execution modes, due batches, reminders, click and outcome reports and reward hand-offs every DISPATCH_TICK_SECONDS. A Postgres
 * advisory lock keeps it to one API instance at a time; every step is also safe to run twice (row locks, unique
 * indexes and idempotency keys), so a second runner could never send twice.
 */
@Injectable()
export class DispatchScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('DispatchScheduler');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject('PG_POOL') private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly exec: ExecutionService,
    private readonly fieldwork: FieldworkService,
    private readonly intelligence: IntelligenceService,
    private readonly reports: ReportsService,
  ) {}

  onApplicationBootstrap() {
    if (this.env.DISPATCH_TICK_SECONDS > 0) {
      this.timer = setInterval(() => void this.tick(), this.env.DISPATCH_TICK_SECONDS * 1000);
      this.timer.unref();
    }
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [LOCK]);
      if (!rows[0]?.ok) return;
      try {
        for (const t of await this.db.select().from(tenants).where(eq(tenants.status, 'active'))) {
          try {
            await this.exec.tick(t.id);
            await this.fieldwork.tick(t.id);
            await this.fieldwork.autoReconcile(t.id, this.env.RECONCILE_MINUTES);
            await this.intelligence.tick(t.id);
            await this.reports.tick(t.id);
          } catch (e) {
            this.log.error(`${t.slug}: ${(e as Error).message}`);
          }
        }
      } finally {
        await client.query('select pg_advisory_unlock($1)', [LOCK]);
      }
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
    } finally {
      client.release();
      this.running = false;
    }
  }
}
