'use client';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtN } from '@/lib/audience';
import { hh, when, type BatchRow, type Overview } from '@/lib/execution';
import { BatchesTable } from './batches-table';
import { useBatchActions } from './use-batch-actions';

const Totals = ({
  t,
  tone,
}: {
  t: Record<string, number>;
  tone: (k: string) => 'neutral' | 'success' | 'warning' | 'danger';
}) => (
  <div className="flex flex-wrap gap-1.5">
    {Object.entries(t).map(([k, n]) => (
      <Badge key={k} tone={tone(k)}>
        {k.replace('_', ' ')} {fmtN(n)}
      </Badge>
    ))}
  </div>
);

interface ReminderRow {
  id: string;
  projectCode: string;
  countryCode: string;
  attempt: number;
  dueAt: string;
  status: string;
  reason: string | null;
  doneAt: string | null;
}

export function RemindersView() {
  const q = useQuery({
    queryKey: ['execution', 'reminders'],
    queryFn: () => api<{ totals: Record<string, number>; items: ReminderRow[] }>('/execution/reminders'),
  });
  return (
    <>
      <PageHeader
        title="Automatic Reminder Engine"
        description="Reminders go only to people who were invited and have not clicked. A click cancels every pending reminder at once; each reminder rechecks consent, the project and quiet hours before it goes."
      />
      <Card>
        <CardHeader
          title="Reminders"
          description="Times come from each project's policy."
          action={
            q.data && (
              <Totals
                t={q.data.totals}
                tone={(k) =>
                  k === 'sent' ? 'success' : k === 'blocked' ? 'danger' : k === 'pending' ? 'warning' : 'neutral'
                }
              />
            )
          }
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : !q.data.items.length ? (
          <Empty title="No reminders yet">
            They are planned when invitations are sent under a policy with reminder times.
          </Empty>
        ) : (
          <CardBody className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Market</th>
                  <th className="px-3 py-2 font-medium">Reminder</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="py-2 pl-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {q.data.items.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-3 font-mono text-xs">{r.projectCode}</td>
                    <td className="px-3 py-2">{r.countryCode}</td>
                    <td className="px-3 py-2">#{r.attempt}</td>
                    <td className="px-3 py-2 text-xs text-muted">{when(r.dueAt)}</td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          r.status === 'sent'
                            ? 'success'
                            : r.status === 'blocked'
                              ? 'danger'
                              : r.status === 'pending'
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-2 pl-3 text-xs text-muted">{r.reason?.replaceAll('_', ' ') ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        )}
      </Card>
    </>
  );
}

export function ScheduleView() {
  const b = useQuery({
    queryKey: ['execution', 'batches'],
    queryFn: () => api<{ items: BatchRow[] }>('/execution/batches'),
  });
  const ov = useQuery({ queryKey: ['execution', 'overview'], queryFn: () => api<Overview>('/execution/overview') });
  const { actions, dialog } = useBatchActions();
  const upcoming =
    b.data?.items.filter((x) => x.status === 'approved' || x.status === 'proposed' || x.status === 'sending') ?? [];
  return (
    <>
      <PageHeader
        title="Scheduling Engine"
        description="What is due to go out and when. The scheduler sends approved batches at their time, holds them in quiet hours or when the daily maximum is reached, and tries again by itself."
      />
      <div className="space-y-4">
        <Card>
          <CardHeader title="Upcoming and waiting" />
          {b.error ? (
            <ErrorState error={b.error} />
          ) : !b.data ? (
            <Loading />
          ) : upcoming.length ? (
            <CardBody>
              <BatchesTable rows={upcoming} showProject actions={actions} />
            </CardBody>
          ) : (
            <Empty title="Nothing scheduled" />
          )}
        </Card>
        <Card>
          <CardHeader
            title="Project calendars"
            description="Quiet hours, review interval and daily maximum per project, in its own time zone."
          />
          {!ov.data ? (
            <Loading />
          ) : !ov.data.projects.length ? (
            <Empty title="No project has an execution policy yet" />
          ) : (
            <CardBody className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="py-2 pr-3 font-medium">Project</th>
                    <th className="px-3 py-2 font-medium">Mode</th>
                    <th className="px-3 py-2 font-medium">Quiet hours</th>
                    <th className="px-3 py-2 text-right font-medium">Daily maximum</th>
                    <th className="px-3 py-2 font-medium">Review every</th>
                    <th className="py-2 pl-3 font-medium">Last review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ov.data.projects.map((p) => (
                    <tr key={p.projectId}>
                      <td className="py-2 pr-3">
                        <span className="font-mono text-xs">{p.projectCode}</span> {p.name}
                      </td>
                      <td className="px-3 py-2">{p.mode.replace('_', '-')}</td>
                      <td className="px-3 py-2">
                        {p.quietStartHour === p.quietEndHour ? 'None' : `${hh(p.quietStartHour)}–${hh(p.quietEndHour)}`}{' '}
                        <span className="text-xs text-muted">{p.timezone}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtN(p.dailyMax)}</td>
                      <td className="px-3 py-2">{p.reviewIntervalMinutes} min</td>
                      <td className="py-2 pl-3 text-xs text-muted">{when(p.lastReviewAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          )}
        </Card>
      </div>
      {dialog}
    </>
  );
}

interface RouterRow {
  id: string;
  projectCode: string | null;
  kind: string;
  reason: string | null;
  at: string;
}

export function RouterView() {
  const q = useQuery({
    queryKey: ['execution', 'router'],
    queryFn: () =>
      api<{ since: string; totals: Record<string, number>; items: RouterRow[] }>('/execution/router-events'),
  });
  return (
    <>
      <PageHeader
        title="Survey Router"
        description="Every participation link points here. The token in it is opaque and signed; people go to the entry link a person approved for their market, with the token as SampTrek's [UID]. Link scanners and mail gateways are counted apart and never as clicks."
      />
      <Card>
        <CardHeader
          title="Last 7 days"
          action={
            q.data && (
              <Totals
                t={q.data.totals}
                tone={(k) =>
                  k === 'click' ? 'success' : k === 'prefetch' ? 'warning' : k === 'invalid' ? 'danger' : 'neutral'
                }
              />
            )
          }
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : !q.data.items.length ? (
          <Empty title="No link visits yet" />
        ) : (
          <CardBody className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">What happened</th>
                  <th className="py-2 pl-3 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {q.data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 pr-3 text-xs text-muted">{when(e.at)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{e.projectCode ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          e.kind === 'click'
                            ? 'success'
                            : e.kind === 'prefetch'
                              ? 'warning'
                              : e.kind === 'invalid'
                                ? 'danger'
                                : 'neutral'
                        }
                      >
                        {e.kind}
                      </Badge>
                    </td>
                    <td className="py-2 pl-3 text-xs text-muted">{e.reason?.replaceAll('_', ' ') ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        )}
      </Card>
    </>
  );
}
