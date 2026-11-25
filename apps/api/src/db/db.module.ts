import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, createPool, type Db } from '@s360/db';
import type pg from 'pg';
import { ENV, type Env } from '../config.js';

export const DB = Symbol('DB');

@Injectable()
export class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject('PG_POOL') private readonly pool: pg.Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: 'PG_POOL', inject: [ENV], useFactory: (env: Env) => createPool(env.DATABASE_URL, 20) },
    { provide: DB, inject: ['PG_POOL'], useFactory: (pool: pg.Pool): Db => createDb(pool) },
    PoolCloser,
  ],
  exports: [DB, 'PG_POOL'],
})
export class DbModule {}
