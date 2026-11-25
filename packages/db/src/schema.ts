import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  bigint,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Phase 1 schema. Every table except `tenants` carries `tenant_id` and is protected by row-level security
 * (migration 0001_rls.sql): the API connects as `s360_app`, which can only see rows of the tenant set in
 * `app.tenant_id` for the current transaction.
 */
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);

export const tenants = pgTable('tenants', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: tenantId(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    roles: text('roles').array().notNull(),
    status: userStatus('status').notNull().default('active'),
    /** AES-256-GCM sealed TOTP secret; null until enrolment starts. */
    totpSecret: text('totp_secret'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** Last accepted TOTP time step, so a code can be used once. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    failedSignIns: integer('failed_sign_ins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_tenant_email').on(t.tenantId, t.email), index('users_tenant').on(t.tenantId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** password: MFA still owed; full: signed in. */
    stage: text('stage').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user').on(t.tenantId, t.userId)],
);

/** Append-only (UPDATE and DELETE revoked from s360_app in 0001_rls.sql). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    tenantId: tenantId(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    reason: text('reason'),
    correlationId: text('correlation_id'),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [index('audit_tenant_at').on(t.tenantId, t.at.desc(), t.id.desc())],
);

export const settings = pgTable(
  'settings',
  {
    id: id(),
    tenantId: tenantId(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('settings_tenant_key').on(t.tenantId, t.key)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user').on(t.tenantId, t.userId, t.createdAt.desc())],
);
