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

// ───────────────────────────── Phase 2: project ingestion ─────────────────────────────
// Supply360 stores projects, markets and events only: no respondent identities, answers, health data or prices.

export const sourceKind = pgEnum('source_kind', ['samptrek', 'sampcloud']);
export const adapterMode = pgEnum('adapter_mode', ['fixture', 'live']);
export const lifecycle = pgEnum('project_lifecycle', ['imported', 'ready', 'live', 'paused', 'source_hold', 'closed']);

export const sourceConnections = pgTable(
  'source_connections',
  {
    id: id(),
    tenantId: tenantId(),
    kind: sourceKind('kind').notNull(),
    mode: adapterMode('mode').notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url'),
    /** Sealed `pjx_` key; never returned by the API. */
    apiKeySealed: text('api_key_sealed'),
    /** Sealed webhook signing secret (`whsec_…`), shown once at creation. */
    webhookSecretSealed: text('webhook_secret_sealed').notNull(),
    vendorCode: text('vendor_code').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** `updatedSince` for the next poll; null means the next sync is a full backfill. */
    pollCheckpoint: timestamp('poll_checkpoint', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncResult: jsonb('last_sync_result'),
    /** Signature failures are counted, not stored, so a flood cannot fill the database. */
    rejectedCount: integer('rejected_count').notNull().default(0),
    lastRejectedAt: timestamp('last_rejected_at', { withTimezone: true }),
    lastRejectedReason: text('last_rejected_reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('source_connections_tenant').on(t.tenantId)],
);

export const projects = pgTable(
  'projects',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => sourceConnections.id, { onDelete: 'restrict' }),
    source: sourceKind('source').notNull(),
    sourceProjectId: text('source_project_id').notNull(),
    projectCode: text('project_code').notNull(),
    name: text('name').notNull(),
    clientName: text('client_name'),
    projectManagerName: text('project_manager_name'),
    projectType: text('project_type'),
    category: text('category'),
    sourceStatus: text('source_status').notNull(),
    lifecycle: lifecycle('lifecycle').notNull().default('imported'),
    fieldStartAt: timestamp('field_start_at', { withTimezone: true }),
    fieldEndAt: timestamp('field_end_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    contentHash: text('content_hash').notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_source_ref').on(t.tenantId, t.source, t.sourceProjectId),
    index('projects_tenant_updated').on(t.tenantId, t.updatedAt.desc()),
  ],
);

/** Every distinct content of a project, so a person can see what changed at the source and when. */
export const projectVersions = pgTable(
  'project_versions',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    via: text('via').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_versions_n').on(t.projectId, t.version)],
);

export const projectMarkets = pgTable(
  'project_markets',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    countryCode: text('country_code').notNull(),
    language: text('language'),
    targetGroup: text('target_group'),
    sourceStatus: text('source_status').notNull(),
    loiMinutes: integer('loi_minutes'),
    irPercent: integer('ir_percent'),
    targetCompletes: integer('target_completes').notNull().default(0),
    completes: integer('completes').notNull().default(0),
    /** Supply360's own vendor link in this market at the source (other vendors are not stored). */
    vendorLinkId: text('vendor_link_id'),
    vendorLinkStatus: text('vendor_link_status'),
    vendorTarget: integer('vendor_target'),
    vendorCompletes: integer('vendor_completes'),
    /** The entry link a person approved; SampTrek never returns vendor entry links through its API. */
    entryUrl: text('entry_url'),
    entryApprovedBy: uuid('entry_approved_by'),
    entryApprovedAt: timestamp('entry_approved_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_markets_cc').on(t.projectId, t.countryCode)],
);

/** Inbox: one row per source event id, so a retried or duplicated delivery is processed once. */
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => sourceConnections.id, { onDelete: 'restrict' }),
    source: sourceKind('source').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    deliveryId: text('delivery_id'),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** pending → processed | ignored | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    error: text('error'),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('inbound_events_dedup').on(t.tenantId, t.source, t.eventId),
    index('inbound_events_recent').on(t.tenantId, t.receivedAt.desc()),
  ],
);

/** Respondent arrivals on Supply360's redirect endpoints. Unverified until the S2S callback agrees (Phase 5). */
export const redirectHits = pgTable(
  'redirect_hits',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    outcome: text('outcome').notNull(),
    /** The opaque reference Supply360 issued; never a name, email or panel id. */
    respondentRef: text('respondent_ref'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('redirect_hits_project').on(t.tenantId, t.projectId, t.receivedAt.desc())],
);
