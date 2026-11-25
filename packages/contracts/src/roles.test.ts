import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, Role, canGrant, permissionsFor } from './roles.js';

describe('role matrix', () => {
  it('defines every role', () => {
    for (const r of Role.options) expect(ROLE_PERMISSIONS[r].length).toBeGreaterThan(0);
  });
  it('only super admins manage tenants', () => {
    const holders = Role.options.filter((r) => ROLE_PERMISSIONS[r].includes('tenants.manage'));
    expect(holders).toEqual(['super_admin']);
  });
  it('read-only cannot change anything', () => {
    expect(permissionsFor(['read_only']).every((p) => p.endsWith('.read'))).toBe(true);
  });
  it('a supply executive cannot approve plans or stop everything', () => {
    const p = permissionsFor(['supply_executive']);
    expect(p).not.toContain('execution.approve');
    expect(p).not.toContain('execution.emergency_stop');
  });
  it('nobody can grant a role with more power than they hold', () => {
    expect(canGrant(permissionsFor(['tenant_admin']), 'super_admin')).toBe(false);
    expect(canGrant(permissionsFor(['tenant_admin']), 'supply_head')).toBe(true);
    expect(canGrant(permissionsFor(['supply_manager']), 'supply_head')).toBe(false);
  });
});
