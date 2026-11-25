import { z } from 'zod';

/** Every setting the API reads, validated once at start. `.env.example` documents each one. */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  /** Login role that is a member of s360_app (row-level security applies). */
  DATABASE_URL: z.string().url(),
  /** Owner role: migrations and tenant provisioning scripts only, never request handling. */
  DATABASE_ADMIN_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  /** 32-byte key, base64, for sealing TOTP secrets. */
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'FIELD_ENCRYPTION_KEY must be 32 bytes, base64'),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Sign-in and MFA attempts per minute per client address. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(10),
  API_RATE_LIMIT: z.coerce.number().int().min(1).max(10_000_000).default(300),
  /** Where respondents and SampTrek reach this API (redirect and webhook URLs). Defaults to WEB_ORIGIN. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Poll each source every N seconds for changed projects; 0 turns the poller off. */
  SOURCE_POLL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');

/** Read by the @Throttle resolvers on the sign-in routes; set once by createApp. */
export const limits = { login: 10 };
