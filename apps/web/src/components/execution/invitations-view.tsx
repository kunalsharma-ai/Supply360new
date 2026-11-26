'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ProjectPicker, useProjectParam } from '@/components/audience/project-picker';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtN } from '@/lib/audience';
import { hh, type BatchRow, type ProjectExecution } from '@/lib/execution';
import { BatchesTable } from './batches-table';
import { errMsg, useBatchActions } from './use-batch-actions';

export function useProjectExecution(id: string | null) {
  return useQuery({
    queryKey: ['execution', 'project', id],
    queryFn: () => api<ProjectExecution>(`/projects/${id}/execution`),
    enabled: !!id,
  });
}

/** The checks that decide whether anything can be sent right now, in plain words. */
export function SendState({ d }: { d: ProjectExecution }) {
  const items: [string, boolean, string][] = [
    ['Emergency stop', !d.halted, d.halted ? `On: ${d.haltReason ?? ''}` : 'Off'],
    [
      'Project',
      d.dispatchAllowed,
      d.dispatchAllowed ? 'Live here and at SampTrek' : `Not live (${d.lifecycle.replace('_', ' ')})`,
    ],
    ['Policy', !!d.policy, d.policy ? `${d.policy.mode.replace('_', '-')} · version ${d.policy.version}` : 'Not set'],
    [
      'Quiet hours',
      !d.quietNow,
      d.policy
        ? d.policy.quietStartHour === d.policy.quietEndHour
          ? 'None'
          : `${hh(d.policy.quietStartHour)}–${hh(d.policy.quietEndHour)} ${d.policy.timezone}${d.quietNow ? ' (now)' : ''}`
        : '—',
    ],
    ['Today', !d.today || d.today.sent < d.today.max, d.today ? `${fmtN(d.today.sent)} of ${fmtN(d.today.max)}` : '—'],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-5">
      {items.map(([k, ok, v]) => (
        <div key={k} className="rounded-lg border border-border bg-surface-2 p-3">
          <dt className="flex items-center gap-1.5 text-xs text-muted">
            <span className={`size-2 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`} aria-hidden />
            {k}
          </dt>
          <dd className="mt-1 text-sm font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InvitationsView() {
  const qc = useQueryClient();
  const canDispatch = useCan('invitations.dispatch');
  const canApprove = useCan('execution.approve');
  const { id, items, list, select } = useProjectParam();
  const q = useProjectExecution(id);
  const { actions, dialog } = useBatchActions();
  const [cellId, setCellId] = useState('');
  const [size, setSize] = useState(10);
  const [at, setAt] = useState('');
  const [reason, setReason] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<BatchRow>(`/projects/${id}/batches`, {
        method: 'POST',
        body: { cellId, size, reason, ...(at ? { scheduledAt: new Date(at).toISOString() } : {}) },
      }),
    onSuccess: (b) => {
      if (b.status === 'sent')
        toast.success(`Sent ${b.sent} invitations${b.refused ? `, ${b.refused} refused by MADP` : ''}`);
      else if (b.status === 'proposed') toast.success('Proposed: it waits for someone who can approve');
      else if (b.blockedText) toast.warning(`${b.status === 'blocked' ? 'Stopped' : 'Waiting'}: ${b.blockedText}`);
      else toast.success(`Batch ${b.status}`);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['execution'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const d = q.data;
  const cells = d?.cells.filter((c) => c.mapped && c.isOpen) ?? [];
  const chosen = cells.find((c) => c.id === cellId) ?? cells[0];

  return (
    <>
      <PageHeader
        title="Survey Invitation Engine"
        description="Invite people Supply360 holds in MADP, in bounded batches. Every send rechecks consent, the project, quiet hours and the daily maximum first."
        actions={
          <>
            <Button asChild>
              <Link href={`/invitations/recontact${id ? `?project=${id}` : ''}`}>Recontact and reinvite</Link>
            </Button>
            {id && (
              <Button asChild>
                <Link href={`/automation?project=${id}`}>Mode and limits</Link>
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4">
        {list.isLoading ? <Loading /> : <ProjectPicker id={id} items={items} onSelect={select} />}
      </div>
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !d ? (
        !items.length && !list.isLoading ? (
          <Empty title="No projects yet" />
        ) : (
          <Loading />
        )
      ) : (
        <div className="space-y-4">
          <SendState d={d} />
          {!d.policy ? (
            <Card>
              <Empty
                title="No execution policy"
                action={
                  <Button asChild variant="primary">
                    <Link href={`/automation?project=${d.projectId}`}>Set the mode and limits</Link>
                  </Button>
                }
              >
                Nothing can be sent until someone sets the batch size, daily maximum, quiet hours and reminders for this
                project.
              </Empty>
            </Card>
          ) : (
            canDispatch && (
              <Card>
                <CardHeader
                  title="New batch"
                  description={
                    d.policy.mode === 'semi_auto' && !canApprove
                      ? 'Semi-automatic mode: your batch waits for someone with approval rights.'
                      : `At most ${fmtN(d.policy.batchSize)} per batch. Delivery is through MADP; nothing goes past the checks.`
                  }
                />
                <CardBody>
                  <form
                    className="grid items-end gap-3 sm:grid-cols-[2fr_1fr_1.5fr_2fr_auto]"
                    onSubmit={(e) => {
                      e.preventDefault();
                      create.mutate();
                    }}
                  >
                    <div>
                      <Label htmlFor="b-cell">Cell</Label>
                      <Select id="b-cell" value={chosen?.id ?? ''} onChange={(e) => setCellId(e.target.value)} required>
                        {cells.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.countryCode} · {c.name} ({fmtN(c.available)} to invite)
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="b-size">Size</Label>
                      <Input
                        id="b-size"
                        type="number"
                        min={1}
                        max={d.policy.batchSize}
                        value={size}
                        onChange={(e) => setSize(Number(e.target.value))}
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="b-at">Send at (optional)</Label>
                      <Input id="b-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="b-reason">Reason</Label>
                      <Input
                        id="b-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        minLength={3}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={create.isPending || !chosen}
                      onClick={() => chosen && setCellId(chosen.id)}
                    >
                      {at ? 'Schedule' : 'Send'}
                    </Button>
                  </form>
                </CardBody>
              </Card>
            )
          )}
          <Card>
            <CardHeader
              title="Invitations"
              description="One invitation per MADP reference per project, whatever the mode or retry."
              action={
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(d.invitations).map(([k, n]) => (
                    <Badge
                      key={k}
                      tone={k === 'clicked' ? 'success' : k === 'delivery_unavailable' ? 'danger' : 'neutral'}
                    >
                      {k.replace('_', ' ')} {fmtN(n)}
                    </Badge>
                  ))}
                </div>
              }
            />
            {d.batches.length ? (
              <CardBody>
                <BatchesTable rows={d.batches.map((b) => ({ ...b, ...cellOf(d, b.cellId) }))} actions={actions} />
              </CardBody>
            ) : (
              <Empty title="No batches yet" />
            )}
          </Card>
        </div>
      )}
      {dialog}
    </>
  );
}

export const cellOf = (d: ProjectExecution, id: string) => {
  const c = d.cells.find((x) => x.id === id);
  return c ? { countryCode: c.countryCode, cellName: c.name } : {};
};
