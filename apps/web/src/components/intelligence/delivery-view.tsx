'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { errMsg } from '@/components/execution/use-batch-actions';
import { Bar, Stat, Table, Td, Th } from '@/components/fieldwork/fieldwork-views';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtN } from '@/lib/audience';
import {
  p1,
  RISK_TONE,
  type Assumptions,
  type PortfolioRow,
  type ProjectForecast,
  type Rate,
} from '@/lib/intelligence';

const BASIS: Record<Rate['basis'], string> = {
  observed: 'Observed',
  assumption: 'Assumption',
  source_brief: 'SampTrek brief',
};

function RateRow({ name, def, r }: { name: string; def: string; r: Rate }) {
  return (
    <tr>
      <Td>
        <span className="font-medium">{name}</span>
        <span className="block text-xs text-muted">{def}</span>
      </Td>
      <Td right>{p1(r.value)}</Td>
      <Td right>
        {p1(r.low)} to {p1(r.high)}
      </Td>
      <Td right>
        {fmtN(r.numerator)} / {fmtN(r.denominator)}
      </Td>
      <Td>
        <Badge tone={r.basis === 'observed' ? 'success' : 'warning'}>{BASIS[r.basis]}</Badge>
      </Td>
    </tr>
  );
}

function ProjectDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['forecast', id], queryFn: () => api<ProjectForecast>(`/projects/${id}/forecast`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const f = q.data!;
  const need = f.invitationsNeeded;
  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="forecast-detail">
      <Card className="lg:col-span-2">
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              {f.project.projectCode} · {f.project.name}
              <Badge tone={RISK_TONE[f.risk]}>{f.riskLabel}</Badge>
            </span>
          }
          description={`Forecast ${f.modelVersion}. A range from observed rates, or labelled assumptions where data is thin. Never a guarantee.`}
        />
        <CardBody>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Completes"
              value={`${fmtN(f.complete)} / ${fmtN(f.target)}`}
              hint={`${fmtN(f.remaining.provisional)} left (${fmtN(f.remaining.approved)} by client-approved)`}
            />
            <Stat
              label="Invitations needed"
              value={need ? fmtN(need.value) : '—'}
              hint={need ? `${fmtN(need.low)} to ${fmtN(need.high)}` : 'No target or no rate yet'}
            />
            <Stat
              label="People held, not invited"
              value={fmtN(f.heldNotInvited)}
              hint={f.shortfall ? `${fmtN(f.shortfall)} short: hold more in Quotas` : 'Enough held'}
            />
            <Stat
              label="Pace (last 3 days)"
              value={`${f.pace.perDay} a day`}
              hint={
                f.pace.neededPerDay == null
                  ? 'No field end date'
                  : `${f.pace.neededPerDay} a day needed, ${f.project.daysLeft} days left`
              }
            />
          </dl>
          {f.assumptionsUsed.length > 0 && (
            <p
              className="mt-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
              role="note"
            >
              Uses labelled values until there is enough data: {f.assumptionsUsed.join('; ')}.
            </p>
          )}
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader
          title="Rates behind the forecast"
          description="Invitations needed = remaining ÷ (start rate × qualification rate × qualified-to-complete rate). Qualification is counted once. Ranges are 90% intervals."
        />
        <CardBody>
          <Table
            head={
              <>
                <Th>Rate</Th>
                <Th right>Value</Th>
                <Th right>Range</Th>
                <Th right>Sample</Th>
                <Th>Basis</Th>
              </>
            }
          >
            <RateRow name="Start rate" def="Sessions started ÷ invitations sent over 48 hours ago" r={f.rates.start} />
            <RateRow
              name="Qualification rate"
              def="(Completes + quality fails) ÷ (those + terminates)"
              r={f.rates.qualification}
            />
            <RateRow
              name="Qualified to complete"
              def="Completes ÷ (completes + quality fails)"
              r={f.rates.qualifiedToComplete}
            />
          </Table>
          <p className="mt-3 text-xs text-muted">
            Completes per invitation: {p1(f.completesPerInvite.value)} ({p1(f.completesPerInvite.low)} to{' '}
            {p1(f.completesPerInvite.high)}).
            {f.projectedCompletesByDeadline &&
              ` Projected by the field end date: ${fmtN(f.projectedCompletesByDeadline.low)} to ${fmtN(f.projectedCompletesByDeadline.high)} completes.`}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Next batch, recommended"
          description="Inside the project's execution limits. A person still creates and sends it."
        />
        <CardBody className="space-y-3 text-sm">
          <p className="text-2xl font-semibold tabular-nums" data-testid="recommended-size">
            {fmtN(f.recommendation.size)}
          </p>
          <p className="text-muted">{f.recommendation.why}</p>
          <Link className="text-accent underline" href={`/invitations?project=${f.project.id}`}>
            Open invitations
          </Link>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Quota cells behind"
          description="Open cells more than 20 points behind the share of field time used."
        />
        <CardBody>
          {f.underperformingCells.length ? (
            <ul className="space-y-3 text-sm">
              {f.underperformingCells.map((c) => (
                <li key={c.id}>
                  <div className="flex justify-between gap-2">
                    <span>
                      {c.countryCode} · {c.name}
                    </span>
                    <span className="tabular-nums text-muted">
                      {c.progress}% vs {c.expected}% of time
                    </span>
                  </div>
                  <Bar value={c.progress} max={100} label={`${c.name}: ${c.progress}% of target`} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">
              No cell is behind{f.project.daysLeft == null ? ' (no field dates to compare with)' : ''}.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function AssumptionsCard() {
  const canManage = useCan('settings.manage');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['assumptions'], queryFn: () => api<Assumptions>('/intelligence/assumptions') });
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: (body: unknown) => api('/intelligence/assumptions', { method: 'PUT', body }),
    onSuccess: () => {
      setOpen(false);
      toast.success('Assumptions saved');
      void qc.invalidateQueries({ queryKey: ['assumptions'] });
      void qc.invalidateQueries({ queryKey: ['forecast'] });
      void qc.invalidateQueries({ queryKey: ['delivery'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const a = q.data;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({
      startRatePercent: Number(f.get('s')),
      qualificationRatePercent: Number(f.get('q')),
      qualifiedToCompletePercent: Number(f.get('c')),
      reason: f.get('reason'),
    });
  };
  return (
    <Card>
      <CardHeader
        title="Cold-start assumptions"
        description="Used only while a rate has too little data (100 matured invitations, 30 screened, 20 qualified), and always labelled."
        action={
          canManage && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <SlidersHorizontal /> Edit
            </Button>
          )
        }
      />
      <CardBody>
        {a && (
          <dl className="grid grid-cols-3 gap-3">
            <Stat label="Start rate" value={`${a.startRatePercent}%`} />
            <Stat
              label="Qualification"
              value={`${a.qualificationRatePercent}%`}
              hint="The SampTrek brief IR is used first"
            />
            <Stat label="Qualified to complete" value={`${a.qualifiedToCompletePercent}%`} />
          </dl>
        )}
        {a && !a.configured && (
          <p className="mt-3 text-xs text-muted">These are the built-in defaults. Set your own from panel history.</p>
        )}
      </CardBody>
      <Dialog open={open} onOpenChange={setOpen} title="Cold-start assumptions">
        <form className="space-y-4" onSubmit={onSubmit}>
          {(
            [
              ['s', 'Start rate %', a?.startRatePercent],
              ['q', 'Qualification rate %', a?.qualificationRatePercent],
              ['c', 'Qualified to complete %', a?.qualifiedToCompletePercent],
            ] as const
          ).map(([k, l, v]) => (
            <div key={k}>
              <Label htmlFor={`as-${k}`}>{l}</Label>
              <Input id={`as-${k}`} name={k} type="number" step="0.1" min={0.1} max={100} required defaultValue={v} />
            </div>
          ))}
          <div>
            <Label htmlFor="as-reason">Reason</Label>
            <Input id="as-reason" name="reason" required minLength={3} maxLength={300} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

export function DeliveryView() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get('project');
  const q = useQuery({
    queryKey: ['delivery'],
    queryFn: () => api<{ modelVersion: string; items: PortfolioRow[] }>('/intelligence/delivery'),
    refetchInterval: 60_000,
  });
  return (
    <>
      <PageHeader
        title="AI Delivery Intelligence"
        description="How many invitations each project still needs, whether it will make its field end date, and which quota cells are behind. Recommendations only: execution limits decide what is sent."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Active projects" description="Riskiest first. Pick one for the full forecast." />
          <CardBody>
            {q.isLoading ? (
              <Loading />
            ) : q.error ? (
              <ErrorState error={q.error} />
            ) : !q.data?.items.length ? (
              <Empty title="No active projects">
                Projects appear here once they are ready, live, paused or on hold at SampTrek.
              </Empty>
            ) : (
              <Table
                head={
                  <>
                    <Th>Project</Th>
                    <Th>Risk</Th>
                    <Th right>Completes</Th>
                    <Th right>Per day / needed</Th>
                    <Th right>Invitations needed</Th>
                    <Th right>Held</Th>
                    <Th right>Cells behind</Th>
                  </>
                }
              >
                {q.data.items.map((r) => (
                  <tr key={r.id} data-testid="delivery-row" className={r.id === selected ? 'bg-accent/5' : ''}>
                    <Td>
                      <button
                        type="button"
                        className="text-left text-accent underline"
                        onClick={() => router.replace(`/intelligence/delivery?project=${r.id}`)}
                      >
                        {r.projectCode}
                      </button>
                      <span className="block text-xs text-muted">{r.name}</span>
                    </Td>
                    <Td>
                      <Badge tone={RISK_TONE[r.risk]}>{r.riskLabel}</Badge>
                      {r.usesAssumptions && <span className="block text-[11px] text-muted">uses assumptions</span>}
                    </Td>
                    <Td right>
                      {fmtN(r.complete)} / {fmtN(r.target)}
                    </Td>
                    <Td right>
                      {r.pace.perDay} / {r.pace.neededPerDay ?? '—'}
                    </Td>
                    <Td right>
                      {r.invitationsNeeded
                        ? `${fmtN(r.invitationsNeeded.low)} to ${fmtN(r.invitationsNeeded.high)}`
                        : '—'}
                    </Td>
                    <Td right>{fmtN(r.heldNotInvited)}</Td>
                    <Td right>{r.underperformingCells}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </CardBody>
        </Card>
        {selected && <ProjectDetail id={selected} />}
        <AssumptionsCard />
      </div>
    </>
  );
}
