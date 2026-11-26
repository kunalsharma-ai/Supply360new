import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { limits, type Env } from './config.js';
import { httpMetrics } from './metrics.js';

const CORRELATION = /^[A-Za-z0-9._-]{8,100}$/;

export async function createApp(env: Env): Promise<NestExpressApplication> {
  limits.login = env.LOGIN_RATE_LIMIT;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    logger: new ConsoleLogger({
      logLevels: env.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
      // One JSON object per line in production, for the log pipeline.
      json: (env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json',
      prefix: 'supply360-api',
    }),
    // Webhook signatures are checked against the exact bytes received (req.rawBody).
    rawBody: true,
  });
  app.set('trust proxy', env.TRUST_PROXY_HOPS ?? (env.NODE_ENV === 'production' ? 1 : false));
  app.disable('x-powered-by');
  app.use(httpMetrics);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cookieParser());
  app.use((req: import('express').Request, res: import('express').Response, next: () => void) => {
    const incoming = req.get('x-correlation-id');
    req.correlationId = incoming && CORRELATION.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  });
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ['content-type', 'x-s360-csrf', 'x-correlation-id'],
  });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  return app;
}
