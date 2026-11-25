import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@s360/contracts';
import type { Request } from 'express';
import { MFA_PENDING_OK, PERMISSIONS, PUBLIC, SIGNED_INBOUND } from '../common/decorators.js';
import { problem } from '../common/problem.js';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE } from './session-token.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * One guard for every route: CSRF header on writes, session, MFA stage, then permissions.
 * The custom header forces a CORS preflight, so another site cannot send a write with the person's cookie.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const req = ec.switchToHttp().getRequest<Request>();
    const targets = [ec.getHandler(), ec.getClass()];
    // The handler verifies the signature on the raw body before doing anything.
    if (this.reflector.getAllAndOverride<boolean>(SIGNED_INBOUND, targets)) return true;
    if (!SAFE.has(req.method) && req.get('x-s360-csrf') !== '1') {
      throw problem.forbidden('csrf_header_missing', 'Missing x-s360-csrf header');
    }
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) throw problem.unauthorized();
    const ctx = await this.auth.resolve(token, req.correlationId ?? 'none');
    if (!ctx) throw problem.unauthorized('session_invalid', 'Your session has ended. Sign in again.');
    const { stage, ...rest } = ctx;
    req.ctx = rest;
    if (stage !== 'full' && !this.reflector.getAllAndOverride<boolean>(MFA_PENDING_OK, targets)) {
      throw problem.unauthorized('mfa_required', 'Enter the code from your authenticator app');
    }
    const needed = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS, targets) ?? [];
    const have = new Set(rest.permissions);
    const missing = needed.filter((p) => !have.has(p));
    if (missing.length) throw problem.forbidden('permission_denied', `Needs ${missing.join(', ')}`);
    return true;
  }
}
