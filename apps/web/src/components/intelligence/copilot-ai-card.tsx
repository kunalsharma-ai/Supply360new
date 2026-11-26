'use client';
import { AI_PRESETS, PROVIDER_KIND_LABELS, type AiPreset, type AuthStyle, type ProviderKind } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, ListRestart, Sparkles, XCircle, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');
const REASONS: Record<string, string> = {
  auth_failed: 'The provider refused the key. Check it was copied in full and is still active.',
  rate_limited: 'The provider’s rate limit was hit. Free tiers allow only a few calls a minute; try again shortly.',
  model_not_found: 'The provider does not know this model id. Use “Load models” to pick one.',
  timeout: 'No answer within the timeout.',
  network_error: 'The provider could not be reached.',
  address_host_not_found: 'That address could not be found. Check the base URL.',
  address_host_not_public: 'Only public internet addresses can be used.',
  key_required: 'Enter the API key first.',
};
const reasonText = (r: string | null, d: string | null) =>
  [r ? (REASONS[r] ?? r.replaceAll('_', ' ')) : null, d].filter(Boolean).join(' ');

interface AiView {
  configured: boolean;
  kind?: ProviderKind;
  label?: string;
  baseUrl?: string | null;
  authStyle?: AuthStyle;
  model?: string;
  hasKey?: boolean;
  enabled: boolean;
  timeoutMs?: number;
  dailyLimit?: number;
  usedToday: number;
}

