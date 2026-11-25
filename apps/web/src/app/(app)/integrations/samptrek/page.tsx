'use client';
import { SampTrekProjectStatus } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, DatabaseBackup, FlaskConical, KeyRound, Plus, Power, RefreshCw, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { fmtTime, type Connection, type ProjectSummary } from '@/lib/ingestion';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

export default function SampTrekPage() {
  const canRead = useCan('integrations.read');
  const canManage = useCan('integrations.manage');
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'fixture' | 'live'>('fixture');
  const [secret, setSecret] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ items: Connection[] }>('/sources'),
    enabled: canRead,
  });
  const projects = useQuery({
    queryKey: ['projects', '', ''],
    queryFn: () => api<{ items: ProjectSummary[] }>('/projects'),
    enabled: canRead,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sources'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
  };

  const create = useMutation({
    mutationFn: (body: unknown) => api<Connection & { webhookSecret: string }>('/sources', { method: 'POST', body }),
    onSuccess: (c) => {
      setAdding(false);
      setSecret(c.webhookSecret);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const sync = useMutation({
    mutationFn: ({ id, full }: { id: string; full: boolean }) =>
      api<NonNullable<Connection['lastSyncResult']>>(`/sources/${id}/sync`, { method: 'POST', body: { full } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Checked ${r.seen}: ${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged`);
      else toast.error(`Sync had problems: ${r.errors[0]}`);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/sources/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api<{ webhookSecret: string }>(`/sources/${id}/rotate-secret`, { method: 'POST' }),
    onSuccess: (r) => setSecret(r.webhookSecret),
    onError: (e) => toast.error(errMsg(e)),
  });
  const simulate = useMutation({
    mutationFn: ({ id, ...body }: { id: string; projectCode: string; status: string }) =>
      api<{ status: string }>(`/sources/${id}/fixture/status`, { method: 'POST', body }),
    onSuccess: (r, v) => {
      toast.success(`Signed webhook delivered: ${v.projectCode} → ${v.status} (${r.status})`);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!canRead) return <NoPermission permission="integrations.read" />;

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({
      kind: 'samptrek',
      name: f.get('name'),
      mode,
      vendorCode: f.get('vendorCode'),
      ...(mode === 'live' ? { baseUrl: f.get('baseUrl'), apiKey: f.get('apiKey') } : {}),
    });
  };
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast.success('Copied'));

  return (
    <>
      <PageHeader
        title="SampTrek Integration"
        description="Supply360 reads projects from SampTrek's public API and listens for its signed webhooks. It never writes to SampTrek."
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus /> Add connection
            </Button>
          )
        }
      />
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorState error={list.error} />
      ) : !list.data?.items.length ? (
        <Card>
          <Empty title="No SampTrek connection yet">
            Start in FIXTURE mode to load labelled sample projects. Switch to LIVE once SampTrek issues a read-only key
            with projects:read, sessions:read and quotas:read.
          </Empty>
        </Card>
      ) : (
        <div className="space-y-6">
          {list.data.items.map((c) => (
            <Card key={c.id}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {c.name}
                    {c.mode === 'fixture' ? <Badge tone="demo">FIXTURE</Badge> : <Badge tone="accent">LIVE</Badge>}
                    {!c.enabled && <Badge tone="danger">Off</Badge>}
                  </span>
                }
                description={
                  c.mode === 'live'
                    ? `${c.baseUrl} · key ${c.hasApiKey ? 'stored sealed' : 'missing'} · vendor code ${c.vendorCode}`
                    : `Sample data shaped like SampTrek's API · vendor code ${c.vendorCode}`
                }
                action={
                  canManage && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={!c.enabled || sync.isPending}
                        onClick={() => sync.mutate({ id: c.id, full: false })}
                      >
                        <RefreshCw /> Sync now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!c.enabled || sync.isPending}
                        onClick={() => sync.mutate({ id: c.id, full: true })}
                      >
                        <DatabaseBackup /> Backfill all
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggle.mutate({ id: c.id, enabled: !c.enabled })}
                      >
                        <Power /> {c.enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                    </div>
                  )
                }
              />
              <CardBody className="grid gap-6 md:grid-cols-2">
                <div className="space-y-3 text-sm">
                  <div>
                    <p className="text-xs font-medium text-muted">Webhook URL for SampTrek</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code
                        className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 font-mono text-xs"
                        title={c.webhookUrl}
                      >
                        {c.webhookUrl}
                      </code>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Copy webhook URL"
                        onClick={() => copy(c.webhookUrl)}
                      >
                        <Copy />
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted">Subscribe it to {c.webhookEvents.join(', ')}.</p>
                  </div>
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => rotate.mutate(c.id)}>
                      <KeyRound /> New signing secret
                    </Button>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted">Last sync</dt>
                  <dd className="tabular-nums">{fmtTime(c.lastSyncAt)}</dd>
                  <dt className="text-muted">Result</dt>
                  <dd>
                    {c.lastSyncResult ? (
                      c.lastSyncResult.ok ? (
                        <Badge tone="success">
                          {c.lastSyncResult.seen} checked, {c.lastSyncResult.created} new
                        </Badge>
                      ) : (
                        <Badge tone="danger" title={c.lastSyncResult.errors.join('\n')}>
                          {c.lastSyncResult.errors.length} problems
                        </Badge>
                      )
                    ) : (
                      '—'
                    )}
                  </dd>
                  <dt className="text-muted">Changes since</dt>
                  <dd className="tabular-nums">
                    {c.pollCheckpoint ? fmtTime(c.pollCheckpoint) : 'Full backfill next'}
                  </dd>
                  <dt className="text-muted">Rejected signatures</dt>
                  <dd className={c.rejectedCount ? 'text-danger' : ''}>
                    {c.rejectedCount}
                    {c.lastRejectedReason && (
                      <span className="ml-1 inline-flex items-center gap-1 text-xs">
                        <ShieldAlert className="size-3" /> {c.lastRejectedReason}
                      </span>
                    )}
                  </dd>
                </dl>
                {c.mode === 'fixture' && canManage && (
                  <SimulatePanel
                    projects={projects.data?.items ?? []}
                    pending={simulate.isPending}
                    onSend={(projectCode, status) => simulate.mutate({ id: c.id, projectCode, status })}
                  />
                )}
              </CardBody>
            </Card>
          ))}
          <p className="text-sm text-muted">
            Every delivery is recorded in the{' '}
            <Link className="text-accent underline underline-offset-2" href="/developers">
              webhook log
            </Link>
            .
          </p>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding} title="Add SampTrek connection">
        <form onSubmit={onCreate} className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required minLength={2} defaultValue="SampTrek" />
          </div>
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="mb-1.5 text-xs font-medium text-muted">Mode</legend>
            {(['fixture', 'live'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="accent-[var(--accent)]"
                />
                {m === 'fixture' ? 'FIXTURE (sample data)' : 'LIVE (real SampTrek)'}
              </label>
            ))}
          </fieldset>
          <div>
            <Label htmlFor="vendorCode">Supply360's vendor code in SampTrek</Label>
            <Input id="vendorCode" name="vendorCode" required pattern="[A-Za-z0-9_-]{2,40}" defaultValue="S360" />
          </div>
          {mode === 'live' && (
            <>
              <div>
                <Label htmlFor="baseUrl">SampTrek address</Label>
                <Input id="baseUrl" name="baseUrl" type="url" required placeholder="https://samptrek.example.com" />
              </div>
              <div>
                <Label htmlFor="apiKey">Read-only API key</Label>
                <Input
                  id="apiKey"
                  name="apiKey"
                  required
                  pattern="pjx_[A-Za-z0-9_-]{32}"
                  autoComplete="off"
                  placeholder="pjx_…"
                />
                <p className="mt-1 text-xs text-muted">
                  Stored sealed and never shown again. Needs projects:read, sessions:read and quotas:read only.
                </p>
              </div>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Add connection
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={!!secret}
        onOpenChange={(o) => !o && setSecret(null)}
        title="Webhook signing secret"
        description="Copy it into the SampTrek webhook endpoint now. It is shown only once."
      >
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-surface-2 px-2 py-2 font-mono text-xs">{secret}</code>
          <Button size="icon" variant="ghost" aria-label="Copy secret" onClick={() => secret && copy(secret)}>
            <Copy />
          </Button>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={() => setSecret(null)}>
            I have stored it
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function SimulatePanel({
  projects,
  pending,
  onSend,
}: {
  projects: ProjectSummary[];
  pending: boolean;
  onSend: (projectCode: string, status: string) => void;
}) {
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    onSend(String(f.get('projectCode')), String(f.get('status')));
  };
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-warning/30 bg-warning/5 p-4 md:col-span-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <FlaskConical className="size-4 text-warning" /> FIXTURE: simulate a SampTrek change
      </p>
      <p className="mt-1 text-xs text-muted">
        Changes a sample project and delivers a signed project.status_changed webhook through the real inbox. Not
        available on LIVE connections or in production.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="sim-project">Project</Label>
          <Select id="sim-project" name="projectCode" required className="w-64">
            {projects.map((p) => (
              <option key={p.id} value={p.projectCode}>
                {p.projectCode} · {p.name.replace('FIXTURE · ', '')}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="sim-status">New SampTrek status</Label>
          <Select id="sim-status" name="status" defaultValue="HOLD" className="w-36">
            {SampTrekProjectStatus.options.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending || !projects.length}>
          Send signed webhook
        </Button>
      </div>
    </form>
  );
}
