import type { LaunchCheck, Lifecycle, LifecycleAction, Permission } from '@s360/contracts';

/**
 * Supply360's project lifecycle. Two rules keep it safe:
 *   1. The source always wins. HOLD at SampTrek forces `source_hold`; CLOSED or INVOICED forces `closed`.
 *      When the source goes back to LIVE, the project returns to `paused`, never straight to `live`: a person resumes.
 *   2. Nothing dispatches unless the project is `live` here AND LIVE at the source (dispatchAllowed).
 */

export function applySourceStatus(current: Lifecycle, sourceStatus: string): Lifecycle {
  if (current === 'closed') return 'closed';
  if (sourceStatus === 'CLOSED' || sourceStatus === 'INVOICED') return 'closed';
  if (sourceStatus === 'HOLD') return 'source_hold';
  if (current === 'source_hold') return 'paused';
  return current;
}

export function dispatchAllowed(p: { lifecycle: Lifecycle; sourceStatus: string }): boolean {
  return p.lifecycle === 'live' && p.sourceStatus === 'LIVE';
}

/** Per market: the project may dispatch, the market is LIVE and Supply360's own vendor link is ACTIVE. */
export function marketDispatchAllowed(
  p: { lifecycle: Lifecycle; sourceStatus: string },
  m: { sourceStatus: string; vendorLinkStatus: string | null; entryUrl: string | null },
): boolean {
  return dispatchAllowed(p) && m.sourceStatus === 'LIVE' && m.vendorLinkStatus === 'ACTIVE' && !!m.entryUrl;
}

interface Rule {
  from: Lifecycle[];
  to: Lifecycle;
  permission: Permission;
  /** Launch checks must all pass (pending-phase checks excepted). */
  needsChecks: boolean;
  /** Source statuses the action is allowed under. */
  source?: string[];
}

export const RULES: Record<LifecycleAction, Rule> = {
  mark_ready: {
    from: ['imported'],
    to: 'ready',
    permission: 'projects.manage',
    needsChecks: true,
    source: ['LIVE', 'TEST'],
  },
  launch: { from: ['ready'], to: 'live', permission: 'execution.approve', needsChecks: true, source: ['LIVE'] },
  pause: { from: ['live'], to: 'paused', permission: 'execution.control', needsChecks: false },
  resume: { from: ['paused'], to: 'live', permission: 'execution.control', needsChecks: true, source: ['LIVE'] },
  close: {
    from: ['imported', 'ready', 'live', 'paused', 'source_hold'],
    to: 'closed',
    permission: 'projects.manage',
    needsChecks: false,
  },
};

export type TransitionResult =
  | { ok: true; to: Lifecycle }
  | { ok: false; code: 'invalid_transition' | 'source_status' | 'launch_checks' | 'permission_denied'; detail: string };

export function transition(
  p: { lifecycle: Lifecycle; sourceStatus: string },
  action: LifecycleAction,
  permissions: readonly Permission[],
  checks: LaunchCheck[],
): TransitionResult {
  const r = RULES[action];
  if (!permissions.includes(r.permission)) {
    return { ok: false, code: 'permission_denied', detail: `Needs ${r.permission}` };
  }
  if (!r.from.includes(p.lifecycle)) {
    return {
      ok: false,
      code: 'invalid_transition',
      detail: `Cannot ${action.replace('_', ' ')} a project that is ${p.lifecycle}`,
    };
  }
  if (r.source && !r.source.includes(p.sourceStatus)) {
    return {
      ok: false,
      code: 'source_status',
      detail: `SampTrek shows this project as ${p.sourceStatus}; ${action.replace('_', ' ')} needs ${r.source.join(' or ')}`,
    };
  }
  if (r.needsChecks) {
    // Marking ready needs the project itself in order; quota mapping and audience are needed to launch.
    const failed = checks.filter((c) => !c.ok && !c.pendingPhase && !(action === 'mark_ready' && c.stage === 'launch'));
    if (failed.length) {
      return { ok: false, code: 'launch_checks', detail: failed.map((c) => c.label).join('; ') };
    }
  }
  return { ok: true, to: r.to };
}
