import { Controller, Get } from '@nestjs/common';
import {
  AllocationUpdate,
  AudienceConnectionCreate,
  AudienceCriteria,
  BatchCreate,
  BatchDecision,
  ExecutionPolicyUpdate,
  KillSwitch,
  CellMapping,
  ReserveRequest,
  SegmentCreate,
  EntryLinkApproval,
  LifecycleRequest,
  SourceConnectionCreate,
  LoginRequest,
  LoginResponse,
  Me,
  Problem,
  TenantSettings,
  TotpCode,
  UserCreate,
  UserRolesUpdate,
  UserStatusUpdate,
  UserSummary,
  CallbackSecret,
  FlagReview,
  RecontactRequest,
  ReinviteRequest,
  QaModeUpdate,
  SampIntelConnectionUpdate,
  ForecastAssumptions,
  CopilotAsk,
  CopilotDecision,
  ReportRequest,
} from '@s360/contracts';
import { z } from 'zod';
import { Public } from './common/decorators.js';

const s = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'any' });
const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema: s(schema) } } });
const problem = { description: 'Problem', content: { 'application/problem+json': { schema: s(Problem) } } };
const op = (summary: string, permission: string | null, body?: z.ZodType, ok?: z.ZodType) => ({
  summary,
  'x-permission': permission,
  ...(body ? { requestBody: { required: true, ...json(body) } } : {}),
  responses: { '200': ok ? { description: 'OK', ...json(ok) } : { description: 'OK' }, '4XX': problem },
});