/** Connect any AI (free or paid) so the Copilot understands questions in Hindi, Hinglish or any language. */
export function CopilotAiCard() {
  const qc = useQueryClient();
  const canManage = useCan('settings.manage');
  const q = useQuery({ queryKey: ['copilot', 'ai'], queryFn: () => api<AiView>('/copilot/ai') });
  const [preset, setPreset] = useState<AiPreset | null>(null);
  const [kind, setKind] = useState<ProviderKind>('openai_compatible');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authStyle, setAuthStyle] = useState<AuthStyle>('bearer');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(500);
  const [models, setModels] = useState<string[]>([]);
  const [test, setTest] = useState<{
    ok: boolean;
    reason: string | null;
    detail: string | null;
    modelVersion: string | null;
    latencyMs: number;
  } | null>(null);
  useEffect(() => {
    const d = q.data;
    if (!d?.configured) return;
    setKind(d.kind!);
    setLabel(d.label!);
    setBaseUrl(d.baseUrl ?? '');
    setAuthStyle(d.authStyle!);
    setModel(d.model!);
    setEnabled(d.enabled);
    setDailyLimit(d.dailyLimit!);
    setPreset(AI_PRESETS.find((p) => p.label === d.label) ?? null);
  }, [q.data]);
  const pick = (id: string) => {
    const p = AI_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPreset(p);
    setKind(p.kind);
    setLabel(p.id === 'custom' ? 'My AI' : p.label);
    setBaseUrl(p.baseUrl ?? '');
    setAuthStyle(p.authStyle ?? 'bearer');
    setModel(p.model ?? '');
    setModels([]);
    setTest(null);
  };
  const body = { kind, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), authStyle };
  const save = useMutation({
    mutationFn: () =>
      api('/copilot/ai', {
        method: 'PUT',
        body: {
          ...body,
          label: label || 'AI',
          model: model.trim(),
          ...(key.trim() ? { apiKey: key.trim() } : {}),
          enabled,
          timeoutMs: 20_000,
          dailyLimit,
        },
      }),
    onSuccess: () => {
      toast.success('Copilot AI saved');
      setKey('');
      void qc.invalidateQueries({ queryKey: ['copilot', 'ai'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const runTest = useMutation({
    mutationFn: () => api<NonNullable<typeof test>>('/copilot/ai/test', { method: 'POST', body: {} }),
    onSuccess: setTest,
    onError: (e) => toast.error(errMsg(e)),
  });
  const load = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; models: string[]; reason: string | null; detail: string | null }>('/copilot/ai/models', {
        method: 'POST',
        body: { ...body, ...(key.trim() ? { apiKey: key.trim() } : {}) },
      }),
    onSuccess: (r) => {
      if (!r.ok) return toast.error(reasonText(r.reason, r.detail));
      setModels(r.models);
      toast.success(`${r.models.length} models found`);
      if (!model && r.models[0]) setModel(r.models.find((m) => m.endsWith(':free')) ?? r.models[0]);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const d = q.data;
  const compat = kind === 'openai_compatible';
  const off = !canManage;

  return (
    <Card className="mt-6" data-testid="copilot-ai">
      <CardHeader
        title="AI for the Copilot"
        description="Connect any AI, free or paid, and ask the Copilot in Hindi, Hinglish or any language. The AI only works out what you are asking; every number in the answer comes from Supply360, and nothing is sent or changed without a person approving it."
        action={d?.enabled ? <Badge tone="success">On · {d.usedToday} today</Badge> : <Badge>Rules only</Badge>}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="cai-preset">Provider</Label>
            <Select id="cai-preset" value={preset?.id ?? ''} disabled={off} onChange={(e) => pick(e.target.value)}>
              <option value="">{d?.configured ? `${d.label} (saved)` : 'Choose an AI…'}</option>
              {AI_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.freeTier ? ' · free tier' : ''}
                </option>
              ))}
            </Select>
            {preset?.note && <p className="mt-1 text-xs text-muted">{preset.note}</p>}
          </div>
          <div>
            <Label htmlFor="cai-kind">API type</Label>
            <Select id="cai-kind" value={kind} disabled={off} onChange={(e) => setKind(e.target.value as ProviderKind)}>
              {(Object.keys(PROVIDER_KIND_LABELS) as ProviderKind[]).map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="cai-base">{compat ? 'Base URL' : 'Base URL (optional)'}</Label>
            <Input
              id="cai-base"
              type="url"
              value={baseUrl}
              disabled={off}
              required={compat}
              placeholder="https://"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          {compat && (
            <div>
              <Label htmlFor="cai-auth">Key is sent as</Label>
              <Select
                id="cai-auth"
                value={authStyle}
                disabled={off}
                onChange={(e) => setAuthStyle(e.target.value as AuthStyle)}
              >
                <option value="bearer">Authorization: Bearer (most providers)</option>
                <option value="api-key">api-key header (Azure OpenAI)</option>
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="cai-key">
              API key{' '}
              {preset?.keyPage && (
                <a
                  href={preset.keyPage}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline"
                >
                  Get a key <ExternalLink className="size-3" />
                </a>
              )}
            </Label>
            <Input
              id="cai-key"
              type="password"
              autoComplete="off"
              disabled={off}
              value={key}
              placeholder={d?.hasKey ? '•••••••• (stored, sealed)' : ''}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cai-model">Model</Label>
            <div className="flex gap-2">
              <Input
                id="cai-model"
                list="cai-models"
                required
                value={model}
                disabled={off}
                placeholder="Model id, or load the list"
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="cai-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {canManage && (
                <Button
                  type="button"
                  size="sm"
                  className="h-10 shrink-0"
                  disabled={load.isPending}
                  onClick={() => load.mutate()}
                >
                  <ListRestart /> Load models
                </Button>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="cai-limit">Most AI questions a day (then rules answer)</Label>
            <Input
              id="cai-limit"
              type="number"
              min={1}
              max={100000}
              value={dailyLimit}
              disabled={off}
              onChange={(e) => setDailyLimit(Number(e.target.value))}
            />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={enabled}
              disabled={off}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <Sparkles className="size-4 text-accent" /> Use this AI in the Copilot
          </label>
          {test && (
            <div
              data-testid="copilot-ai-test"
              className={`flex items-start gap-2 rounded-lg border p-3 text-sm sm:col-span-2 ${test.ok ? 'border-success/30 bg-success/10' : 'border-danger/30 bg-danger/10'}`}
            >
              {test.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
              )}
              <p>
                {test.ok
                  ? `Working. ${test.modelVersion} answered in ${test.latencyMs} ms.`
                  : reasonText(test.reason, test.detail)}
              </p>
            </div>
          )}
          {canManage && (
            <div className="flex justify-end gap-2 sm:col-span-2">
              {d?.configured && (
                <Button type="button" size="sm" disabled={runTest.isPending} onClick={() => runTest.mutate()}>
                  <Zap /> {runTest.isPending ? 'Testing…' : 'Test'}
                </Button>
              )}
              <Button type="submit" size="sm" variant="primary" disabled={save.isPending}>
                Save
              </Button>
            </div>
          )}
        </CardBody>
      </form>
    </Card>
  );
}
