import { z } from 'zod';
import { PasswordPolicy } from './auth.js';
import { Role } from './roles.js';

export const UserCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(2).max(120),
  roles: z.array(Role).min(1),
  /** Initial password; the person enrols MFA at first sign-in. */
  password: PasswordPolicy,
});
export type UserCreate = z.infer<typeof UserCreate>;

export const UserRolesUpdate = z.object({ roles: z.array(Role).min(1) });
export const UserStatusUpdate = z.object({
  status: z.enum(['active', 'disabled']),
  reason: z.string().trim().min(3).max(500),
});

export const UserSummary = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  roles: z.array(Role),
  status: z.enum(['active', 'disabled']),
  mfaEnabled: z.boolean(),
  lastSignInAt: z.string().nullable(),
  createdAt: z.string(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const AuditEvent = z.object({
  id: z.string().uuid(),
  at: z.string(),
  actorId: z.string().uuid().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  reason: z.string().nullable(),
  correlationId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/** Tenant-level settings Phase 1 owns. Later phases add their own keys. */
export const TenantSettings = z.object({
  displayName: z.string().trim().min(2).max(120),
  timezone: z.string().min(1).max(64),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  defaultTheme: z.enum(['midnight', 'arctic', 'violet', 'emerald']),
  /** New deployments start manual (spec §7). */
  defaultExecutionMode: z.literal('manual'),
});
export type TenantSettings = z.infer<typeof TenantSettings>;
