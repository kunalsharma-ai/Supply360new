import { z } from 'zod';

/** The eleven roles of spec §13. One matrix drives the API guards and the UI. */
export const Role = z.enum([
  'super_admin',
  'tenant_admin',
  'supply_head',
  'supply_manager',
  'supply_executive',
  'project_manager',
  'quality_analyst',
  'ai_operations_manager',
  'integration_admin',
  'reporting_user',
  'read_only',
]);
export type Role = z.infer<typeof Role>;

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  tenant_admin: 'Tenant Admin',
  supply_head: 'Supply Head',
  supply_manager: 'Supply Manager',
  supply_executive: 'Supply Executive',
  project_manager: 'Project Manager',
  quality_analyst: 'Quality Analyst',
  ai_operations_manager: 'AI Operations Manager',
  integration_admin: 'Integration Admin',
  reporting_user: 'Reporting User',
  read_only: 'Read-only',
};

export const Permission = z.enum([
  // platform
  'tenants.manage',
  'users.read',
  'users.manage',
  'roles.read',
  'audit.read',
  'settings.read',
  'settings.manage',
  'security.read',
  'notifications.read',
  // integrations
  'integrations.read',
  'integrations.manage',
  // projects and execution
  'projects.read',
  'projects.manage',
  'execution.control',
  'execution.approve',
  'execution.emergency_stop',
  'automation.manage',
  // audience
  'audience.read',
  'audience.select',
  'audience.sensitive',
  'allocation.manage',
  'quotas.manage',
  // dispatch
  'invitations.dispatch',
  'reminders.manage',
  // quality, reconciliation, rewards
  'quality.review',
  'reconciliation.manage',
  'rewards.sync',
  // reporting and AI
  'reports.read',
  'reports.export',
  'copilot.use',
  'sampintel.manage',
]);
export type Permission = z.infer<typeof Permission>;

const ALL = Permission.options;
const READ: Permission[] = ['projects.read', 'audience.read', 'reports.read', 'notifications.read', 'settings.read'];
const OPS: Permission[] = [
  ...READ,
  'projects.manage',
  'execution.control',
  'allocation.manage',
  'quotas.manage',
  'audience.select',
  'invitations.dispatch',
  'reminders.manage',
  'copilot.use',
  'reports.export',
  'integrations.read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: ALL,
  tenant_admin: ALL.filter((p) => p !== 'tenants.manage'),
  supply_head: [
    ...OPS,
    'execution.approve',
    'execution.emergency_stop',
    'automation.manage',
    'audience.sensitive',
    'quality.review',
    'reconciliation.manage',
    'rewards.sync',
    'users.read',
    'audit.read',
    'sampintel.manage',
  ],
  supply_manager: [...OPS, 'execution.approve', 'execution.emergency_stop', 'quality.review', 'reconciliation.manage'],
  supply_executive: [
    ...READ,
    'execution.control',
    'audience.select',
    'invitations.dispatch',
    'reminders.manage',
    'copilot.use',
  ],
  project_manager: [
    ...READ,
    'projects.manage',
    'reconciliation.manage',
    'reports.export',
    'copilot.use',
    'integrations.read',
  ],
  quality_analyst: [...READ, 'quality.review', 'reports.export'],
  ai_operations_manager: [...READ, 'automation.manage', 'copilot.use', 'sampintel.manage', 'integrations.read'],
  integration_admin: [...READ, 'integrations.read', 'integrations.manage', 'audit.read', 'security.read'],
  reporting_user: [...READ, 'reports.export'],
  read_only: READ,
};

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const set = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r]) set.add(p);
  return [...set].sort();
}

/** Roles a person may grant: never one with permissions they lack themselves. */
export function canGrant(granter: readonly Permission[], role: Role): boolean {
  const own = new Set(granter);
  return ROLE_PERMISSIONS[role].every((p) => own.has(p));
}
