import { z } from 'zod';

/** Alert groups a tenant can send out by email or to a chat webhook. */
export const ALERT_CATEGORIES = ['delivery', 'automation', 'quota_full', 'ir_drop', 'other'] as const;
export const AlertCategory = z.enum(ALERT_CATEGORIES);
export type AlertCategory = z.infer<typeof AlertCategory>;
export const ALERT_CATEGORY_LABELS: Record<AlertCategory, string> = {
  delivery: 'Delivery at risk, off track, or target reached',
  automation: 'Emergency stop, automation escalated, batch blocked, approval needed',
  quota_full: 'A quota cell filled or closed',
  ir_drop: 'Incidence (IR) well below the expected IR',
  other: 'Everything else',
};
export const AlertSeverity = z.enum(['info', 'warning', 'danger', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

const email = z.email().max(200);

export const AlertSettingsUpdate = z
  .object({
    emailEnabled: z.boolean(),
    smtpHost: z
      .string()
      .trim()
      .max(200)
      .regex(/^[a-z0-9.-]+$/i, 'Host name only, such as smtp.zoho.in')
      .optional(),
    smtpPort: z.union([z.literal(25), z.literal(465), z.literal(587), z.literal(2525)]).default(587),
    smtpSecure: z.boolean().default(false),
    smtpUser: z.string().trim().max(200).optional(),
    /** Sent once and sealed; omit to keep the stored one. */
    smtpPassword: z.string().min(1).max(500).optional(),
    fromAddress: email.optional(),
    recipients: z.array(email).max(20).default([]),
    webhookEnabled: z.boolean(),
    /** Slack, Google Chat or Teams incoming webhook. Sealed; omit to keep the stored one. */
    webhookUrl: z
      .url({ protocol: /^https$/, error: 'Use the https:// webhook address' })
      .max(500)
      .optional(),
    categories: z.array(AlertCategory).max(5),
    minSeverity: AlertSeverity,
    irDropPoints: z.number().int().min(5).max(80),
    digestEnabled: z.boolean(),
    digestHour: z.number().int().min(0).max(23),
    digestTimezone: z.string().min(1).max(64),
  })
  .refine(
    (s) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: s.digestTimezone });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown time zone', path: ['digestTimezone'] },
  );
export type AlertSettingsUpdate = z.infer<typeof AlertSettingsUpdate>;

export const AlertTest = z.object({ channel: z.enum(['email', 'webhook', 'digest']) });
export type AlertTest = z.infer<typeof AlertTest>;
