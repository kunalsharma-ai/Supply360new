import { Controller, Get } from '@nestjs/common';
import {
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
