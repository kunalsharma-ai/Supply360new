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
  /** During a key rotation only: the old key, so values sealed with it still open until `rotate:reseal` has run. */
  FIELD_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'FIELD_ENCRYPTION_KEY_PREVIOUS must be 32 bytes, base64')
    .optional(),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Sign-in and MFA attempts per minute per client address. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(10),
  API_RATE_LIMIT: z.coerce.number().int().min(1).max(10_000_000).default(300),
  /** Where respondents and SampTrek reach this API (redirect and webhook URLs). Defaults to WEB_ORIGIN. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Poll each source every N seconds for changed projects; 0 turns the poller off. */
  SOURCE_POLL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  /** Run the invitation scheduler (modes, due batches, reminders, click reports) every N seconds; 0 turns it off. */
  DISPATCH_TICK_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  /** The scheduler reconciles each live project against SampTrek's sessions every N minutes; 0 turns it off. */
  RECONCILE_MINUTES: z.coerce.number().int().min(0).max(1440).default(30),
  /** Key for participation link tokens. Defaults to a key derived from SESSION_SECRET. */
  PARTICIPATION_TOKEN_SECRET: z.string().min(32).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Bearer token for GET /api/v1/metrics (Prometheus). Unset turns the endpoint off. */
  METRICS_TOKEN: z.string().min(32, 'METRICS_TOKEN must be at least 32 characters').optional(),
  /** `json` writes one JSON object per log line (default in production); `text` is for local work. */
  LOG_FORMAT: z.enum(['json', 'text']).optional(),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    const problems = productionProblems(parsed.data);
    if (problems.length) throw new Error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return parsed.data;
}

/** Settings that are fine on a laptop but unsafe in production. The API refuses to start with any of them. */
export function productionProblems(e: Env): string[] {
  const out: string[] = [];
  const https = (u: string) => new URL(u).protocol === 'https:';
  if (!e.COOKIE_SECURE) out.push('COOKIE_SECURE must be true');
  if (!https(e.WEB_ORIGIN)) out.push('WEB_ORIGIN must be https');
  if (e.PUBLIC_BASE_URL && !https(e.PUBLIC_BASE_URL)) out.push('PUBLIC_BASE_URL must be https');
  for (const k of ['SESSION_SECRET', 'FIELD_ENCRYPTION_KEY', 'DATABASE_URL', 'PARTICIPATION_TOKEN_SECRET', 'METRICS_TOKEN'] as const)
    if (String(e[k] ?? '').includes('CHANGE-ME')) out.push(`${k} still holds the example value`);
  const dbUser = decodeURIComponent(new URL(e.DATABASE_URL).username);
  // The owner role bypasses row-level security; requests must run as the s360_app member role.
  if (dbUser === 'postgres' || (e.DATABASE_ADMIN_URL && dbUser === decodeURIComponent(new URL(e.DATABASE_ADMIN_URL).username)))
    out.push('DATABASE_URL must use the API login role, not the owner role');
  // Without it, participation links are signed with SESSION_SECRET and rotating that would break every sent link.
  if (!e.PARTICIPATION_TOKEN_SECRET) out.push('PARTICIPATION_TOKEN_SECRET must be set, separate from SESSION_SECRET');
  if (e.FIELD_ENCRYPTION_KEY_PREVIOUS === e.FIELD_ENCRYPTION_KEY) out.push('FIELD_ENCRYPTION_KEY_PREVIOUS must differ from FIELD_ENCRYPTION_KEY');
  if (e.LOGIN_RATE_LIMIT > 30) out.push('LOGIN_RATE_LIMIT above 30 a minute is a load-test setting');
  return out;
}

export const ENV = Symbol('ENV');

/** Read by the @Throttle resolvers on the sign-in routes; set once by createApp. */
export const limits = { login: 10 };
