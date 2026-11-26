'use client';
import { OUTCOME_LABELS, OUTCOMES } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ProjectPicker, useProjectParam } from '@/components/audience/project-picker';
import { errMsg } from '@/components/execution/use-batch-actions';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtN } from '@/lib/audience';
import { when } from '@/lib/execution';
import {
  effectText,
  mins,
  OUTCOME_TONE,
  pct,
  SOURCE_LABEL,
  type Dropout,
  type EventRow,
  type Fieldwork,
  type LiveRow,
} from '@/lib/fieldwork';

export function useFieldwork(id: string | null) {
  return useQuery({
    queryKey: ['fieldwork', 'project', id],
    queryFn: () => api<Fieldwork>(`/projects/${id}/fieldwork`),
    enabled: !!id,
    refetchInterval: 15_000,
  });
}

/** Project picker plus the loading, error and empty states every per-project page shares. */
export function WithProject({ children }: { children: (id: string, fw: Fieldwork) => ReactNode }) {
  const { id, items, list, select } = useProjectParam();
  const q = useFieldwork(id);
  return (
    <>
      <div className="mb-4">
        {list.isLoading ? <Loading /> : <ProjectPicker id={id} items={items} onSelect={select} />}
      </div>
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !q.data || !id ? (
        !items.length && !list.isLoading ? (
          <Empty title="No projects yet" />
        ) : (
          <Loading />
        )
      ) : (
        children(id, q.data)
      )}
    </>
  );
}

export const Th = ({ children, right }: { children?: ReactNode; right?: boolean }) => (
  <th className={`px-3 py-2 font-medium first:pl-0 ${right ? 'text-right' : ''}`}>{children}</th>
);
export const Td = ({ children, right, mono }: { children?: ReactNode; right?: boolean; mono?: boolean }) => (
  <td className={`px-3 py-2 first:pl-0 ${right ? 'text-right tabular-nums' : ''} ${mono ? 'font-mono text-xs' : ''}`}>
    {children}
  </td>
);
export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">{head}</tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}

/** A horizontal bar with its value as text beside it, so the number never depends on the bar. */
export function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="img" aria-label={label} className="h-2 w-full min-w-16 overflow-hidden rounded-full bg-surface-3">
      <div className="h-full rounded-full bg-accent" style={{ width: `${w}%` }} />
    </div>
  );
}

function Funnel({ fw }: { fw: Fieldwork }) {
  const t = fw.total;
  return (
    <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Invited" value={fmtN(t.sent)} />
      <Stat label="Opened link" value={fmtN(t.clicked)} hint="From Supply360's router" />
      <Stat label="Started" value={fmtN(t.started)} hint="Reported by SampTrek, never inferred" />
      <Stat
        label="Completes"
        value={fmtN(t.complete)}
        hint={`${fmtN(t.approved)} approved · ${fmtN(t.pendingApproval)} pending`}
      />
      <Stat label="Incidence" value={pct(t.incidence)} hint="Completes ÷ (completes + terminates)" />
      <Stat label="Median LOI" value={mins(fw.loi.median)} hint={`${fmtN(fw.loi.n)} completes with a start time`} />
    </dl>
  );
}

