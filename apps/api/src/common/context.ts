import type { Permission, Role } from '@s360/contracts';

/** Who is calling, resolved by the session guard. Every service takes its tenant from here, never from input. */
export interface RequestContext {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  userId: string;
  email: string;
  name: string;
  roles: Role[];
  permissions: Permission[];
  sessionId: string;
  correlationId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: RequestContext;
      correlationId?: string;
    }
  }
}
