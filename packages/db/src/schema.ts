import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
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
    /** Sealed secret SampTrek signs Supply360's vendor S2S callbacks with (SampTrek's vendor callbackSecret). */
    callbackSecretSealed: text('callback_secret_sealed'),
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
    /** Module 26: human_only, synthetic_qa_only or both_separate. Synthetic QA never adds to human counts. */
    qaMode: text('qa_mode').notNull().default('human_only'),
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

// ───────────────────────────── Phase 3: audience and quotas ─────────────────────────────
// Supply360 keeps MADP's pseudonymous references, counts and criteria only. Criteria never include health
// (special-category) attributes: the API refuses them before they reach MADP.

export const audienceConnections = pgTable(
  'audience_connections',
  {
    id: id(),
    tenantId: tenantId(),
    mode: adapterMode('mode').notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url'),
    clientId: text('client_id'),
    /** Sealed MADP client secret; never returned by the API. */
    secretSealed: text('secret_sealed'),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    lastCheckResult: jsonb('last_check_result'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('audience_connections_tenant').on(t.tenantId)],
);

/**
 * Quota cells per Supply360 vendor market. Cells come from SampTrek's quota API; a market without cells gets one
 * whole-market cell (`source_cell_id` = '_market'). A person maps each cell to MADP criteria and sets its cap.
 */
export const quotaCells = pgTable(
  'quota_cells',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    countryCode: text('country_code').notNull(),
    sourceCellId: text('source_cell_id').notNull(),
    groupName: text('group_name').notNull().default(''),
    name: text('name').notNull(),
    /** SampTrek's conditions as received (question ids and option ids, no answers). */
    conditions: jsonb('conditions').notNull(),
    conditionsHash: text('conditions_hash').notNull(),
    /** Whole-market target and completes at the source, across all vendors. */
    sourceTarget: integer('source_target').notNull(),
    sourceCompletes: integer('source_completes').notNull().default(0),
    isOpen: boolean('is_open').notNull().default(true),
    /** Gone at the source; kept so its history and reservations stay readable. */
    removed: boolean('removed').notNull().default(false),
    /** MADP criteria a person mapped; cleared when the source conditions change. */
    criteria: jsonb('criteria'),
    mappedBy: uuid('mapped_by'),
    mappedAt: timestamp('mapped_at', { withTimezone: true }),
    /** Supply360 completes needed in this cell (allocation). */
    allocationTarget: integer('allocation_target'),
    /** Most people Supply360 may hold for this cell at once. Null blocks reservations. */
    inviteCap: integer('invite_cap'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('quota_cells_source').on(t.projectId, t.countryCode, t.sourceCellId)],
);

/** One allocation mode per project. */
export const allocationPlans = pgTable('allocation_plans', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  mode: text('mode').notNull().default('proportional'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Saved audience criteria a person can reuse. */
export const audienceSegments = pgTable(
  'audience_segments',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    criteria: jsonb('criteria').notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('audience_segments_name').on(t.tenantId, t.name)],
);

/** Immutable record of what MADP returned for one selection: criteria, eligibility and the references picked. */
export const audienceSelections = pgTable(
  'audience_selections',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => quotaCells.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => audienceConnections.id, { onDelete: 'restrict' }),
    dataMode: text('data_mode').notNull(),
    criteria: jsonb('criteria').notNull(),
    eligible: integer('eligible'),
    returned: integer('returned').notNull(),
    excluded: jsonb('excluded').notNull(),
    refs: jsonb('refs').notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('audience_selections_project').on(t.tenantId, t.projectId, t.createdAt.desc())],
);

export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => quotaCells.id, { onDelete: 'cascade' }),
    selectionId: uuid('selection_id')
      .notNull()
      .references(() => audienceSelections.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => audienceConnections.id, { onDelete: 'restrict' }),
    /** MADP's reservation id. */
    externalId: text('external_id').notNull(),
    /** match (new people from MADP criteria) | recontact (people who took part before) */
    origin: text('origin').notNull().default('match'),
    /** active → released | expired */
    status: text('status').notNull().default('active'),
    requested: integer('requested').notNull(),
    held: integer('held').notNull(),
    refused: jsonb('refused').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [index('reservations_project').on(t.tenantId, t.projectId, t.createdAt.desc())],
);

/**
 * The references Supply360 holds right now. Unique per project, so one MADP reference (one panel membership) is
 * never held twice for a project; released and expired holds are deleted.
 */
export const reservedRefs = pgTable(
  'reserved_refs',
  {
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => quotaCells.id, { onDelete: 'cascade' }),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    panel: text('panel').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('reserved_refs_project_ref').on(t.projectId, t.ref),
    index('reserved_refs_cell').on(t.cellId, t.expiresAt),
  ],
);

