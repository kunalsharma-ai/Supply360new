import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@s360/contracts';
import type { Request } from 'express';
import type { RequestContext } from './context.js';

export const PUBLIC = 'public';
export const PERMISSIONS = 'permissions';
/** Routes reachable with a password-only session (MFA still owed). */
export const MFA_PENDING_OK = 'mfa_pending_ok';

/** Server-to-server routes that prove themselves with a signature (webhooks): no session, no CSRF header. */
export const SIGNED_INBOUND = 'signed_inbound';

export const Public = () => SetMetadata(PUBLIC, true);
export const SignedInbound = () => SetMetadata(SIGNED_INBOUND, true);
export const MfaPendingOk = () => SetMetadata(MFA_PENDING_OK, true);
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMISSIONS, p);

export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext): RequestContext => {
  const req = ec.switchToHttp().getRequest<Request>();
  if (!req.ctx) throw new Error('No request context: route is missing the session guard');
  return req.ctx;
});
