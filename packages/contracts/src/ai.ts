import { z } from 'zod';

/**
 * How Supply360's Copilot talks to a model. Most providers (free and paid) speak the OpenAI chat format, so
 * `openai_compatible` plus a base URL covers them; Claude and Gemini use their own APIs.
 */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openai_compatible'] as const;
export const ProviderKind = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKind>;
export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Claude API (Anthropic)',
  openai: 'OpenAI API',
  gemini: 'Gemini API (Google)',
  openai_compatible: 'OpenAI-compatible API',
};

export const AuthStyle = z.enum(['bearer', 'api-key']);
export type AuthStyle = z.infer<typeof AuthStyle>;

const httpsUrl = z
  .url({ protocol: /^https$/, error: 'Use an https:// address' })
  .max(300)
  .refine((u) => !new URL(u).username && !new URL(u).password, 'Put the key in the API key field, not in the address');

export interface AiPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  authStyle?: AuthStyle;
  /** Only where the model id is stable and documented; otherwise the person picks from "Load models". */
  model?: string;
  maxOutputTokens?: number;
  freeTier: boolean;
  keyPage: string;
  note?: string;
}

/**
 * Ready-made starting points for the "Add AI" screen. Every field stays editable, and "Custom" covers any other
 * OpenAI-compatible service. A free tier is the provider's offer and can change; check its page.
 */
export const AI_PRESETS: AiPreset[] = [
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    model: 'claude-opus-5-5',
    maxOutputTokens: 2000,
    freeTier: false,
    keyPage: 'https://console.anthropic.com/settings/keys',
  },
  { id: 'openai', label: 'OpenAI', kind: 'openai', freeTier: false, keyPage: 'https://platform.openai.com/api-keys' },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'gemini',
    freeTier: true,
    keyPage: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    freeTier: true,
    keyPage: 'https://console.groq.com/keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    freeTier: true,
    keyPage: 'https://openrouter.ai/settings/keys',
    note: 'Model ids ending in :free cost nothing',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    freeTier: true,
    keyPage: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai_compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    freeTier: true,
    keyPage: 'https://cloud.cerebras.ai',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    kind: 'openai_compatible',
    baseUrl: 'https://router.huggingface.co/v1',
    freeTier: true,
    keyPage: 'https://huggingface.co/settings/tokens',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    freeTier: false,
    keyPage: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1',
    freeTier: false,
    keyPage: 'https://console.x.ai',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.together.xyz/v1',
    freeTier: false,
    keyPage: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    freeTier: false,
    keyPage: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    kind: 'openai_compatible',
    baseUrl: 'https://api.perplexity.ai',
    freeTier: false,
    keyPage: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    kind: 'openai_compatible',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
    authStyle: 'api-key',
    freeTier: false,
    keyPage: 'https://portal.azure.com',
    note: 'Replace YOUR-RESOURCE; the model is your deployment name',
  },
  {
    id: 'custom',
    label: 'Any other AI (OpenAI-compatible)',
    kind: 'openai_compatible',
    freeTier: false,
    keyPage: '',
    note: "Paste the base URL from the provider's API docs, usually ending in /v1",
  },
];

export const CopilotAiUpdate = z.object({
  kind: ProviderKind,
  label: z.string().trim().min(2).max(60),
  /** Required for openai_compatible; optional for the others. https only, public hosts only. */
  baseUrl: httpsUrl.optional(),
  authStyle: AuthStyle.default('bearer'),
  model: z.string().trim().min(1).max(120),
  /** Sent once and sealed at rest; never returned. Omit to keep the stored key. */
  apiKey: z.string().trim().min(8).max(1000).optional(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(2000).max(60_000),
  /** Most Copilot questions a day answered with the model; after that the Copilot uses its rules. */
  dailyLimit: z.number().int().min(1).max(100_000),
});
export type CopilotAiUpdate = z.infer<typeof CopilotAiUpdate>;

export const CopilotModelList = z.object({
  kind: ProviderKind,
  baseUrl: httpsUrl.optional(),
  authStyle: AuthStyle.default('bearer'),
  apiKey: z.string().trim().min(8).max(1000).optional(),
});
export type CopilotModelList = z.infer<typeof CopilotModelList>;