// ───────────────────────────── Phase 4: invitations and execution modes ─────────────────────────────
// Invitations hold MADP references and MADP invitation ids only. Participation tokens are derived with an HMAC
// from the invitation id, so they are never stored and carry no personal data.

/** Per-project execution policy. Every change bumps the version, and batches record the version they ran under. */
export const executionPolicies = pgTable('execution_policies', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  mode: text('mode').notNull().default('manual'),
  batchSize: integer('batch_size').notNull(),
  dailyMax: integer('daily_max').notNull(),
  reviewIntervalMinutes: integer('review_interval_minutes').notNull(),
  quietStartHour: integer('quiet_start_hour').notNull(),
  quietEndHour: integer('quiet_end_hour').notNull(),
  timezone: text('timezone').notNull(),
  reminderOffsetsHours: jsonb('reminder_offsets_hours').notNull(),
  allowedPanels: jsonb('allowed_panels').notNull(),
  linkValidDays: integer('link_valid_days').notNull(),
  /** Flag a complete for review when its LOI is under this share of the expected LOI. Null: no speeder flag. */
  speederPercent: integer('speeder_percent'),
  /** Automatic mode stops proposing and asks a person when more than this share of a batch is refused. */
  escalateRefusalPercent: integer('escalate_refusal_percent').notNull(),
  /** Set when automatic mode escalated; it sends nothing new until a person saves the policy again. */
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalationReason: text('escalation_reason'),
  version: integer('version').notNull().default(1),
  lastReviewAt: timestamp('last_review_at', { withTimezone: true }),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Tenant-wide kill switch: while halted nothing is sent, scheduled or reminded, in any mode. */
export const executionControls = pgTable('execution_controls', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  halted: boolean('halted').notNull().default(false),
  reason: text('reason'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invitationBatches = pgTable(
  'invitation_batches',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => quotaCells.id, { onDelete: 'cascade' }),
    size: integer('size').notNull(),
    status: text('status').notNull(),
    mode: text('mode').notNull(),
    policyVersion: integer('policy_version').notNull(),
    /** person or system */
    origin: text('origin').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    reason: text('reason'),
    blockedReason: text('blocked_reason'),
    authorized: integer('authorized').notNull().default(0),
    refused: integer('refused').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('invitation_batches_project').on(t.tenantId, t.projectId, t.createdAt.desc()),
    index('invitation_batches_due').on(t.status, t.scheduledAt),
  ],
);

/** One invitation per MADP reference per project, whatever batch, mode or retry led to it. */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => quotaCells.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => invitationBatches.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    panel: text('panel').notNull(),
    countryCode: text('country_code').notNull(),
    madpInvitationId: text('madp_invitation_id').notNull(),
    status: text('status').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    /** Outbox: when MADP acknowledged the click event. Null with a click means it is still to be reported. */
    clickReportedAt: timestamp('click_reported_at', { withTimezone: true }),
    // Phase 5: derived from participation events, never set directly.
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** complete | terminate | quota_full | quality_fail | duplicate | security_reject | partial | technical_error */
    outcome: text('outcome'),
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),
    outcomeSource: text('outcome_source'),
    /** SampTrek's session id. */
    sessionRef: text('session_ref'),
    loiSeconds: integer('loi_seconds'),
    /** Final client decision from SampTrek: approved | rejected; null while pending. */
    approval: text('approval'),
    approvalAt: timestamp('approval_at', { withTimezone: true }),
    /** Outbox: when MADP acknowledged the current outcome. */
    outcomeReportedAt: timestamp('outcome_reported_at', { withTimezone: true }),
    /** Times a person invited this dropout again to finish the same survey (capped). */
    reinviteCount: integer('reinvite_count').notNull().default(0),
    lastReinvitedAt: timestamp('last_reinvited_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitations_click_outbox')
      .on(t.tenantId, t.clickedAt)
      .where(sql`click_reported_at is null and clicked_at is not null`),
    uniqueIndex('invitations_project_ref').on(t.projectId, t.ref),
    index('invitations_batch').on(t.batchId),
    /** Recontact searches past participants by when they took part, and reinvites list a project's dropouts. */
    index('invitations_participated').on(t.tenantId, t.outcomeAt.desc()),
    index('invitations_project_outcome').on(t.projectId, t.outcome),
  ],
);

export const reminderJobs = pgTable(
  'reminder_jobs',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** pending → sent | cancelled | skipped | blocked */
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('reminder_jobs_attempt').on(t.invitationId, t.attempt),
    index('reminder_jobs_due').on(t.status, t.dueAt),
  ],
);

