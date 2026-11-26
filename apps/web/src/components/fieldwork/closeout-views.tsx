'use client';
import { FLAG_LABELS } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { errMsg } from '@/components/execution/use-batch-actions';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtN } from '@/lib/audience';
import { when } from '@/lib/execution';
import { OUTCOME_TONE, type FlagRow, type RewardRow, type RunView } from '@/lib/fieldwork';
import { Stat, Table, Td, Th, useFixtureSource, WithProject } from './fieldwork-views';

const FLAG_LABEL: Record<string, string> = {
  ...FLAG_LABELS,
  reward_after_reversal: 'Reward already acknowledged, then the outcome changed',
};

const flagDetail = (f: FlagRow) => {
  const d = f.detail as Record<string, unknown>;
  if (f.kind === 'speeder')
    return `${Math.round((Number(d.loiSeconds) / 60) * 10) / 10} min against ${String(d.expectedMinutes)} expected (rule: under ${String(d.thresholdPercent)}%)`;
  if (f.kind === 'conflicting_outcome')
    return `Had ${String(d.had)} from ${String(d.hadFrom ?? '?').replace('samptrek_', '')}, then ${String(d.got)} from ${String(d.from).replace('samptrek_', '')}`;
  if (f.kind === 'source_security') return `SampTrek said ${String(d.outcome).replace('_', ' ')}`;
  if (f.kind === 'approval_without_complete')
    return `Client ${String(d.approval)} a session that was ${String(d.outcome ?? 'not finished')}`;
  return JSON.stringify(d);
};

