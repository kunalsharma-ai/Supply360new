'use client';
import type { LifecycleAction } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Copy,
  Link2,
  OctagonX,
  Pause,
  Play,
  Rocket,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import {
  ACTION_LABELS,
  fmtDate,
  fmtTime,
  lifecycleLabel,
  lifecycleTone,
  sourceTone,
  type Market,
  type ProjectDetail,
} from '@/lib/ingestion';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');
const ICONS: Record<LifecycleAction, typeof Play> = {
  mark_ready: CheckCircle2,
  launch: Rocket,
  pause: Pause,
  resume: Play,
  close: OctagonX,
};

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const canRead = useCan('projects.read');
  const canManage = useCan('projects.manage');
  const qc = useQueryClient();
  const [acting, setActing] = useState<LifecycleAction | null>(null);
  const [linking, setLinking] = useState<Market | null>(null);

  const p = useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetail>(`/projects/${id}`),
    enabled: canRead,
  });
  const versions = useQuery({
    queryKey: ['project', id, 'versions'],
    queryFn: () => api<{ items: { version: number; via: string; receivedAt: string }[] }>(`/projects/${id}/versions`),
    enabled: canRead,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['project', id] });

  const move = useMutation({
    mutationFn: (b: { action: LifecycleAction; reason: string }) =>
      api(`/projects/${id}/lifecycle`, { method: 'POST', body: b }),
    onSuccess: (_d, v) => {
      setActing(null);
      toast.success(`${ACTION_LABELS[v.action]}: done`);
      void refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const approve = useMutation({
    mutationFn: (b: { cc: string; entryUrl: string }) =>
      api(`/projects/${id}/markets/${b.cc}/entry-link`, { method: 'PUT', body: { entryUrl: b.entryUrl } }),
    onSuccess: () => {
      setLinking(null);
      toast.success('Entry link approved');
      void refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!canRead) return <NoPermission permission="projects.read" />;
  if (p.isLoading) return <Loading />;
  if (p.error || !p.data) return <ErrorState error={p.error} />;
  const d = p.data;

  const onAct = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    move.mutate({ action: acting!, reason: String(new FormData(e.currentTarget).get('reason')) });
  };
  const onLink = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    approve.mutate({ cc: linking!.countryCode, entryUrl: String(new FormData(e.currentTarget).get('entryUrl')) });
  };
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success('Copied'));

  return (
    <>
      <Link href="/projects" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-text">
        <ArrowLeft className="size-3.5" /> All projects
      </Link>
      <PageHeader
        eyebrow={
          <div className="flex flex-wrap items-center gap-1.5">
            {d.sourceMode === 'fixture' && <Badge tone="demo">FIXTURE data</Badge>}
            <Badge tone={sourceTone(d.sourceStatus)}>SampTrek {d.sourceStatus}</Badge>
            <Badge tone={lifecycleTone(d.lifecycle)}>{lifecycleLabel(d.lifecycle)}</Badge>
            <Badge tone={d.dispatchAllowed ? 'success' : 'neutral'}>
              {d.dispatchAllowed ? 'Dispatch allowed' : 'Dispatch stopped'}
            </Badge>
          </div>
        }
        title={d.name}
        description={
          <>
            <span className="font-mono">{d.projectCode}</span>
            {d.clientName && ` · ${d.clientName}`}
            {d.projectManagerName && ` · PM ${d.projectManagerName}`} · Field {fmtDate(d.fieldStartAt)} to{' '}
            {fmtDate(d.fieldEndAt)} · Version {d.version}
          </>
        }
      />

      <div role="toolbar" aria-label="Project actions" className="mb-6 flex flex-wrap gap-2">
        {d.actions.map((a) => {
          const Icon = ICONS[a.action];
          return (
            <Button
              key={a.action}
              variant={a.action === 'launch' ? 'primary' : a.action === 'close' ? 'danger' : 'secondary'}
              size="sm"
              disabled={!a.allowed}
              title={a.reason ?? undefined}
              onClick={() => setActing(a.action)}
            >
              <Icon /> {ACTION_LABELS[a.action]}
            </Button>
          );
        })}
      </div>
      {d.lifecycle === 'source_hold' && (
        <p role="status" className="mb-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          SampTrek has put this project on hold, so Supply360 has stopped it. When SampTrek resumes it, the project
          comes back as Paused and a person resumes it here.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Markets"
            description="Only markets where Supply360 is a vendor at SampTrek can dispatch. Other vendors' links are not stored."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-5 py-3 font-medium">Market</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">LOI / IR</th>
                  <th className="px-3 py-3 text-right font-medium">Supply360</th>
                  <th className="px-3 py-3 font-medium">Entry link</th>
                  <th className="px-5 py-3 font-medium">Dispatch</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {d.markets.map((m) => (
                  <tr key={m.countryCode}>
                    <td className="px-5 py-3">
                      <p className="font-mono font-medium">
                        {m.countryCode}
                        {m.language ? ` · ${m.language}` : ''}
                      </p>
                      <p className="max-w-56 truncate text-xs text-muted" title={m.targetGroup ?? ''}>
                        {m.targetGroup}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={sourceTone(m.sourceStatus)}>{m.sourceStatus}</Badge>
                      {m.isSupply360Vendor && (
                        <p className="mt-1 text-[11px] text-muted">Vendor link {m.vendorLinkStatus}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs tabular-nums">
                      {m.loiMinutes ?? '—'} min / {m.irPercent ?? '—'}%
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {m.isSupply360Vendor ? (
                        <>
                          {m.vendorCompletes ?? 0} <span className="text-muted">/ {m.vendorTarget ?? 0}</span>
                        </>
                      ) : (
                        <span className="text-xs text-muted">Not a vendor</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {m.entryUrl ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success" title={m.entryUrl}>
                          <CheckCircle2 className="size-3.5" /> Approved {fmtDate(m.entryApprovedAt)}
                        </span>
                      ) : m.isSupply360Vendor ? (
                        <span className="text-xs text-warning">Needs approval</span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                      {canManage && m.isSupply360Vendor && (
                        <Button size="sm" variant="ghost" className="ml-1" onClick={() => setLinking(m)}>
                          <Link2 /> {m.entryUrl ? 'Change' : 'Approve'}
                        </Button>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs">
                      {m.dispatchAllowed ? (
                        <span className="text-success">Allowed</span>
                      ) : (
                        <span className="text-muted">Stopped</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Launch checks"
            description="Checked by the server. Quota mapping and audience are needed to launch or resume, not to mark ready."
            action={
              <Button asChild size="sm" variant="ghost">
                <Link href={`/quotas?project=${d.id}`}>Quotas and audience</Link>
              </Button>
            }
          />
          <ul className="divide-y divide-border">
            {d.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-2.5 px-5 py-3 text-sm">
                {c.pendingPhase ? (
                  <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted" aria-label="Later phase" />
                ) : c.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passed" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />
                )}
                <div>
                  <p className={c.pendingPhase ? 'text-muted' : ''}>{c.label}</p>
                  {c.pendingPhase ? (
                    <p className="text-xs text-muted">Arrives in Phase {c.pendingPhase}</p>
                  ) : (
                    !c.ok &&
                    c.detail && (
                      <p className="text-xs text-muted">
                        {c.detail}
                        {c.stage === 'launch' && ' · needed to launch'}
                      </p>
                    )
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Redirect URLs for SampTrek"
            description="Paste these into Supply360's vendor redirect settings in SampTrek. Arrivals are recorded as unverified until the signed callback confirms them (Phase 5)."
          />
          <ul className="divide-y divide-border">
            {d.redirects.map((r) => (
              <li key={r.status} className="flex items-center gap-3 px-5 py-2.5">
                <span className="w-36 shrink-0 font-mono text-xs">{r.status}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={r.url}>
                  {r.url}
                </code>
                <span className="w-16 shrink-0 text-right text-xs text-muted tabular-nums">{r.hits} hits</span>
                <Button size="icon" variant="ghost" aria-label={`Copy ${r.status} URL`} onClick={() => copy(r.url)}>
                  <Copy />
                </Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Versions" description="A new version is kept each time the content changes at SampTrek." />
          <CardBody className="pt-3">
            {versions.data?.items.length ? (
              <ol className="space-y-2 text-sm">
                {versions.data.items.map((v) => (
                  <li key={v.version} className="flex items-center justify-between gap-2">
                    <span className="font-medium">Version {v.version}</span>
                    <span className="text-xs text-muted">
                      {v.via} · {fmtTime(v.receivedAt)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <Loading />
            )}
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={!!acting}
        onOpenChange={(o) => !o && setActing(null)}
        title={acting ? `${ACTION_LABELS[acting]} ${d.projectCode}` : ''}
        description="Every change is written to the audit log with your reason."
      >
        <form onSubmit={onAct} className="space-y-4">
          <div>
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" name="reason" required minLength={3} maxLength={500} autoFocus />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setActing(null)}>
              Cancel
            </Button>
            <Button type="submit" variant={acting === 'close' ? 'danger' : 'primary'} disabled={move.isPending}>
              {acting ? ACTION_LABELS[acting] : ''}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={!!linking}
        onOpenChange={(o) => !o && setLinking(null)}
        title={`Entry link for ${linking?.countryCode ?? ''}`}
        description="SampTrek does not share vendor entry links through its API. Paste the live link SampTrek gave Supply360 for this market. Supply360 fills [UID] with its own opaque reference."
      >
        <form onSubmit={onLink} className="space-y-4">
          <div>
            <Label htmlFor="entryUrl">Live entry link</Label>
            <Input
              id="entryUrl"
              name="entryUrl"
              type="url"
              required
              defaultValue={linking?.entryUrl ?? ''}
              placeholder="https://samptrek.example/s/Ab12Cd34?uid=[UID]"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setLinking(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={approve.isPending}>
              Approve link
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
