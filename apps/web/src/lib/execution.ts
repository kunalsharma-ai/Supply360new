import type { ExecutionMode } from '@s360/contracts';

export interface Policy {
  mode: ExecutionMode;
  batchSize: number;
  dailyMax: number;
  reviewIntervalMinutes: number;
  quietStartHour: number;
  quietEndHour: number;
  timezone: string;
  reminderOffsetsHours: number[];
  allowedPanels: string[];
  linkValidDays: number;
  escalateRefusalPercent: number;
  speederPercent: number | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  version: number;
  lastReviewAt: string | null;
  updatedAt: string;
}

export interface BatchRow {
  id: string;
  projectId: string;
  cellId: string;
  size: number;
  status: 'proposed' | 'approved' | 'sending' | 'sent' | 'blocked' | 'rejected' | 'cancelled';
  mode: ExecutionMode;
  origin: 'person' | 'system';
  policyVersion: number;
  scheduledAt: string | null;
  approvedAt: string | null;
  reason: string | null;
  blockedReason: string | null;
  blockedText: string | null;
  authorized: number;
  refused: number;
  sent: number;
  createdAt: string;
  finishedAt: string | null;
  projectCode?: string;
  cellName?: string;
  countryCode?: string;
}

export interface ProjectExecution {
  projectId: string;
  projectCode: string;
  name: string;
  lifecycle: string;
  dispatchAllowed: boolean;
  halted: boolean;
  haltReason: string | null;
  policy: Policy | null;
  today: { sent: number; max: number } | null;
  quietNow: boolean;
  invitations: Record<string, number>;
  reminders: Record<string, number>;
  cells: { id: string; countryCode: string; name: string; isOpen: boolean; mapped: boolean; available: number }[];
  batches: BatchRow[];
}

export interface Overview {
  halted: boolean;
  haltReason: string | null;
  projects: (Policy & { projectId: string; projectCode: string; name: string; lifecycle: string })[];
  approvals: BatchRow[];
}

export const BATCH_TONE: Record<BatchRow['status'], 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  proposed: 'accent',
  approved: 'accent',
  sending: 'warning',
  sent: 'success',
  blocked: 'danger',
  rejected: 'neutral',
  cancelled: 'neutral',
};

export const ESCALATION_TEXT: Record<string, string> = {
  high_refusal: 'Too many people in a batch were refused',
  all_refused: 'MADP refused everyone in a batch',
  delivery_unavailable: 'MADP cannot deliver invitations yet',
  cell_closed: 'A quota cell closed',
  project_closed: 'The project closed',
  no_people_held: 'Nobody held is left to invite',
  madp_rejected: 'MADP refused a request',
};

export const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
