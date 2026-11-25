import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sourceConnections, tenants, withTenant, type Db } from '@s360/db';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { ENV, type Env } from '../config.js';
import { DB } from '../db/db.module.js';
import { IngestionService } from './ingestion.service.js';

const LOCK = 360_002;

/**
 * Polls every enabled source for changed projects and retries failed inbox events. A Postgres advisory lock makes
 * sure only one API instance polls at a time. Phase 4 moves durable timers to Temporal (ADR-002); polling is a
 * bounded job and stays here.
 */
@Injectable()
export class SourcePoller implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('SourcePoller');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject('PG_POOL') private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly ingestion: IngestionService,
  ) {}

  onApplicationBootstrap() {
    if (this.env.SOURCE_POLL_SECONDS > 0) {
      this.timer = setInterval(() => void this.tick(), this.env.SOURCE_POLL_SECONDS * 1000);
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
        const active = await this.db.select().from(tenants).where(eq(tenants.status, 'active'));
        for (const t of active) {
          const conns = await withTenant(this.db, t.id, (tx) =>
            tx.select().from(sourceConnections).where(eq(sourceConnections.enabled, true)),
          );
          for (const c of conns) {
            const r = await this.ingestion.sync(c, false);
            if (!r.ok) this.log.warn(`${t.slug}/${c.name}: ${r.errors.slice(0, 3).join('; ')}`);
          }
          await this.ingestion.retryFailed(t.id);
        }
      } finally {
        await client.query('select pg_advisory_unlock($1)', [LOCK]);
      }
    } catch (e) {
      this.log.error(`poll failed: ${(e as Error).message}`);
    } finally {
      client.release();
      this.running = false;
    }
  }
}
