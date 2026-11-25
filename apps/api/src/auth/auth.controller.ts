import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LoginRequest, TotpCode, type Me } from '@s360/contracts';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { ENV, limits, type Env } from '../config.js';
import type { RequestContext } from '../common/context.js';
import { Ctx, MfaPendingOk, Public } from '../common/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuthService, type Issued } from './auth.service.js';
import { SESSION_COOKIE } from './session-token.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private setCookie(res: Response, i: Issued) {
    res.cookie(SESSION_COOKIE, i.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.env.COOKIE_SECURE,
      path: '/',
      maxAge: i.maxAgeSeconds * 1000,
    });
  }

  private client(req: Request) {
    return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null, correlationId: req.correlationId ?? 'none' };
  }

  @Public()
  @Throttle({ default: { limit: () => limits.login, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginRequest)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { response, issued } = await this.auth.login(body, this.client(req));
    this.setCookie(res, issued);
    return response;
  }

  @MfaPendingOk()
  @Throttle({ default: { limit: () => limits.login, ttl: 60_000 } })
  @Post('mfa')
  @HttpCode(200)
  async mfa(
    @Ctx() ctx: RequestContext,
    @Body(new ZodPipe(TotpCode)) body: TotpCode,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.setCookie(res, await this.auth.completeMfa(ctx, body.code, this.client(req)));
    return { stage: 'session' as const };
  }

  @MfaPendingOk()
  @Post('logout')
  @HttpCode(204)
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@Ctx() ctx: RequestContext): Me {
    return {
      user: { id: ctx.userId, email: ctx.email, name: ctx.name },
      tenant: { id: ctx.tenantId, slug: ctx.tenantSlug, name: ctx.tenantName },
      roles: ctx.roles,
      permissions: ctx.permissions,
    };
  }
}
