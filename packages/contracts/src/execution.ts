import { z } from 'zod';
import { PanelCode } from './audience.js';

/**
 * Phase 4: invitations, reminders, scheduling, the survey router and execution modes (spec §7 and §8).
 * Every limit below is set per project by a person. None of the example values in the spec is a hardcoded default:
 * a new policy starts in manual mode with nothing allowed to send until a person sets its limits.
 */

export const ExecutionMode = z.enum(['manual', 'semi_auto', 'auto']);
export type ExecutionMode = z.infer<typeof ExecutionMode>;
export const MODE_LABELS: Record<ExecutionMode, string> = {
  manual: 'Manual',
  semi_auto: 'Semi-automatic',
  auto: 'Automatic',
};

const hour = z.number().int().min(0).max(23);

export const ExecutionPolicyUpdate = z
  .object({
    mode: ExecutionMode,
    /** Most invitations in one batch. */
    batchSize: z.number().int().min(1).max(5000),
    /** Most invitations a project sends in one calendar day (policy time zone). */
    dailyMax: z.number().int().min(1).max(1_000_000),
    /** How often semi-automatic and automatic modes look at the project. */
    reviewIntervalMinutes: z.number().int().min(5).max(1440),
    /** Local quiet hours, e.g. 21 to 8: nothing is sent from 21:00 to 07:59. Equal values mean no quiet hours. */
    quietStartHour: hour,
    quietEndHour: hour,
    timezone: z.string().min(1).max(64),
    /** Hours after the invitation for each reminder, e.g. [24, 72]. Empty means no reminders. */
    reminderOffsetsHours: z.array(z.number().int().min(1).max(336)).max(5),
    allowedPanels: z.array(PanelCode).min(1),
    /** How long a participation link works after the invitation. */
    linkValidDays: z.number().int().min(1).max(60),
    /** Automatic mode escalates to a person when more than this percentage of a batch is refused. */
    escalateRefusalPercent: z.number().int().min(1).max(100),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((p) => p.reminderOffsetsHours.every((h, i, a) => i === 0 || h > a[i - 1]!), {
    message: 'Reminder times must increase',
    path: ['reminderOffsetsHours'],
  })
  .refine(
    (p) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: p.timezone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown time zone', path: ['timezone'] },
  );
export type ExecutionPolicyUpdate = z.infer<typeof ExecutionPolicyUpdate>;

export const BatchCreate = z.object({
  cellId: z.uuid(),
  size: z.number().int().min(1).max(5000),
  /** Omit to send as soon as the checks allow. */
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  reason: z.string().trim().min(3).max(500),
});
export type BatchCreate = z.infer<typeof BatchCreate>;

export const BatchDecision = z.object({
  decision: z.enum(['approve', 'reject', 'cancel']),
  reason: z.string().trim().min(3).max(500),
});
export type BatchDecision = z.infer<typeof BatchDecision>;

export const KillSwitch = z.object({ halted: z.boolean(), reason: z.string().trim().min(3).max(500) });
export type KillSwitch = z.infer<typeof KillSwitch>;

/**
 * Batch states. proposed (semi-automatic, waits for a person) → approved → sending → sent, or blocked when a
 * check fails at send time (project stopped, no consent, quiet hours, daily cap, delivery unavailable), or
 * cancelled/rejected by a person.
 */
export const BatchStatus = z.enum(['proposed', 'approved', 'sending', 'sent', 'blocked', 'rejected', 'cancelled']);
export type BatchStatus = z.infer<typeof BatchStatus>;

export const InvitationStatus = z.enum(['authorized', 'sent', 'delivery_unavailable', 'clicked', 'expired']);
export type InvitationStatus = z.infer<typeof InvitationStatus>;
