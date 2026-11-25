import { z } from 'zod';
import { Permission, Role } from './roles.js';

export const LoginRequest = z.object({
  tenant: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const TotpCode = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpCode = z.infer<typeof TotpCode>;

/** `mfa_setup`: enrol an authenticator. `mfa_challenge`: enter a code. `session`: signed in. */
export const LoginResponse = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('mfa_setup'), otpauthUri: z.string() }),
  z.object({ stage: z.literal('mfa_challenge') }),
  z.object({ stage: z.literal('session') }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const Me = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string(), name: z.string() }),
  tenant: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() }),
  roles: z.array(Role),
  permissions: z.array(Permission),
});
export type Me = z.infer<typeof Me>;

export const PasswordPolicy = z
  .string()
  .min(14, 'At least 14 characters')
  .max(256)
  .refine((v) => /[a-z]/i.test(v) && /\d/.test(v), 'Use letters and numbers');
