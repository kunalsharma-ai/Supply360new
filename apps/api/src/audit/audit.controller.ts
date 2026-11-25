import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermissions } from '../common/decorators.js';
import type { RequestContext } from '../common/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuditService } from './audit.service.js';

const Q = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}
  @Get()
  @RequirePermissions('audit.read')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    return this.audit.list(ctx, q.cursor, q.limit);
  }
}
