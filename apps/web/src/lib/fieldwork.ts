import type { DropoutKind, Outcome } from '@s360/contracts';

export type Counts = Record<
  'sent' | 'clicked' | 'started' | 'approved' | 'rejected' | 'pendingApproval' | Outcome,
  number
> & {
  incidence: number | null;
};

export interface LoiStats {
  n: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
  histogram: { from: number; n: number }[];
  bucketMinutes: number;
}

export interface RunView {
  id: string;
  projectId: string;
  projectCode?: string;
  status: 'finished' | 'failed';
  summary: Record<string, unknown> & {
    sessions?: number;
    matched?: number;
    applied?: number;
    duplicates?: number;
    conflicts?: number;
    unverified?: number;
    differences?: number;
    error?: string;
  };
  differenceCount: number;
  startedAt: string;
  finishedAt: string | null;
  differences?: {
    kind: string;
    invitationId?: string;
    session?: string;
    had?: string;
    source?: string;
    status?: string;
  }[];
}

export interface Fieldwork {
  project: {
    id: string;
    projectCode: string;
    name: string;
    lifecycle: string;
    fieldEndAt: string | null;
    daysLeft: number | null;
  };
  total: Counts;
  loi: LoiStats;
  speederPercent: number | null;
  openFlags: number;
  markets: (Counts & {
    countryCode: string;
    sourceStatus: string;
    target: number | null;
    expectedLoiMinutes: number | null;
    expectedIrPercent: number | null;
    medianLoiMinutes: number | null;
    remaining: number | null;
  })[];
  cells: {
    id: string;
    countryCode: string;
    group: string;
    name: string;
    isOpen: boolean;
    target: number | null;
    complete: number;
    terminate: number;
    quota_full: number;
    incidence: number | null;
    reached: boolean;
  }[];
  lastReconciliation: RunView | null;
}

export interface LiveRow {
  id: string;
  projectCode: string;
  name: string;
  lifecycle: string;
  fieldEndAt: string | null;
  sent: number;
  clicked: number;
  started: number;
  complete: number;
  terminate: number;
  quotaFull: number;
  target: number;
  incidence: number | null;
}

export interface EventRow {
  id: string;
  invitationId: string;
  countryCode: string;
  kind: string;
  source: 'samptrek_callback' | 'samptrek_sessions' | 'router';
  effect: string;
  sessionRef: string | null;
  occurredAt: string;
  receivedAt: string;
}

export interface FlagRow {
  id: string;
  projectId: string;
  projectCode: string;
  invitationId: string;
  countryCode: string;
  outcome: string | null;
  loiSeconds: number | null;
  kind: string;
  detail: Record<string, unknown>;
  status: 'open' | 'accepted' | 'dismissed';
  reviewReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface RewardRow {
  id: string;
  projectCode: string;
  countryCode: string;
  invitationId: string;
  idempotencyKey: string;
  status: 'pending' | 'acknowledged' | 'unavailable';
  detail: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

export interface Participant {
  invitationId: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  person: string;
  panel: string;
  countryCode: string;
  outcome: string | null;
  approval: string | null;
  participatedAt: string;
}

export interface Dropout {
  invitationId: string;
  person: string;
  countryCode: string;
  dropout: DropoutKind | null;
  sentAt: string | null;
  clickedAt: string | null;
  startedAt: string | null;
  reinviteCount: number;
  lastReinvitedAt: string | null;
  canReinvite: boolean;
}

export const SOURCE_LABEL: Record<string, string> = {
  samptrek_callback: 'SampTrek S2S',
  samptrek_sessions: 'SampTrek sessions',
  router: 'Supply360 router',
};

export const OUTCOME_TONE = (o: string | null): 'neutral' | 'success' | 'warning' | 'danger' | 'accent' =>
  o === 'complete'
    ? 'success'
    : o === 'terminate' || o === 'quota_full' || o === 'partial'
      ? 'warning'
      : o === 'started' || o === 'client_approved'
        ? 'accent'
        : o
          ? 'danger'
          : 'neutral';

export const effectText = (e: string) =>
  e === 'applied'
    ? 'Applied'
    : e === 'conflict'
      ? 'Conflict, flagged'
      : e.startsWith('ignored:')
        ? `Ignored (${e.slice(8).replaceAll('_', ' ')})`
        : e;

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);
export const mins = (n: number | null | undefined) => (n == null ? '—' : `${n} min`);

/** Date ranges for "took part": a week, a month, a year back, or all time. */
export const RANGES = [
  { key: 'week', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'Last 30 days', days: 30 },
  { key: 'quarter', label: 'Last 90 days', days: 90 },
  { key: 'year', label: 'Last 12 months', days: 365 },
  { key: 'all', label: 'Any time', days: 0 },
  { key: 'custom', label: 'Custom range', days: -1 },
] as const;
