import { Controller, Get, HttpCode, Inject, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SignedInbound } from '../common/decorators.js';
import { ENV, type Env } from '../config.js';
import { FieldworkService } from './fieldwork.service.js';

/**
 * SampTrek's vendor S2S callback (samptrek callbacks.service.ts): a GET to the URL template Supply360 gave it,
 * with `X-Projexa-Timestamp`, `X-Projexa-Signature` (hex HMAC-SHA256 of `{ts}.{full URL}.` with the vendor
 * callback secret) and `X-Idempotency-Key`. SampTrek retries 5xx/408/429, so a bad signature is a permanent 401
 * and a duplicate is a 200.
 */
@Controller('s2s/samptrek')
export class S2sController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly fw: FieldworkService,
  ) {}

  @Get(':tenant/:connection')
  @HttpCode(200)
  @SignedInbound()
  receive(@Param('tenant') tenant: string, @Param('connection') connection: string, @Req() req: Request) {
    // The URL SampTrek signed is the public one, so it is rebuilt from the public base, not the Host header.
    const base = this.env.PUBLIC_BASE_URL ?? this.env.WEB_ORIGIN;
    const q = req.query as Record<string, unknown>;
    return this.fw.callback(
      tenant,
      connection,
      `${base}${req.originalUrl}`,
      {
        timestamp: req.get('x-projexa-timestamp'),
        signature: req.get('x-projexa-signature'),
        idempotencyKey: req.get('x-idempotency-key'),
      },
      {
        uid: typeof q.uid === 'string' ? q.uid : typeof q.respondent_uid === 'string' ? q.respondent_uid : undefined,
        status: typeof q.status === 'string' ? q.status : undefined,
      },
    );
  }
}
