import { z } from 'zod';

/**
 * Project setup reuse: copy a project's Supply360 setup onto another project, or save it as a named template.
 * The setup is what a person configures in Supply360 (the SampTrek project itself always comes from SampTrek):
 * the execution policy and reminders, the allocation mode, each quota cell's MADP criteria and invite cap, and the
 * synthetic QA mode.
 */
export const SETUP_PARTS = ['policy', 'allocation', 'criteria', 'caps', 'qaMode'] as const;
export const SetupPart = z.enum(SETUP_PARTS);
export type SetupPart = z.infer<typeof SetupPart>;
export const SETUP_PART_LABELS: Record<SetupPart, string> = {
  policy: 'Sending policy and reminders',
  allocation: 'Allocation mode',
  criteria: 'Audience criteria per quota cell',
  caps: 'Invite caps per quota cell',
  qaMode: 'Synthetic QA mode',
};

export const SetupSource = z.union([
  z.object({ templateId: z.uuid() }).strict(),
  z.object({ projectId: z.uuid() }).strict(),
]);
export type SetupSource = z.infer<typeof SetupSource>;

export const SetupApply = z.object({
  source: SetupSource,
  parts: z.array(SetupPart).min(1),
  reason: z.string().trim().min(3).max(500),
});
export type SetupApply = z.infer<typeof SetupApply>;

export const SetupPreview = SetupApply.omit({ reason: true });
export type SetupPreview = z.infer<typeof SetupPreview>;

export const SetupTemplateCreate = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  fromProjectId: z.uuid(),
});
export type SetupTemplateCreate = z.infer<typeof SetupTemplateCreate>;
