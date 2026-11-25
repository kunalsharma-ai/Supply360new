import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { SignedInbound } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { IngestionService } from './ingestion.service.js';

/**
 * SampTrek event webhooks. SampTrek treats any 2xx as delivered and retries 5xx/408/429, so: a bad signature is a
 * permanent 401, a duplicate is a 200, and a processing failure is still a 200 (the event is safely in the inbox
 * and the poller retries it), which stops SampTrek from re-sending what we already hold.
 */
@Controller('webhooks/samptrek')
export class WebhookController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post(':tenant/:connection')
  @HttpCode(200)
  @SignedInbound()
  async receive(
    @Param('tenant') tenant: string,
    @Param('connection') connection: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!req.rawBody?.length) throw problem.badRequest('empty_body', 'Expected a JSON body');
    if (!/^[a-z0-9-]{2,63}$/.test(tenant)) throw problem.notFound();
    return this.ingestion.receive(
      tenant,
      connection,
      {
        timestamp: req.get('x-projexa-timestamp'),
        signature: req.get('x-projexa-signature'),
        delivery: req.get('x-projexa-delivery'),
      },
      req.rawBody,
      req.correlationId,
    );
  }
}
