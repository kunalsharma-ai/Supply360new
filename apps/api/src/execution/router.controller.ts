import { Controller, Get, Head, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators.js';
import { ExecutionService } from './execution.service.js';

/**
 * The survey router: every participation link points here. The token is opaque (no personal data), so the URL
 * reveals nothing, and the destination is the entry link a person approved for the market, never anything
 * from the request, so this cannot be an open redirect.
 */
@Controller('i')
export class RouterController {
  constructor(private readonly exec: ExecutionService) {}

  @Get(':tenant/:token')
  @Head(':tenant/:token')
  @Public()
  async open(
    @Param('tenant') tenant: string,
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const r = await this.exec.route(tenant, token, req.method, req.headers['user-agent']);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-robots-tag', 'noindex');
    res.redirect(302, r.location);
  }
}
