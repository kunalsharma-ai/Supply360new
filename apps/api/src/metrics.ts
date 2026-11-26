import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import client from 'prom-client';
import { Public } from './common/decorators.js';
import { problem } from './common/problem.js';
import { ENV, type Env } from './config.js';

/** Prometheus metrics. Labels are the route pattern, never a raw path, so ids and tokens never become label values. */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 's360_' });
export const httpRequests = new client.Counter({
  name: 's360_http_requests_total',
  help: 'HTTP requests by method, route pattern and status',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});
export const httpDuration = new client.Histogram({
  name: 's360_http_request_duration_seconds',
  help: 'HTTP request duration by method and route pattern',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
export const schedulerRuns = new client.Counter({
  name: 's360_scheduler_runs_total',
  help: 'Scheduler passes by result',
  labelNames: ['result'] as const,
  registers: [registry],
});
export const schedulerDuration = new client.Histogram({
  name: 's360_scheduler_duration_seconds',
  help: 'Scheduler pass duration',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});
export const schedulerLastSuccess = new client.Gauge({
  name: 's360_scheduler_last_success_timestamp_seconds',
  help: 'When the scheduler last finished a pass without a tenant error',
  registers: [registry],
});

/**
 * Express middleware: counts every response, including ones a guard or the throttler refused. The label is the
 * matched route pattern (Express sets req.route during dispatch), or "unmatched" for 404s, so raw paths never leak.
 */
export function httpMetrics(req: Request, res: Response, next: () => void): void {
  const end = httpDuration.startTimer();
  res.once('finish', () => {
    const route = (req.route?.path as string | undefined) ?? 'unmatched';
    end({ method: req.method, route });
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

const digest = (s: string) => createHash('sha256').update(s).digest();

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Public()
  @Get()
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    if (!this.env.METRICS_TOKEN) throw problem.notFound();
    const given = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqual(digest(given), digest(this.env.METRICS_TOKEN))) throw problem.unauthorized('bad_token', 'Metrics need the bearer token');
    res.setHeader('content-type', registry.contentType);
    res.setHeader('cache-control', 'no-store');
    res.end(await registry.metrics());
  }
}
