import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { limits, type Env } from './config.js';

const CORRELATION = /^[A-Za-z0-9._-]{8,100}$/;

export async function createApp(env: Env): Promise<NestExpressApplication> {
  limits.login = env.LOGIN_RATE_LIMIT;
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    logger: env.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);
  app.disable('x-powered-by');
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