export function QualityView() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const project = params.get('project');
  const canReview = useCan('quality.review');
  const [status, setStatus] = useState<'open' | 'accepted' | 'dismissed' | ''>('open');
  const [pending, setPending] = useState<{ f: FlagRow; decision: 'accept' | 'dismiss' } | null>(null);
  const [reason, setReason] = useState('');
  const q = useQuery({
    queryKey: ['fieldwork', 'flags', status, project],
    queryFn: () =>
      api<{ open: number; items: FlagRow[] }>(
        `/quality/flags?${new URLSearchParams({ ...(status ? { status } : {}), ...(project ? { projectId: project } : {}) })}`,
      ),
  });
  const review = useMutation({
    mutationFn: () =>
      api(`/quality/flags/${pending!.f.id}/review`, { method: 'POST', body: { decision: pending!.decision, reason } }),
    onSuccess: () => {
      toast.success(pending!.decision === 'accept' ? 'Flag accepted' : 'Flag dismissed');
      setPending(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['fieldwork'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <>
      <PageHeader
        title="Quality Intelligence"
        description="Flags are context for a person, never an automatic rejection. Accepting or dismissing one is recorded with a reason; neither changes the outcome SampTrek reported."
      />
      <Card>
        <CardHeader
          title="Flags"
          description={q.data ? `${fmtN(q.data.open)} open across all projects` : undefined}
          action={
            <div className="w-40">
              <Label htmlFor="flag-status" className="sr-only">
                Show
              </Label>
              <Select id="flag-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="open">Open</option>
                <option value="accepted">Accepted</option>
                <option value="dismissed">Dismissed</option>
                <option value="">All</option>
              </Select>
            </div>
          }
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : !q.data.items.length ? (
          <Empty title="No flags here">Speeders, disagreeing sources and SampTrek security outcomes appear here.</Empty>
        ) : (
          <CardBody>
            <Table
              head={
                <>
                  <Th>Raised</Th>
                  <Th>Project</Th>
                  <Th>Person</Th>
                  <Th>Flag</Th>
                  <Th>Outcome</Th>
                  <Th>Review</Th>
                </>
              }
            >
              {q.data.items.map((f) => (
                <tr key={f.id}>
                  <Td>
                    <span className="text-xs text-muted">{when(f.createdAt)}</span>
                  </Td>
                  <Td mono>{f.projectCode}</Td>
                  <Td mono>
                    {f.countryCode} …{f.invitationId.slice(-8)}
                  </Td>
                  <Td>
                    <p className="font-medium">{FLAG_LABEL[f.kind] ?? f.kind}</p>
                    <p className="text-xs text-muted">{flagDetail(f)}</p>
                  </Td>
                  <Td>
                    <Badge tone={OUTCOME_TONE(f.outcome)}>{f.outcome?.replace('_', ' ') ?? 'none'}</Badge>
                  </Td>
                  <Td>
                    {f.status === 'open' ? (
                      canReview ? (
                        <div className="flex gap-1.5">
                          <Button size="sm" onClick={() => setPending({ f, decision: 'accept' })}>
                            Accept
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setPending({ f, decision: 'dismiss' })}>
                            Dismiss
                          </Button>
                        </div>
                      ) : (
                        <Badge tone="warning">open</Badge>
                      )
                    ) : (
                      <span className="text-xs text-muted">
                        <Badge tone={f.status === 'accepted' ? 'danger' : 'neutral'}>{f.status}</Badge> {f.reviewReason}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </CardBody>
        )}
      </Card>
      <Dialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.decision === 'accept' ? 'Accept this flag' : 'Dismiss this flag'}
        description={
          pending?.decision === 'accept'
            ? 'You agree there is a concern. Tell the client through SampTrek if the complete should be rejected; Supply360 does not change it.'
            : 'You checked and see no concern.'
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            review.mutate();
          }}
        >
          <div>
            <Label htmlFor="flag-reason">Reason (kept in the audit log)</Label>
            <Input id="flag-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setPending(null)}>
              Back
            </Button>
            <Button type="submit" variant="primary" disabled={review.isPending}>
              {pending?.decision === 'accept' ? 'Accept' : 'Dismiss'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

const DIFF_TEXT: Record<string, string> = {
  unknown_respondent: 'Session for someone Supply360 did not invite',
  unverified_at_source: 'SampTrek has not verified this outcome; not applied',
  outcome_mismatch: 'SampTrek disagreed with a callback; SampTrek wins, flagged',
  missing_at_source: 'Supply360 has an outcome SampTrek does not list',
};

export function ReconciliationView() {
  return (
    <>
      <PageHeader
        title="Project Reconciliation"
        description="Compares Supply360's records with SampTrek's sessions API, the source of record, including the client's final approve or reject. Safe to run any number of times; live projects are reconciled on a schedule too."
      />
      <WithProject>{(id, fw) => <Reconciliation id={id} code={fw.project.projectCode} />}</WithProject>
    </>
  );
}

function Reconciliation({ id, code }: { id: string; code: string }) {
  const qc = useQueryClient();
  const canRun = useCan('reconciliation.manage');
  const canSim = useCan('integrations.manage');
  const src = useFixtureSource();
  const [open, setOpen] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ['fieldwork', 'runs', id],
    queryFn: () => api<{ items: RunView[] }>(`/reconciliation/runs?projectId=${id}`),
  });
  const detail = useQuery({
    queryKey: ['fieldwork', 'run', open ?? runs.data?.items[0]?.id],
    queryFn: () => api<RunView>(`/reconciliation/runs/${open ?? runs.data!.items[0]!.id}`),
    enabled: !!(open ?? runs.data?.items[0]?.id),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['fieldwork'] });
  const run = useMutation({
    mutationFn: () => api<RunView>(`/projects/${id}/reconciliation`, { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(
        `Reconciled ${fmtN(r.summary.sessions)} sessions: ${fmtN(r.summary.applied)} changes, ${fmtN(r.summary.differences)} differences`,
      );
      setOpen(null);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const approve = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED') =>
      api<{ changed: number }>(`/sources/${src!.id}/fixture/approve`, {
        method: 'POST',
        body: { projectCode: code, decision, count: 5 },
      }),
    onSuccess: (r) => {
      toast.success(`Client decided ${r.changed} completes at SampTrek; reconciled`);
      setOpen(null);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const last = runs.data?.items[0];
  const s = last?.summary;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {canRun && (
          <Button variant="primary" onClick={() => run.mutate()} disabled={run.isPending}>
            Reconcile now
          </Button>
        )}
        {src && canSim && (
          <>
            <Button onClick={() => approve.mutate('APPROVED')} disabled={approve.isPending}>
              Play client: approve 5 <Badge tone="demo">FIXTURE</Badge>
            </Button>
            <Button onClick={() => approve.mutate('REJECTED')} disabled={approve.isPending}>
              Play client: reject 5 <Badge tone="demo">FIXTURE</Badge>
            </Button>
          </>
        )}
      </div>
      {s && (
        <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Sessions at SampTrek" value={fmtN(s.sessions)} hint={`Last run ${when(last.startedAt)}`} />
          <Stat label="Matched" value={fmtN(s.matched)} />
          <Stat label="Changes applied" value={fmtN(s.applied)} />
          <Stat label="Already known" value={fmtN(s.duplicates)} hint="Stored once, not counted again" />
          <Stat label="Conflicts" value={fmtN(s.conflicts)} hint="Flagged for review" />
          <Stat label="Differences" value={fmtN(s.differences)} />
        </dl>
      )}
      <Card>
        <CardHeader
          title="Differences"
          description={detail.data ? `Run of ${when(detail.data.startedAt)}` : undefined}
        />
        {!last ? (
          <Empty title="Not reconciled yet" />
        ) : detail.data?.status === 'failed' ? (
          <ErrorState error={new Error(String(detail.data.summary.error ?? 'The run failed'))} />
        ) : !detail.data ? (
          <Loading />
        ) : !detail.data.differences?.length ? (
          <Empty title="No differences">Supply360 and SampTrek agree.</Empty>
        ) : (
          <CardBody>
            <Table
              head={
                <>
                  <Th>Difference</Th>
                  <Th>Person</Th>
                  <Th>Session</Th>
                  <Th>Detail</Th>
                </>
              }
            >
              {detail.data.differences.slice(0, 200).map((d, i) => (
                <tr key={i}>
                  <Td>{DIFF_TEXT[d.kind] ?? d.kind}</Td>
                  <Td mono>{d.invitationId ? `…${d.invitationId.slice(-8)}` : '—'}</Td>
                  <Td mono>{d.session ?? '—'}</Td>
                  <Td>
                    <span className="text-xs text-muted">
                      {[d.had && `had ${d.had}`, d.source && `SampTrek ${d.source}`, d.status && `status ${d.status}`]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                  </Td>
                </tr>
              ))}
            </Table>
          </CardBody>
        )}
      </Card>
      <Card>
        <CardHeader title="Runs" />
        {runs.data?.items.length ? (
          <CardBody>
            <Table
              head={
                <>
                  <Th>Started</Th>
                  <Th>Status</Th>
                  <Th right>Sessions</Th>
                  <Th right>Applied</Th>
                  <Th right>Differences</Th>
                  <Th />
                </>
              }
            >
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <Td>{when(r.startedAt)}</Td>
                  <Td>
                    <Badge tone={r.status === 'finished' ? 'success' : 'danger'}>{r.status}</Badge>
                  </Td>
                  <Td right>{fmtN(r.summary.sessions)}</Td>
                  <Td right>{fmtN(r.summary.applied)}</Td>
                  <Td right>{fmtN(r.differenceCount)}</Td>
                  <Td right>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>
                      Show
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </CardBody>
        ) : (
          <Empty title="No runs yet" />
        )}
      </Card>
    </div>
  );
}

export function RewardsView() {
  const qc = useQueryClient();
  const canSync = useCan('rewards.sync');
  const q = useQuery({
    queryKey: ['fieldwork', 'rewards'],
    queryFn: () => api<{ totals: Record<string, number>; items: RewardRow[] }>('/rewards'),
  });
  const sync = useMutation({
    mutationFn: () => api<{ acknowledged: number; unavailable: number }>('/rewards/sync', { method: 'POST', body: {} }),
    onSuccess: (r) => {
      if (r.unavailable)
        toast.warning(`${r.unavailable} waiting: MADP has no reward endpoint yet, nothing was credited`);
      else toast.success(`${r.acknowledged} handed to MADP`);
      void qc.invalidateQueries({ queryKey: ['fieldwork'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <>
      <PageHeader
        title="Reward Event Synchronization"
        description="One reward event per client-approved complete, handed to MADP with an idempotency key so a retry is never paid twice. Supply360 never credits a wallet: the panel's own ledger does, after MADP accepts."
        actions={
          canSync && (
            <Button variant="primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
              Hand over now
            </Button>
          )
        }
      />
      {q.data && (
        <dl className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Waiting" value={fmtN(q.data.totals.pending ?? 0)} />
          <Stat label="Acknowledged by MADP" value={fmtN(q.data.totals.acknowledged ?? 0)} />
          <Stat
            label="MADP cannot take yet"
            value={fmtN(q.data.totals.unavailable ?? 0)}
            hint="Retried on Hand over now"
          />
        </dl>
      )}
      <Card>
        <CardHeader title="Reward events" />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : !q.data.items.length ? (
          <Empty title="No reward events yet">They appear once the client approves completes at SampTrek.</Empty>
        ) : (
          <CardBody>
            <Table
              head={
                <>
                  <Th>Created</Th>
                  <Th>Project</Th>
                  <Th>Person</Th>
                  <Th>Status</Th>
                  <Th>Idempotency key</Th>
                  <Th right>Attempts</Th>
                </>
              }
            >
              {q.data.items.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <span className="text-xs text-muted">{when(r.createdAt)}</span>
                  </Td>
                  <Td mono>{r.projectCode}</Td>
                  <Td mono>
                    {r.countryCode} …{r.invitationId.slice(-8)}
                  </Td>
                  <Td>
                    <Badge
                      tone={r.status === 'acknowledged' ? 'success' : r.status === 'pending' ? 'warning' : 'danger'}
                    >
                      {r.status}
                    </Badge>
                    {r.detail && <p className="mt-1 text-xs text-muted">{r.detail}</p>}
                  </Td>
                  <Td mono>{r.idempotencyKey.slice(0, 24)}…</Td>
                  <Td right>{r.attempts}</Td>
                </tr>
              ))}
            </Table>
          </CardBody>
        )}
      </Card>
    </>
  );
}