/** Every hand-off to the delivery channel, once per idempotency key, so a retry never sends twice. */
export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** accepted | unavailable */
    status: text('status').notNull(),
    detail: text('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('delivery_attempts_key').on(t.tenantId, t.idempotencyKey)],
);

/** What the survey router did with each participation link: click, prefetch by a link scanner, or refusal. */
export const routerEvents = pgTable(
  'router_events',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id').references(() => invitations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('router_events_recent').on(t.tenantId, t.at.desc())],
);

// ───────────────────────────── Phase 5: participation, quality, reconciliation, rewards ─────────────────────────────

/**
 * Append-only participation events from verified sources: SampTrek's signed S2S callbacks, its sessions API
 * (reconciliation) and Supply360's own router. One row per dedupe key, so a retry or replay is never counted twice.
 */
export const participationEvents = pgTable(
  'participation_events',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** samptrek_callback | samptrek_sessions | router */
    source: text('source').notNull(),
    verified: boolean('verified').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    dedupeKey: text('dedupe_key').notNull(),
    sessionRef: text('session_ref'),
    /** What the derivation did with it: applied | ignored (and why) | conflict. */
    effect: text('effect').notNull(),
    detail: jsonb('detail'),
  },
  (t) => [
    uniqueIndex('participation_events_key').on(t.tenantId, t.dedupeKey),
    index('participation_events_project').on(t.tenantId, t.projectId, t.receivedAt.desc()),
    index('participation_events_invitation').on(t.invitationId, t.occurredAt),
  ],
);

