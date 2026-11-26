'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Plus, Power } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { fmtN, type AudienceConnection } from '@/lib/audience';
import { fmtTime } from '@/lib/ingestion';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

export default function MadpPage() {
  const canRead = useCan('integrations.read');
  const canManage = useCan('integrations.manage');
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'fixture' | 'live'>('fixture');
  const list = useQuery({
    queryKey: ['audience-connections'],
    queryFn: () => api<{ items: AudienceConnection[]; activeId: string | null }>('/audience/connections'),
    enabled: canRead,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['audience-connections'] });
    void qc.invalidateQueries({ queryKey: ['audience-attributes'] });
  };
  const create = useMutation({
    mutationFn: (body: unknown) => api<AudienceConnection>('/audience/connections', { method: 'POST', body }),
    onSuccess: () => {
      setAdding(false);
      toast.success('MADP connection added');
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const check = useMutation({
    mutationFn: (id: string) => api<AudienceConnection>(`/audience/connections/${id}/check`, { method: 'POST' }),
    onSuccess: (c) => {
      if (c.lastCheckResult?.ok) toast.success(`MADP answered in ${c.lastCheckResult.ms} ms`);
      else toast.error(`MADP check failed: ${c.lastCheckResult?.error}`);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/audience/connections/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!canRead) return <NoPermission permission="integrations.read" />;

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({
      name: f.get('name'),
      mode,
      ...(mode === 'live' ? { baseUrl: f.get('baseUrl'), clientId: f.get('clientId'), secret: f.get('secret') } : {}),
    });
  };

  return (
    <>
      <PageHeader
        title="MADP Integration"
        description="Supply360 asks MADP for counts, eligible people and reservations with signed requests. It receives pseudonymous references only: no names, e-mail addresses, answers or health data."
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
          <Empty title="No MADP connection yet">
            Start in FIXTURE mode to use a labelled DEMO population. Switch to LIVE once MADP issues Supply360 a service
            client with attributes.read, audience.counts, audience.match and reservations.write.
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
                    {c.id === list.data.activeId && <Badge tone="success">In use</Badge>}
                    {!c.enabled && <Badge tone="danger">Off</Badge>}
                  </span>
                }
                description={
                  c.mode === 'live'
                    ? `${c.baseUrl} · client ${c.clientId} · secret ${c.hasSecret ? 'stored sealed' : 'missing'}`
                    : 'DEMO population answering like MADP’s Supply360 API. Nobody in it is real.'
                }
                action={
                  canManage && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={check.isPending} onClick={() => check.mutate(c.id)}>
                        <Activity /> Check
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
              <CardBody>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-4">
                  <dt className="text-muted">Last check</dt>
                  <dd className="tabular-nums">{fmtTime(c.lastCheckAt)}</dd>
                  <dt className="text-muted">Result</dt>
                  <dd>
                    {!c.lastCheckResult ? (
                      '—'
                    ) : c.lastCheckResult.ok ? (
                      <Badge tone="success">OK · {c.lastCheckResult.ms} ms</Badge>
                    ) : (
                      <Badge tone="danger" title={c.lastCheckResult.error}>
                        Failed
                      </Badge>
                    )}
                  </dd>
                  {c.lastCheckResult?.ok && (
                    <>
                      <dt className="text-muted">Unique people</dt>
                      <dd className="tabular-nums">{fmtN(c.lastCheckResult.uniquePeople)}</dd>
                      <dt className="text-muted">Panel memberships</dt>
                      <dd className="tabular-nums">{fmtN(c.lastCheckResult.panelMemberships)}</dd>
                    </>
                  )}
                  {c.lastCheckResult && !c.lastCheckResult.ok && (
                    <dd className="col-span-full text-xs text-danger">{c.lastCheckResult.error}</dd>
                  )}
                </dl>
              </CardBody>
            </Card>
          ))}
          <Card>
            <CardHeader
              title="What MADP does not offer yet"
              description="Gaps found in MADP's Supply360 API; Supply360 works around them."
            />
            <CardBody>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                <li>No list of attribute values: people type canonical values for LIVE (FIXTURE suggests some).</li>
                <li>No nested filter groups: one level only, AND across attributes and OR within one.</li>
                <li>
                  References are per panel membership, not per person: Supply360 lets a project hold people from one
                  panel only, so nobody is invited twice.
                </li>
                <li>Invitation dispatch, delivery callbacks and reward events arrive with later phases.</li>
              </ul>
            </CardBody>
          </Card>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding} title="Add MADP connection">
        <form onSubmit={onCreate} className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required minLength={2} defaultValue="MADP" />
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
                {m === 'fixture' ? 'FIXTURE (DEMO people)' : 'LIVE (real MADP)'}
              </label>
            ))}
          </fieldset>
          {mode === 'live' && (
            <>
              <div>
                <Label htmlFor="baseUrl">MADP address</Label>
                <Input id="baseUrl" name="baseUrl" type="url" required placeholder="https://madp.example.com" />
              </div>
              <div>
                <Label htmlFor="clientId">Service client id</Label>
                <Input id="clientId" name="clientId" required pattern="[A-Za-z0-9_-]{6,80}" autoComplete="off" />
              </div>
              <div>
                <Label htmlFor="secret">Client secret</Label>
                <Input id="secret" name="secret" type="password" required minLength={24} autoComplete="off" />
                <p className="mt-1 text-xs text-muted">Stored sealed. It is never shown again.</p>
              </div>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Add
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
