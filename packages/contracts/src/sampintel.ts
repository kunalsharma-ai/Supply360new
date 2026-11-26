import { z } from 'zod';

/**
 * Module 26, SampIntel AI integration (spec §9). Each project chooses how SampIntel's authorized synthetic QA relates
 * to its human sample. Synthetic results are only ever shown beside human data, never added to it.
 */
export const QA_MODES = ['human_only', 'synthetic_qa_only', 'both_separate'] as const;
export const QaMode = z.enum(QA_MODES);
export type QaMode = z.infer<typeof QaMode>;
export const QA_MODE_LABELS: Record<QaMode, string> = {
  human_only: 'Human only',
  synthetic_qa_only: 'Authorized synthetic QA only',
  both_separate: 'Both, kept separate',
};
export const QA_MODE_HINTS: Record<QaMode, string> = {
  human_only: 'Human invitations as usual. No synthetic QA summary is read.',
  synthetic_qa_only: 'Human invitations are off for this project; only SampIntel QA runs, under its own authorization.',
  both_separate: 'Human invitations as usual, and the synthetic QA summary is shown beside them, never added to them.',
};
export const QaModeUpdate = z.object({ mode: QaMode, reason: z.string().trim().min(3).max(300) });

export const SampIntelConnectionUpdate = z
  .object({
    mode: z.enum(['fixture', 'live']),
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .max(300)
      .optional(),
    /** A SampIntel service token with qa_summary.read. Sealed at rest, never returned. Omit to keep the stored one. */
    token: z
      .string()
      .regex(/^sik\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/, 'A SampIntel service token starts with sik.')
      .optional(),
    enabled: z.boolean(),
  })
  .refine((c) => c.mode === 'fixture' || !!c.baseUrl, {
    message: 'A live connection needs the SampIntel base URL',
    path: ['baseUrl'],
  });
export type SampIntelConnectionUpdate = z.infer<typeof SampIntelConnectionUpdate>;

/** What SampIntel returns. Anything else is refused. */
export const SyntheticQaSummary = z.object({
  classification: z.literal('synthetic_qa'),
  notice: z.string().max(400),
  projectRef: z.string().max(40),
  projects: z
    .array(
      z.object({
        code: z.string().max(40),
        name: z.string().max(160),
        status: z.string().max(20),
        environment: z.string().max(20),
      }),
    )
    .max(50),
  sessions: z.number().int().min(0),
  outcomes: z.record(z.string().max(40), z.number().int().min(0)),
  assertions: z.object({ passed: z.number().int().min(0), failed: z.number().int().min(0) }),
  blockedRedirects: z.number().int().min(0),
  lastSessionAt: z.string().nullable(),
});
export type SyntheticQaSummary = z.infer<typeof SyntheticQaSummary>;