/** Reviewable quality flags. A flag never rejects anyone by itself: a person accepts or dismisses it. */
export const qualityFlags = pgTable(
  'quality_flags',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    detail: jsonb('detail').notNull(),
    /** open | accepted | dismissed */
    status: text('status').notNull().default('open'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewReason: text('review_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('quality_flags_once').on(t.invitationId, t.kind),
    index('quality_flags_open').on(t.tenantId, t.status, t.createdAt.desc()),
  ],
);

/** One reconciliation of a project against SampTrek's sessions: counts and the differences found. */
export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    summary: jsonb('summary').notNull(),
    differences: jsonb('differences').notNull(),
    startedBy: uuid('started_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('reconciliation_runs_project').on(t.tenantId, t.projectId, t.startedAt.desc())],
);

/**
 * Reward events: one per client-approved complete, handed to MADP with an idempotency key. Supply360 never credits
 * a wallet; the panel's own ledger does, after MADP acknowledges.
 */
export const rewardEvents = pgTable(
  'reward_events',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    /** pending | acknowledged | unavailable */
    status: text('status').notNull().default('pending'),
    detail: text('detail'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('reward_events_invitation').on(t.invitationId),
    index('reward_events_status').on(t.tenantId, t.status),
  ],
);

/** Module 26: one SampIntel AI connection per tenant. Scoped service token, sealed; never a shared database. */
export const sampintelConnections = pgTable(
  'sampintel_connections',
  {
    id: id(),
    tenantId: tenantId(),
    mode: adapterMode('mode').notNull(),
    baseUrl: text('base_url'),
    tokenSealed: text('token_sealed'),
    enabled: boolean('enabled').notNull().default(false),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sampintel_tenant').on(t.tenantId)],
);

// ───────────────────────────── Phase 7: intelligence, Copilot and reports ─────────────────────────────

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Module 11: a delivery forecast as it was computed, with its inputs, so a past recommendation can be explained. */
export const deliveryPredictions = pgTable(
  'delivery_predictions',
  {
    id: id(),
    tenantId: tenantId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    modelVersion: text('model_version').notNull(),
    risk: text('risk').notNull(),
    forecast: jsonb('forecast').notNull(),
    inputs: jsonb('inputs').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('delivery_predictions_project').on(t.tenantId, t.projectId, t.createdAt.desc())],
);

/**
 * Module 24: every Copilot request, the typed query it became, the model version and the rationale. A consequential
 * action is only proposed here; a person with the right permission approves it, and the normal service then runs it.
 */
export const copilotInteractions = pgTable(
  'copilot_interactions',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id').notNull(),
    prompt: text('prompt').notNull(),
    intent: text('intent').notNull(),
    query: jsonb('query'),
    modelVersion: text('model_version').notNull(),
    rationale: text('rationale').notNull(),
    /** answered | proposed | approved | rejected | failed | refused */
    status: text('status').notNull(),
    action: jsonb('action'),
    result: jsonb('result'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('copilot_user').on(t.tenantId, t.userId, t.createdAt.desc())],
);

/** Module 29: an asynchronous export. The file is kept until it expires, then removed by the scheduler. */
export const reportExports = pgTable(
  'report_exports',
  {
    id: id(),
    tenantId: tenantId(),
    requestedBy: uuid('requested_by').notNull(),
    kind: text('kind').notNull(),
    format: text('format').notNull(),
    filters: jsonb('filters').notNull().default({}),
    timezone: text('timezone').notNull().default('UTC'),
    /** queued | ready | failed | expired */
    status: text('status').notNull().default('queued'),
    rows: integer('rows'),
    fileName: text('file_name'),
    content: bytea('content'),
    error: text('error'),
    downloads: integer('downloads').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('report_exports_tenant').on(t.tenantId, t.createdAt.desc()),
    index('report_exports_status').on(t.status, t.createdAt),
  ],
);

/**
 * A saved project setup (execution policy, allocation mode, cell criteria and caps, QA mode) that can be applied to
 * another project. It holds MADP criteria and numbers only: no references, people or prices.
 */
export const setupTemplates = pgTable(
  'setup_templates',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    sourceProjectCode: text('source_project_code'),
    content: jsonb('content').notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('setup_templates_name').on(t.tenantId, t.name)],
);

/**
 * Where a tenant's alerts go and which ones. Set on the Alerts screen, never in environment files. The SMTP password
 * and the chat webhook address are sealed, and both hosts must be public.
 */
export const alertSettings = pgTable('alert_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  emailEnabled: boolean('email_enabled').notNull().default(false),
  smtpHost: text('smtp_host'),
  smtpPort: integer('smtp_port').notNull().default(587),
  /** true: TLS from the start (port 465); false: STARTTLS, which is required. */
  smtpSecure: boolean('smtp_secure').notNull().default(false),
  smtpUser: text('smtp_user'),
  smtpPasswordSealed: text('smtp_password_sealed'),
  fromAddress: text('from_address'),
  recipients: jsonb('recipients').notNull().default([]),
  webhookEnabled: boolean('webhook_enabled').notNull().default(false),
  webhookUrlSealed: text('webhook_url_sealed'),
  /** Alert groups to send: delivery, automation, quota_full, ir_drop, other. */
  categories: jsonb('categories').notNull().default(['delivery', 'automation', 'quota_full', 'ir_drop']),
  minSeverity: text('min_severity').notNull().default('warning'),
  irDropPoints: integer('ir_drop_points').notNull().default(15),
  digestEnabled: boolean('digest_enabled').notNull().default(false),
  digestHour: integer('digest_hour').notNull().default(9),
  digestTimezone: text('digest_timezone').notNull().default('Asia/Kolkata'),
  /** Local date of the last digest sent, so it goes once a day. */
  lastDigestOn: text('last_digest_on'),
  /** Notifications created before this are never sent out, so switching alerts on does not flood old news. */
  sendSince: timestamp('send_since', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per notification and channel, so an alert is sent at most once there and failures are visible. */
export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    id: id(),
    tenantId: tenantId(),
    notificationId: uuid('notification_id').references(() => notifications.id, { onDelete: 'cascade' }),
    /** email | webhook */
    channel: text('channel').notNull(),
    /** alert | digest | test */
    kind: text('kind').notNull(),
    /** sent | failed | skipped */
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(1),
    error: text('error'),
    subject: text('subject').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('alert_deliveries_once').on(t.notificationId, t.channel),
    index('alert_deliveries_tenant_at').on(t.tenantId, t.at.desc()),
  ],
);

/** Conditions already alerted on (a cell that filled, an IR drop on a day), so each is raised once. */
export const alertMarks = pgTable(
  'alert_marks',
  {
    tenantId: tenantId(),
    key: text('key').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('alert_marks_key').on(t.tenantId, t.key)],
);

/**
 * The AI the Copilot may use to understand questions in any language and to answer in that language. Set on the
 * Copilot screen by the tenant. The key is sealed and the address must be public https. The model only ever turns
 * words into one of the Copilot's typed, read-only questions; the answer itself always comes from Supply360's data.
 */
export const copilotAi = pgTable('copilot_ai', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'restrict' }),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  baseUrl: text('base_url'),
  authStyle: text('auth_style').notNull().default('bearer'),
  model: text('model').notNull(),
  sealedKey: text('sealed_key'),
  enabled: boolean('enabled').notNull().default(false),
  timeoutMs: integer('timeout_ms').notNull().default(20_000),
  dailyLimit: integer('daily_limit').notNull().default(500),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