/** OpenAPI 3.0 generated from the same zod schemas the API validates with (ADR-002, ADR-013). */
export function buildOpenApi() {
  return {
    openapi: '3.0.3',
    info: { title: 'Supply360 API', version: '0.1.0' },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 's360_session' } } },
    security: [{ session: [] }],
    paths: {
      '/health': { get: { ...op('Liveness and database reachability', null), security: [] } },
      '/auth/login': { post: { ...op('Password step of sign-in', null, LoginRequest, LoginResponse), security: [] } },
      '/auth/mfa': { post: op('Enrol or verify TOTP and receive a full session', 'password-stage session', TotpCode) },
      '/auth/logout': { post: op('Revoke this session', 'session') },
      '/auth/me': { get: op('Current user, tenant, roles and permissions', 'session', undefined, Me) },
      '/users': {
        get: op('List users (keyset paging with ?after)', 'users.read'),
        post: op('Create a user', 'users.manage', UserCreate, UserSummary),
      },
      '/users/{id}': { get: op('One user', 'users.read', undefined, UserSummary) },
      '/users/{id}/roles': { patch: op('Replace roles', 'users.manage', UserRolesUpdate, UserSummary) },
      '/users/{id}/status': { patch: op('Enable or disable', 'users.manage', UserStatusUpdate, UserSummary) },
      '/roles': { get: op('Role matrix', 'roles.read') },
      '/audit': { get: op('Audit events, newest first (?cursor)', 'audit.read') },
      '/settings/tenant': {
        get: op('Tenant settings', 'settings.read'),
        put: op('Replace tenant settings', 'settings.manage', TenantSettings),
      },
      '/notifications': { get: op('Notifications for me and my tenant', 'notifications.read') },
      '/notifications/{id}/read': { post: op('Mark read', 'notifications.read') },
      '/sources': {
        get: op('Project source connections (SampTrek)', 'integrations.read'),
        post: op('Add a connection; returns the webhook secret once', 'integrations.manage', SourceConnectionCreate),
      },
      '/sources/{id}': { patch: op('Turn a connection on or off', 'integrations.manage') },
      '/sources/{id}/sync': {
        post: op('Poll changed projects, or backfill with {"full":true}', 'integrations.manage'),
      },
      '/sources/{id}/rotate-secret': { post: op('New webhook secret, returned once', 'integrations.manage') },
      '/sources/{id}/fixture/status': {
        post: op('FIXTURE only: simulate a SampTrek status change', 'integrations.manage'),
      },
      '/sources/events': { get: op('Webhook inbox, newest first (?cursor)', 'integrations.read') },
      '/sources/events/{id}/retry': { post: op('Retry a failed inbox event', 'integrations.manage') },
      '/webhooks/samptrek/{tenant}/{connection}': {
        post: { ...op('SampTrek event webhook, verified by X-Projexa-Signature', 'HMAC signature'), security: [] },
      },
      '/s2s/samptrek/{tenant}/{connection}': {
        get: {
          ...op(
            'SampTrek vendor S2S callback (?uid, ?status), verified by X-Projexa-Signature over the full URL',
            'HMAC signature',
          ),
          security: [],
        },
      },
      '/projects': { get: op('Projects (?lifecycle, ?q)', 'projects.read') },
      '/projects/{id}': {
        get: op('Project with markets, launch checks, allowed actions and redirect URLs', 'projects.read'),
      },
      '/projects/{id}/versions': { get: op('Content versions received from the source', 'projects.read') },
      '/projects/{id}/lifecycle': {
        post: op(
          'Move through the lifecycle (permission depends on the action)',
          'projects.read + action permission',
          LifecycleRequest,
        ),
      },
      '/projects/{id}/markets/{cc}/entry-link': {
        put: op("Approve Supply360's SampTrek entry link for a market", 'projects.manage', EntryLinkApproval),
      },
      '/projects/{id}/quotas': {
        get: op('Quota cells with mapping, allocation, cap, held counts and reservations', 'projects.read'),
      },
      '/projects/{id}/quotas/{cellId}/mapping': {
        put: op('Map a SampTrek quota cell to MADP criteria (one panel)', 'quotas.manage', CellMapping),
      },
      '/projects/{id}/quotas/{cellId}/feasibility': { post: op('MADP counts for a cell', 'audience.read') },
      '/projects/{id}/quotas/{cellId}/reserve': {
        post: op('Select and reserve people in MADP, never past the cell cap', 'audience.select', ReserveRequest),
      },
      '/projects/{id}/reservations/{rid}/release': { post: op('Release a reservation', 'audience.select') },
      '/projects/{id}/allocation': {
        put: op('Allocation mode, per-cell targets and caps', 'allocation.manage', AllocationUpdate),
      },
      '/audience/connections': {
        get: op('MADP connections', 'integrations.read'),
        post: op('Add a MADP connection (FIXTURE or LIVE)', 'integrations.manage', AudienceConnectionCreate),
      },
      '/audience/connections/{id}': { patch: op('Turn a MADP connection on or off', 'integrations.manage') },
      '/audience/connections/{id}/check': { post: op('Signed round trip to MADP', 'integrations.manage') },
      '/audience/attributes': { get: op('MADP attributes Supply360 may filter on', 'audience.read') },
      '/audience/counts': { post: op('Unique people and memberships from MADP', 'audience.read', AudienceCriteria) },
      '/audience/segments': {
        get: op('Saved segments', 'audience.read'),
        post: op('Save a segment', 'audience.select', SegmentCreate),
      },
      '/audience/segments/{id}': { delete: op('Delete a segment', 'audience.select') },
      '/audience/selections': { get: op('Selection snapshots, newest first', 'audience.read') },
      '/projects/{id}/execution': { get: op('Execution policy, limits, cells, batches and totals', 'projects.read') },
      '/projects/{id}/execution/policy': {
        put: op(
          'Set the mode and limits (automatic mode also needs execution.approve)',
          'automation.manage',
          ExecutionPolicyUpdate,
        ),
      },
      '/projects/{id}/batches': {
        post: op('Create an invitation batch for a cell', 'invitations.dispatch', BatchCreate),
      },
      '/projects/{id}/batches/{bid}/decision': {
        post: op('Approve or reject (execution.approve), or cancel a batch', 'invitations.dispatch', BatchDecision),
      },
      '/projects/{id}/batches/{bid}/send': {
        post: op('Send an approved batch now, if every check passes', 'invitations.dispatch'),
      },
      '/execution/overview': { get: op('Kill switch, projects with a policy, approval queue', 'projects.read') },
      '/execution/batches': { get: op('Invitation batches, newest first', 'projects.read') },
      '/execution/reminders': { get: op('Reminder jobs, latest first', 'projects.read') },
      '/execution/router-events': { get: op('Survey router events: clicks, prefetches, refusals', 'projects.read') },
      '/execution/kill-switch': {
        put: op('Emergency stop for all sending in the tenant', 'execution.emergency_stop', KillSwitch),
      },
      '/fieldwork/live': { get: op('Every project: funnel and completes against target', 'projects.read') },
      '/projects/{id}/fieldwork': {
        get: op('Funnel, outcomes, incidence, LOI, markets, cells, flags, last reconciliation', 'projects.read'),
      },
      '/projects/{id}/participation': { get: op('Append-only participation events, newest first', 'projects.read') },
      '/quality/flags': { get: op('Quality flags for review', 'projects.read') },
      '/quality/flags/{id}/review': {
        post: op('Accept or dismiss a flag, with a reason', 'quality.review', FlagReview),
      },
      '/projects/{id}/reconciliation': {
        post: op("Reconcile against SampTrek's sessions API (idempotent)", 'reconciliation.manage'),
      },
      '/reconciliation/runs': { get: op('Reconciliation runs, newest first', 'projects.read') },
      '/reconciliation/runs/{id}': { get: op('One run with its differences', 'projects.read') },
      '/rewards': { get: op('Reward events and totals', 'projects.read') },
      '/rewards/sync': { post: op('Hand pending reward events to MADP (never credits a wallet)', 'rewards.sync') },
      '/recontact/participants': {
        get: op('Past participants by when they took part, project, outcome and market', 'audience.read'),
      },
      '/projects/{id}/quotas/{cellId}/recontact': {
        post: op('Hold past participants for a cell through MADP', 'audience.select', RecontactRequest),
      },
      '/projects/{id}/dropouts': { get: op('People who did not finish, by kind', 'projects.read') },
      '/projects/{id}/reinvite': {
        post: op('Send dropouts their link again, after every check', 'invitations.dispatch', ReinviteRequest),
      },
      '/sources/{id}/callback': { get: op('SampTrek S2S callback URL template for the vendor', 'integrations.read') },
      '/sources/{id}/callback-secret': {
        put: op("Set SampTrek's vendor callback secret", 'integrations.manage', CallbackSecret),
      },
      '/sampintel/connection': {
        get: op('SampIntel AI link (token never returned)', 'integrations.read'),
        put: op('Save the SampIntel AI link (FIXTURE or LIVE over HTTPS; token sealed)', 'sampintel.manage', SampIntelConnectionUpdate),
      },
      '/sampintel/connection/check': { post: op('Check the SampIntel AI link', 'sampintel.manage') },
      '/sampintel/projects': { get: op('QA mode of every project', 'projects.read') },
      '/projects/{id}/qa-mode': { put: op('Set Human only, Synthetic QA only or Both kept separate', 'sampintel.manage', QaModeUpdate) },
      '/projects/{id}/synthetic-qa': { get: op('Synthetic QA summary, shown beside human sample and never added to it', 'projects.read') },
      '/intelligence/delivery': { get: op('Delivery forecast for every active project, riskiest first', 'projects.read') },
      '/projects/{id}/forecast': { get: op('Delivery forecast: rates with denominators, ranges, risk, cells behind, next batch', 'projects.read') },
      '/intelligence/assumptions': {
        get: op('Cold-start assumptions', 'projects.read'),
        put: op('Set cold-start assumptions (audited, with a reason)', 'settings.manage', ForecastAssumptions),
      },
      '/intelligence/audience': { get: op('Panel, country and segment performance (?days=1..730)', 'audience.read') },
      '/intelligence/tick': { post: op('Record forecast snapshots and risk notifications now (not in production)', 'execution.control') },
      '/copilot': { get: op('Your Copilot history and examples', 'copilot.use') },
      '/copilot/ask': { post: op('Ask the Copilot; answers come from typed, permission-checked queries', 'copilot.use', CopilotAsk) },
      '/copilot/{id}/decision': { post: op('Approve or reject a proposed action (a batch needs invitations.dispatch)', 'copilot.use', CopilotDecision) },
      '/reports/exports': {
        get: op('Your exports', 'reports.read'),
        post: op('Queue an export (CSV, Excel or JSON; 24-hour expiry)', 'reports.export', ReportRequest),
      },
      '/reports/exports/{id}': { get: op('One export', 'reports.read') },
      '/reports/exports/{id}/download': { get: op('Download your export until it expires', 'reports.export') },
      '/reports/tick': { post: op('Build queued exports and expire old ones now (not in production)', 'execution.control') },
      '/execution/tick': { post: op('Run one scheduler pass now (not in production)', 'execution.control') },
      '/i/{tenant}/{token}': {
        get: { ...op('Participation link: records the click and 302s to the approved entry link', null), security: [] },
      },
      '/r/{tenant}/{project}/{outcome}': {
        get: { ...op('Respondent redirect landing (302 to the Supply360 thank-you page)', null), security: [] },
      },
    },
  };
}

@Controller()
export class OpenApiController {
  @Public()
  @Get('openapi.json')
  doc() {
    return buildOpenApi();
  }
}
