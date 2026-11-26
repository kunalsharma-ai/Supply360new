'use client';
import { QA_MODE_HINTS, QA_MODE_LABELS, QA_MODES, type QaMode } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, FlaskConical, Save } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { fmtTime } from '@/lib/ingestion';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

interface Connection {
  mode: 'fixture' | 'live';
  baseUrl: string | null;
  hasToken: boolean;
  enabled: boolean;
  lastCheckAt: string | null;
  lastStatus: string | null;
  updatedAt: string;
}
interface Row {
  id: string;
  projectCode: string;
  name: string;
  lifecycle: string;
  qaMode: QaMode;
}

export default function SampIntelPage() {
  const canRead = useCan('integrations.read');
  const canManage = useCan('sampintel.manage');
  const qc = useQueryClient();
  const conn = useQuery({
    queryKey: ['sampintel-connection'],
    queryFn: () => api<{ connection: Connection | null }>('/sampintel/connection'),
    enabled: canRead,
  });
  const rows = useQuery({
    queryKey: ['sampintel-projects'],
    queryFn: () => api<Row[]>('/sampintel/projects'),
    enabled: canRead,
  });
  const c = conn.data?.connection ?? null;
  const [mode, setMode] = useState<'fixture' | 'live'>('fixture');
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (c) {
      setMode(c.mode);
      setEnabled(c.enabled);
    }
  }, [c]);
  const [change, setChange] = useState<{ row: Row; mode: QaMode } | null>(null);

  const save = useMutation({
    mutationFn: (body: unknown) => api('/sampintel/connection', { method: 'PUT', body }),
    onSuccess: () => {
      toast.success('SampIntel link saved');
      void qc.invalidateQueries({ queryKey: ['sampintel-connection'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const check = useMutation({
    mutationFn: () => api<{ status: string }>('/sampintel/connection/check', { method: 'POST' }),
    onSuccess: (r) => {
      if (r.status === 'ok') toast.success('SampIntel answered');
      else toast.error(`SampIntel check ${r.status}`);
      void qc.invalidateQueries({ queryKey: ['sampintel-connection'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const setQa = useMutation({
    mutationFn: ({ id, mode, reason }: { id: string; mode: QaMode; reason: string }) =>
      api(`/projects/${id}/qa-mode`, { method: 'PUT', body: { mode, reason } }),
    onSuccess: () => {
      setChange(null);
      toast.success('QA mode changed');
      void qc.invalidateQueries({ queryKey: ['sampintel-projects'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!canRead) return <NoPermission permission="integrations.read" />;

  const onSave = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const token = String(f.get('token') ?? '').trim();
    save.mutate({
      mode,
      enabled,
      ...(mode === 'live' ? { baseUrl: f.get('baseUrl') } : {}),
      ...(mode === 'live' && token ? { token } : {}),
    });
  };

  return (
    <>
      <PageHeader
        title="SampIntel AI Integration"
        description="Supply360 reads a synthetic QA summary from SampIntel AI and shows it beside human sample. It is never added to quotas, IR, LOI, rewards, invoices or delivery."
      />
      <div
        role="note"
        className="mb-5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2.5 text-xs text-warning"
      >
        <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <strong className="font-semibold">Synthetic QA stays separate.</strong> SampIntel runs fictional profiles only
          on surveys the owner has authorized in writing. Supply360 never sends its results to SampTrek or MADP, and
          never counts them as completes.
        </span>
      </div>
      {conn.isLoading || rows.isLoading ? (
        <Loading />
      ) : conn.error ? (
        <ErrorState error={conn.error} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Connection
                  {c?.mode === 'fixture' && <Badge tone="demo">FIXTURE</Badge>}
                  {c?.mode === 'live' && <Badge tone="accent">LIVE</Badge>}
                  {c && !c.enabled && <Badge tone="danger">Off</Badge>}
                </span>
              }
              description="FIXTURE answers with a labelled DEMO summary. LIVE needs a SampIntel service token issued under Integrations › Supply360 in SampIntel."
            />
            <CardBody>
              <form onSubmit={onSave} className="space-y-4">
                <fieldset className="grid grid-cols-2 gap-2" disabled={!canManage}>
                  <legend className="mb-1.5 text-xs font-medium text-muted">Mode</legend>
                  {(['fixture', 'live'] as const).map((m) => (
                    <label
                      key={m}
                      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <input
                        type="radio"
                        name="mode"
                        checked={mode === m}
                        onChange={() => setMode(m)}
                        className="accent-[var(--accent)]"
                      />
                      {m === 'fixture' ? 'FIXTURE (DEMO summary)' : 'LIVE (real SampIntel)'}
                    </label>
                  ))}
                </fieldset>
                {mode === 'live' && (
                  <>
                    <div>
                      <Label htmlFor="si-url">SampIntel address</Label>
                      <Input
                        id="si-url"
                        name="baseUrl"
                        type="url"
                        required
                        defaultValue={c?.baseUrl ?? ''}
                        placeholder="https://sampintel.example.com"
                        disabled={!canManage}
                      />
                    </div>
                    <div>
                      <Label htmlFor="si-token">Service token</Label>
                      <Input
                        id="si-token"
                        name="token"
                        type="password"
                        autoComplete="off"
                        placeholder={c?.hasToken ? 'Stored sealed. Leave empty to keep it.' : 'sik.…'}
                        disabled={!canManage}
                      />
                      <p className="mt-1 text-xs text-muted">Stored sealed. It is never shown again.</p>
                    </div>
                  </>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    disabled={!canManage}
                    className="accent-[var(--accent)]"
                  />
                  Read synthetic QA summaries
                </label>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="primary" disabled={save.isPending}>
                      <Save /> Save link
                    </Button>
                    <Button type="button" disabled={!c || check.isPending} onClick={() => check.mutate()}>
                      <Activity /> Check
                    </Button>
                  </div>
                )}
              </form>
              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">Last check</dt>
                <dd className="tabular-nums">{fmtTime(c?.lastCheckAt ?? null)}</dd>
                <dt className="text-muted">Result</dt>
                <dd data-testid="sampintel-status">
                  {!c?.lastStatus ? (
                    '—'
                  ) : c.lastStatus === 'ok' ? (
                    <Badge tone="success">OK</Badge>
                  ) : (
                    <span className="text-xs text-danger">{c.lastStatus}</span>
                  )}
                </dd>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What each QA mode does"
              description="Chosen per project. Every change needs a reason and is audited."
            />
            <CardBody>
              <ul className="space-y-3 text-sm">
                {QA_MODES.map((m) => (
                  <li key={m}>
                    <p className="font-medium">{QA_MODE_LABELS[m]}</p>
                    <p className="text-muted">{QA_MODE_HINTS[m]}</p>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="QA mode per project" description="Projects start as Human only." />
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted">
                    <th scope="col" className="px-5 py-2.5 font-medium">
                      Project
                    </th>
                    <th scope="col" className="px-5 py-2.5 font-medium">
                      Lifecycle
                    </th>
                    <th scope="col" className="px-5 py-2.5 font-medium">
                      QA mode
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(rows.data ?? []).map((r) => (
                    <tr key={r.id} data-testid="qa-mode-row">
                      <td className="px-5 py-2.5">
                        <span className="font-mono text-xs">{r.projectCode}</span> · {r.name}
                      </td>
                      <td className="px-5 py-2.5 text-muted">{r.lifecycle}</td>
                      <td className="px-5 py-2.5">
                        <Select
                          aria-label={`QA mode for ${r.projectCode}`}
                          value={r.qaMode}
                          disabled={!canManage}
                          onChange={(e) => setChange({ row: r, mode: e.target.value as QaMode })}
                          className="w-auto"
                        >
                          {QA_MODES.map((m) => (
                            <option key={m} value={m}>
                              {QA_MODE_LABELS[m]}
                            </option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      <Dialog open={!!change} onOpenChange={(o) => !o && setChange(null)} title="Change QA mode">
        {change && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setQa.mutate({
                id: change.row.id,
                mode: change.mode,
                reason: String(new FormData(e.currentTarget).get('reason')),
              });
            }}
          >
            <p className="text-sm">
              {change.row.projectCode} becomes <strong>{QA_MODE_LABELS[change.mode]}</strong>.{' '}
              {QA_MODE_HINTS[change.mode]}
            </p>
            <div>
              <Label htmlFor="qa-reason">Reason</Label>
              <Input id="qa-reason" name="reason" required minLength={3} maxLength={300} />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setChange(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={setQa.isPending}>
                Change mode
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