export function LiveView() {
  const live = useQuery({
    queryKey: ['fieldwork', 'live'],
    queryFn: () => api<{ items: LiveRow[] }>('/fieldwork/live'),
    refetchInterval: 15_000,
  });
  const { id, items, list, select } = useProjectParam();
  const fw = useFieldwork(id);
  return (
    <>
      <PageHeader
        title="Live Fieldwork Monitoring"
        description="Progress from verified sources only: SampTrek's signed S2S callbacks and its sessions API. Refreshes every 15 seconds."
      />
      <Card className="mb-4">
        <CardHeader title="All projects" description="Supply360's own completes against its vendor target." />
        {live.error ? (
          <ErrorState error={live.error} />
        ) : !live.data ? (
          <Loading />
        ) : (
          <CardBody>
            <Table
              head={
                <>
                  <Th>Project</Th>
                  <Th>State</Th>
                  <Th right>Invited</Th>
                  <Th right>Opened</Th>
                  <Th right>Started</Th>
                  <Th right>Completes</Th>
                  <Th>Progress</Th>
                  <Th right>Incidence</Th>
                </>
              }
            >
              {live.data.items.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <button className="text-left hover:underline" onClick={() => select(r.id)}>
                      <span className="font-mono text-xs">{r.projectCode}</span>
                      <span className="block text-xs text-muted">{r.name}</span>
                    </button>
                  </Td>
                  <Td>
                    <Badge tone={r.lifecycle === 'live' ? 'success' : 'neutral'}>{r.lifecycle.replace('_', ' ')}</Badge>
                  </Td>
                  <Td right>{fmtN(r.sent)}</Td>
                  <Td right>{fmtN(r.clicked)}</Td>
                  <Td right>{fmtN(r.started)}</Td>
                  <Td right>
                    {fmtN(r.complete)} / {fmtN(r.target)}
                  </Td>
                  <Td>
                    <Bar value={r.complete} max={r.target} label={`${r.complete} of ${r.target} completes`} />
                  </Td>
                  <Td right>{pct(r.incidence)}</Td>
                </tr>
              ))}
            </Table>
          </CardBody>
        )}
      </Card>
      <div className="mb-4">
        {list.isLoading ? <Loading /> : <ProjectPicker id={id} items={items} onSelect={select} />}
      </div>
      {fw.error ? (
        <ErrorState error={fw.error} />
      ) : !fw.data ? (
        id ? (
          <Loading />
        ) : null
      ) : (
        <div className="space-y-4">
          <Funnel fw={fw.data} />
          <Card>
            <CardHeader
              title="Outcomes"
              description={
                fw.data.project.daysLeft != null
                  ? `${fw.data.project.daysLeft > 0 ? `${fw.data.project.daysLeft} days left in field` : 'Field end date passed: sending has stopped'}`
                  : 'No field end date'
              }
              action={
                fw.data.openFlags > 0 && (
                  <Button asChild size="sm">
                    <Link href={`/quality?project=${fw.data.project.id}`}>
                      {fw.data.openFlags} {fw.data.openFlags === 1 ? 'flag' : 'flags'} to review
                    </Link>
                  </Button>
                )
              }
            />
            <CardBody className="flex flex-wrap gap-1.5">
              {OUTCOMES.map((o) => (
                <Badge key={o} tone={OUTCOME_TONE(o)}>
                  {OUTCOME_LABELS[o]} {fmtN(fw.data.total[o])}
                </Badge>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Markets" description="Sending stops by itself once a market's target is reached." />
            <CardBody>
              <Table
                head={
                  <>
                    <Th>Market</Th>
                    <Th right>Completes</Th>
                    <Th>Progress</Th>
                    <Th right>Remaining</Th>
                    <Th right>Terminates</Th>
                    <Th right>Quota full</Th>
                    <Th right>Incidence</Th>
                  </>
                }
              >
                {fw.data.markets.map((m) => (
                  <tr key={m.countryCode}>
                    <Td mono>{m.countryCode}</Td>
                    <Td right>
                      {fmtN(m.complete)} / {fmtN(m.target)}
                    </Td>
                    <Td>
                      <Bar value={m.complete} max={m.target ?? 0} label={`${m.complete} of ${m.target ?? 0}`} />
                    </Td>
                    <Td right>{fmtN(m.remaining)}</Td>
                    <Td right>{fmtN(m.terminate)}</Td>
                    <Td right>{fmtN(m.quota_full)}</Td>
                    <Td right>{pct(m.incidence)}</Td>
                  </tr>
                ))}
              </Table>
            </CardBody>
          </Card>
          <CellsCard fw={fw.data} />
        </div>
      )}
    </>
  );
}

function CellsCard({ fw }: { fw: Fieldwork }) {
  return (
    <Card>
      <CardHeader title="Quota cells" description="A cell with all the completes it needs stops sending." />
      <CardBody>
        <Table
          head={
            <>
              <Th>Cell</Th>
              <Th right>Completes</Th>
              <Th>Progress</Th>
              <Th right>Terminates</Th>
              <Th right>Incidence</Th>
              <Th>State</Th>
            </>
          }
        >
          {fw.cells.map((c) => (
            <tr key={c.id}>
              <Td>
                {c.countryCode} · {c.group ? `${c.group}: ` : ''}
                {c.name}
              </Td>
              <Td right>
                {fmtN(c.complete)} / {fmtN(c.target)}
              </Td>
              <Td>
                <Bar value={c.complete} max={c.target ?? 0} label={`${c.complete} of ${c.target ?? 0}`} />
              </Td>
              <Td right>{fmtN(c.terminate)}</Td>
              <Td right>{pct(c.incidence)}</Td>
              <Td>
                {c.reached ? (
                  <Badge tone="success">target reached</Badge>
                ) : c.isOpen ? (
                  <Badge>open</Badge>
                ) : (
                  <Badge tone="warning">closed at source</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </CardBody>
    </Card>
  );
}

export function IrView() {
  return (
    <>
      <PageHeader
        title="IR Intelligence"
        description="Actual incidence with its denominator stated: completes ÷ (completes + terminates). Quota fulls, quality fails and security rejects are shown beside it, not mixed in."
      />
      <WithProject>
        {(_, fw) => (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-4">
              <Stat label="Actual incidence" value={pct(fw.total.incidence)} />
              <Stat label="Completes" value={fmtN(fw.total.complete)} />
              <Stat label="Terminates" value={fmtN(fw.total.terminate)} />
              <Stat label="Quota full" value={fmtN(fw.total.quota_full)} hint="Not in the denominator" />
            </dl>
            <Card>
              <CardHeader title="By market" description="Expected incidence is what SampTrek's brief says." />
              <CardBody>
                <Table
                  head={
                    <>
                      <Th>Market</Th>
                      <Th right>Expected</Th>
                      <Th right>Actual</Th>
                      <Th right>Difference</Th>
                      <Th right>Completes</Th>
                      <Th right>Terminates</Th>
                      <Th right>Quality fail</Th>
                      <Th right>Security</Th>
                    </>
                  }
                >
                  {fw.markets.map((m) => {
                    const d =
                      m.incidence != null && m.expectedIrPercent != null ? m.incidence - m.expectedIrPercent : null;
                    return (
                      <tr key={m.countryCode}>
                        <Td mono>{m.countryCode}</Td>
                        <Td right>{pct(m.expectedIrPercent)}</Td>
                        <Td right>{pct(m.incidence)}</Td>
                        <Td right>
                          {d == null ? (
                            '—'
                          ) : (
                            <span className={d < -10 ? 'text-danger' : d > 10 ? 'text-success' : ''}>
                              {d > 0 ? '+' : ''}
                              {Math.round(d * 10) / 10} pts
                            </span>
                          )}
                        </Td>
                        <Td right>{fmtN(m.complete)}</Td>
                        <Td right>{fmtN(m.terminate)}</Td>
                        <Td right>{fmtN(m.quality_fail)}</Td>
                        <Td right>{fmtN(m.security_reject + m.duplicate)}</Td>
                      </tr>
                    );
                  })}
                </Table>
              </CardBody>
            </Card>
            <CellsCard fw={fw} />
          </div>
        )}
      </WithProject>
    </>
  );
}

export function LoiView() {
  return (
    <>
      <PageHeader
        title="LOI Intelligence"
        description="Length of interview of completes, from the start and end times SampTrek reports. Completes without a reported start are left out, never guessed."
      />
      <WithProject>
        {(id, fw) => {
          const max = Math.max(1, ...fw.loi.histogram.map((b) => b.n));
          return (
            <div className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-5">
                <Stat label="Completes measured" value={fmtN(fw.loi.n)} />
                <Stat label="25th percentile" value={mins(fw.loi.p25)} />
                <Stat label="Median" value={mins(fw.loi.median)} />
                <Stat label="75th percentile" value={mins(fw.loi.p75)} />
                <Stat
                  label="Speeder rule"
                  value={fw.speederPercent ? `< ${fw.speederPercent}%` : 'Off'}
                  hint={
                    <Link className="underline" href={`/automation?project=${id}`}>
                      Set in the policy
                    </Link>
                  }
                />
              </dl>
              <Card>
                <CardHeader
                  title="Distribution"
                  description={`Buckets of ${fw.loi.bucketMinutes} minutes; the last one is open-ended.`}
                />
                <CardBody>
                  {fw.loi.n === 0 ? (
                    <Empty title="No measured completes yet">LOI appears after SampTrek reports start times.</Empty>
                  ) : (
                    <Table
                      head={
                        <>
                          <Th>Minutes</Th>
                          <Th>Share</Th>
                          <Th right>Completes</Th>
                        </>
                      }
                    >
                      {fw.loi.histogram.map((b, i) => (
                        <tr key={b.from}>
                          <Td mono>
                            {b.from}
                            {i === fw.loi.histogram.length - 1 ? '+' : `–${b.from + fw.loi.bucketMinutes}`}
                          </Td>
                          <Td>
                            <Bar value={b.n} max={max} label={`${b.n} completes`} />
                          </Td>
                          <Td right>{fmtN(b.n)}</Td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="By market" />
                <CardBody>
                  <Table
                    head={
                      <>
                        <Th>Market</Th>
                        <Th right>Expected</Th>
                        <Th right>Median actual</Th>
                      </>
                    }
                  >
                    {fw.markets.map((m) => (
                      <tr key={m.countryCode}>
                        <Td mono>{m.countryCode}</Td>
                        <Td right>{mins(m.expectedLoiMinutes)}</Td>
                        <Td right>{mins(m.medianLoiMinutes)}</Td>
                      </tr>
                    ))}
                  </Table>
                </CardBody>
              </Card>
            </div>
          );
        }}
      </WithProject>
    </>
  );
}

interface Source {
  id: string;
  mode: 'fixture' | 'live';
  enabled: boolean;
}
export function useFixtureSource() {
  const q = useQuery({ queryKey: ['sources'], queryFn: () => api<{ items: Source[] }>('/sources') });
  return q.data?.items.find((s) => s.mode === 'fixture' && s.enabled) ?? null;
}

/** FIXTURE only: plays a respondent finishing, through SampTrek's real signed callback path. */
function Simulator({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const src = useFixtureSource();
  const canManage = useCan('integrations.manage');
  const opened = useQuery({
    queryKey: ['fieldwork', 'dropouts', projectId, 'not_started'],
    queryFn: () =>
      api<{ items: Dropout[] }>(`/projects/${projectId}/dropouts?kinds=not_clicked,not_started,not_finished,partial`),
    enabled: !!src && canManage,
  });
  const [inv, setInv] = useState('');
  const [status, setStatus] = useState('complete');
  const [loi, setLoi] = useState(12);
  const play = useMutation({
    mutationFn: () =>
      api<{ status: string; effect?: string }>(`/sources/${src!.id}/fixture/outcome`, {
        method: 'POST',
        body: { invitationId: inv || opened.data!.items[0]!.invitationId, status, loiMinutes: loi },
      }),
    onSuccess: (r) => {
      toast.success(`SampTrek callback ${r.status}${r.effect ? `: ${effectText(r.effect)}` : ''}`);
      setInv('');
      void qc.invalidateQueries({ queryKey: ['fieldwork'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!src || !canManage) return null;
  const people = opened.data?.items ?? [];
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Play a respondent <Badge tone="demo">FIXTURE</Badge>
          </span>
        }
        description="Opens the person's link through the real survey router if they have not, then sends a signed S2S callback exactly as SampTrek would, so you can watch Supply360 react."
      />
      <CardBody>
        {!people.length ? (
          <p className="text-sm text-muted">Nobody in this project is waiting to finish.</p>
        ) : (
          <form
            className="grid items-end gap-3 sm:grid-cols-[2fr_1.5fr_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              play.mutate();
            }}
          >
            <div>
              <Label htmlFor="sim-person">Person</Label>
              <Select id="sim-person" value={inv} onChange={(e) => setInv(e.target.value)}>
                {people.map((p) => (
                  <option key={p.invitationId} value={p.invitationId}>
                    {p.countryCode} {p.person} ({p.dropout?.replaceAll('_', ' ')})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="sim-status">Outcome at SampTrek</Label>
              <Select id="sim-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {OUTCOME_LABELS[o]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="sim-loi">LOI (minutes)</Label>
              <Input
                id="sim-loi"
                type="number"
                min={0.1}
                step={0.1}
                value={loi}
                onChange={(e) => setLoi(Number(e.target.value))}
              />
            </div>
            <Button type="submit" variant="primary" disabled={play.isPending}>
              Send callback
            </Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

export function ParticipationView() {
  return (
    <>
      <PageHeader
        title="Participation Tracker"
        description="Every event from a verified source, append-only. A retry or a second source reporting the same thing is stored once and never counts twice; what each event did is shown beside it."
      />
      <WithProject>{(id, fw) => <Participation id={id} fw={fw} />}</WithProject>
    </>
  );
}

function Participation({ id, fw }: { id: string; fw: Fieldwork }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['fieldwork', 'events', id, cursor],
    queryFn: () =>
      api<{ items: EventRow[]; nextCursor: string | null }>(
        `/projects/${id}/participation?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    refetchInterval: cursor ? false : 15_000,
  });
  return (
    <div className="space-y-4">
      <Funnel fw={fw} />
      <Simulator projectId={id} />
      <Card>
        <CardHeader
          title="Events"
          description="Newest first. People are shown by invitation only: no names or emails."
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : !q.data.items.length ? (
          <Empty title="No participation events yet">
            They arrive from SampTrek&apos;s S2S callbacks, and from its sessions API when the project is reconciled.
          </Empty>
        ) : (
          <CardBody>
            <Table
              head={
                <>
                  <Th>Received</Th>
                  <Th>Person</Th>
                  <Th>Event</Th>
                  <Th>Source</Th>
                  <Th>Effect</Th>
                  <Th>Session</Th>
                </>
              }
            >
              {q.data.items.map((e) => (
                <tr key={e.id}>
                  <Td>
                    <span className="text-xs text-muted">{when(e.receivedAt)}</span>
                  </Td>
                  <Td mono>
                    {e.countryCode} …{e.invitationId.slice(-8)}
                  </Td>
                  <Td>
                    <Badge tone={OUTCOME_TONE(e.kind)}>{e.kind.replaceAll('_', ' ')}</Badge>
                  </Td>
                  <Td>
                    <span className="text-xs">{SOURCE_LABEL[e.source] ?? e.source}</span>
                  </Td>
                  <Td>
                    <span className={`text-xs ${e.effect === 'conflict' ? 'text-danger' : 'text-muted'}`}>
                      {effectText(e.effect)}
                    </span>
                  </Td>
                  <Td mono>{e.sessionRef ?? '—'}</Td>
                </tr>
              ))}
            </Table>
            <div className="mt-3 flex justify-end gap-2">
              {cursor && (
                <Button size="sm" onClick={() => setCursor(null)}>
                  Newest
                </Button>
              )}
              {q.data.nextCursor && (
                <Button size="sm" onClick={() => setCursor(q.data.nextCursor)}>
                  Older
                </Button>
              )}
            </div>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
