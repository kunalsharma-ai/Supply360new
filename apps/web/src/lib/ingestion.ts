import {
  LIFECYCLE_LABELS,
  type LaunchCheck,
  type Lifecycle,
  type LifecycleAction,
  type OutcomeStatus,
} from '@s360/contracts';

export interface ProjectSummary {
  id: string;
  projectCode: string;
  name: string;
  clientName: string | null;
  projectManagerName: string | null;
  category: string | null;
  sourceStatus: string;
  lifecycle: Lifecycle;
  dispatchAllowed: boolean;
  fieldStartAt: string | null;
  fieldEndAt: string | null;
  version: number;
  updatedAt: string;
  markets?: string[];
  vendorTarget?: number;
  vendorCompletes?: number;
}

export interface Market {
  countryCode: string;
  language: string | null;
  targetGroup: string | null;
  sourceStatus: string;
  loiMinutes: number | null;
  irPercent: number | null;
  targetCompletes: number;
  completes: number;
  isSupply360Vendor: boolean;
  vendorLinkStatus: string | null;
  vendorTarget: number | null;
  vendorCompletes: number | null;
  entryUrl: string | null;
  entryApprovedAt: string | null;
  dispatchAllowed: boolean;
}

export interface ProjectDetail extends Omit<ProjectSummary, 'markets'> {
  sourceMode: 'fixture' | 'live';
  markets: Market[];
  checks: LaunchCheck[];
  actions: { action: LifecycleAction; allowed: boolean; reason: string | null }[];
  redirects: { status: OutcomeStatus; url: string; hits: number }[];
}

export interface Connection {
  id: string;
  kind: 'samptrek';
  mode: 'fixture' | 'live';
  name: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  vendorCode: string;
  enabled: boolean;
  webhookUrl: string;
  webhookEvents: string[];
  pollCheckpoint: string | null;
  lastSyncAt: string | null;
  lastSyncResult: {
    ok: boolean;
    seen: number;
    created: number;
    updated: number;
    unchanged: number;
    errors: string[];
  } | null;
  rejectedCount: number;
  lastRejectedAt: string | null;
  lastRejectedReason: string | null;
}

export interface InboxEvent {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'processed' | 'ignored' | 'failed';
  attempts: number;
  duplicates: number;
  error: string | null;
  signedAt: string;
  receivedAt: string;
  processedAt: string | null;
}

export const lifecycleTone = (l: Lifecycle) =>
  (
    ({
      imported: 'neutral',
      ready: 'accent',
      live: 'success',
      paused: 'warning',
      source_hold: 'danger',
      closed: 'neutral',
    }) as const
  )[l];
export const lifecycleLabel = (l: Lifecycle) => LIFECYCLE_LABELS[l];
export const sourceTone = (s: string): 'success' | 'danger' | 'accent' | 'neutral' =>
  s === 'LIVE' ? 'success' : s === 'HOLD' ? 'danger' : s === 'TEST' ? 'accent' : 'neutral';

export const ACTION_LABELS: Record<LifecycleAction, string> = {
  mark_ready: 'Mark ready',
  launch: 'Launch',
  pause: 'Pause',
  resume: 'Resume',
  close: 'Close',
};

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
export const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
