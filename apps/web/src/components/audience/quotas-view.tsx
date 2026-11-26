'use client';
import type { AudienceCriteria, CellMapping } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, CircleCheck, CircleDashed, Link2, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
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
import {
  cellLabel,
  describeConditions,
  describeCriteria,
  fmtN,
  type Catalogue,
  type Counts,
  type ProjectQuotas,
  type QuotaCell,
} from '@/lib/audience';
import { fmtTime } from '@/lib/ingestion';
import { CountsView } from './counts-view';
import { CriteriaBuilder } from './criteria-builder';
import { ProjectPicker, useProjectParam } from './project-picker';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

export function QuotasView() {
  const canRead = useCan('projects.read');
  const canMap = useCan('quotas.manage');
  const canSelect = useCan('audience.select');
  const canCount = useCan('audience.read');
  const qc = useQueryClient();
  const { id, items, list, select } = useProjectParam();
  const [mapping, setMapping] = useState<QuotaCell | null>(null);
  const [reserving, setReserving] = useState<QuotaCell | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['quotas', id],
    queryFn: () => api<ProjectQuotas>(`/projects/${id}/quotas`),
    enabled: canRead && !!id,
  });
  const catalogue = useQuery({
    queryKey: ['audience-attributes'],
    queryFn: () => api<Catalogue>('/audience/attributes'),
    enabled: canCount,
    retry: false,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['quotas', id] });
    void qc.invalidateQueries({ queryKey: ['project', id] });
    void qc.invalidateQueries({ queryKey: ['selections'] });
  };
  const release = useMutation({
    mutationFn: ({ rid, reason }: { rid: string; reason: string }) =>
      api<{ released: number }>(`/projects/${id}/reservations/${rid}/release`, { method: 'POST', body: { reason } }),
    onSuccess: (r) => {
      toast.success(`Released ${r.released} people`);
      setReleasing(null);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!canRead) return <NoPermission permission="projects.read" />;
  const attrs = catalogue.data?.attributes ?? [];
  const data = q.data;

  return (
    <>
      <PageHeader
        title="Quota Management"
        description="SampTrek's quota cells for Supply360's markets, each mapped to MADP criteria, with people held per cell. A cell never holds more than its cap, however many requests arrive at once."
        actions={
          id && (
            <Button asChild variant="secondary">
              <Link href={`/allocation?project=${id}`}>Allocation and caps</Link>
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        {list.isLoading ? <Loading /> : <ProjectPicker id={id} items={items} onSelect={select} />}
        {data?.source ? (
          <span className="pb-2 text-xs text-muted">
            MADP: {data.source.name} {data.source.mode === 'fixture' && <Badge tone="demo">FIXTURE</Badge>}
            {data.panelInUse && <> · this project holds {data.panelInUse} people</>}
          </span>
        ) : (
          data && (
            <Link href="/integrations/madp" className="pb-2 text-xs text-accent underline underline-offset-2">
              Connect MADP to map and reserve
            </Link>
          )
        )}
      </div>
      {!items.length && !list.isLoading ? (
        <Card>
          <Empty title="No projects yet">Import projects from SampTrek first.</Empty>
        </Card>
      ) : q.isLoading || !data ? (
        q.error ? (
          <ErrorState error={q.error} />
        ) : (
          <Loading />
        )
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 md:grid-cols-2">
            {data.checks.map((c) => (
              <div
                key={c.key}
                className="flex items-start gap-2 rounded-lg border border-border bg-surface p-3 text-sm"
              >
                {c.ok ? (
                  <CircleCheck className="mt-0.5 size-4 text-success" aria-label="Passed" />
                ) : (
                  <CircleDashed className="mt-0.5 size-4 text-warning" aria-label="Not yet" />
                )}
                <div>
                  <p>{c.label}</p>
                  {c.detail && <p className="text-xs text-muted">{c.detail}</p>}
                </div>
              </div>
            ))}
          </div>
          <Card>
            <CardHeader
              title={`${data.projectCode} · ${data.name}`}
              description="Conditions are SampTrek's own; Supply360 only sees question and option ids."
            />
            {!data.cells.length ? (
              <Empty title="No quota cells">
                Supply360 is not a vendor in any market of this project, or the sync has not run.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted">
                      <th className="px-5 py-3 font-medium">Cell</th>
                      <th className="px-3 py-3 font-medium">MADP criteria</th>
                      <th className="px-3 py-3 text-right font-medium">SampTrek</th>
                      <th className="px-3 py-3 text-right font-medium">Supply360 needs</th>
                      <th className="px-3 py-3 text-right font-medium">Held / cap</th>
                      <th className="px-5 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.cells.map((c) => (
                      <tr key={c.id} className={c.removed || !c.isOpen ? 'opacity-60' : ''}>
                        <td className="px-5 py-3">
                          <p className="font-medium">{cellLabel(c)}</p>
                          <p className="text-xs text-muted">
                            {c.group && `${c.group} · `}
                            {describeConditions(c.conditions)}
                          </p>
                          {(c.removed || !c.isOpen) && (
                            <Badge tone="neutral">{c.removed ? 'Removed at SampTrek' : 'Closed'}</Badge>
                          )}
                        </td>
                        <td className="max-w-xs px-3 py-3 text-xs">
                          {c.criteria ? (
                            describeCriteria(c.criteria as AudienceCriteria, attrs)
                          ) : (
                            <Badge tone="warning">Not mapped</Badge>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {fmtN(c.sourceCompletes)} <span className="text-muted">/ {fmtN(c.sourceTarget)}</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{fmtN(c.allocation)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {fmtN(c.held)}{' '}
                          <span className="text-muted">/ {c.inviteCap ? fmtN(c.inviteCap) : 'no cap'}</span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex justify-end gap-1">
                            {canMap && !c.removed && (
                              <Button size="sm" variant="ghost" onClick={() => setMapping(c)} disabled={!data.source}>
                                <Link2 /> Map
                              </Button>
                            )}
                            {canSelect && !c.removed && c.isOpen && (
                              <Button
                                size="sm"
                                onClick={() => setReserving(c)}
                                disabled={!c.criteria || !c.inviteCap || c.held >= (c.inviteCap ?? 0)}
                                title={
                                  !c.criteria
                                    ? 'Map the cell first'
                                    : !c.inviteCap
                                      ? 'Set a cap in Allocation'
                                      : undefined
                                }
                              >
                                <UserPlus /> Reserve
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader
              title="Reservations"
              description="Held in MADP for this project. Holds end on their own when they expire."
            />
            {!data.reservations.length ? (
              <Empty title="Nothing reserved yet" />
            ) : (
              <ul className="divide-y divide-border">
                {data.reservations.map((r) => {
                  const cell = data.cells.find((c) => c.id === r.cellId);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                      <div>
                        <p>
                          <Users className="mr-1 inline size-3.5" aria-hidden />
                          {fmtN(r.held)} held for {cell ? cellLabel(cell) : 'a removed cell'}
                          {r.refused > 0 && <span className="text-muted"> · {r.refused} refused by MADP</span>}
                        </p>
                        <p className="text-xs text-muted">
                          {fmtTime(r.createdAt)} · expires {fmtTime(r.expiresAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={r.status === 'active' ? 'success' : 'neutral'}>{r.status}</Badge>
                        {canSelect && r.status === 'active' && (
                          <Button size="sm" variant="ghost" onClick={() => setReleasing(r.id)}>
                            Release
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      )}
      {mapping && id && (
        <MapDialog cell={mapping} projectId={id} attrs={attrs} onClose={() => setMapping(null)} onSaved={refresh} />
      )}
      {reserving && id && (
        <ReserveDialog cell={reserving} projectId={id} onClose={() => setReserving(null)} onDone={refresh} />
      )}
      <Dialog open={!!releasing} onOpenChange={(o) => !o && setReleasing(null)} title="Release these people">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason'));
            if (releasing) release.mutate({ rid: releasing, reason });
          }}
        >
          <div>
            <Label htmlFor="rel-reason">Reason (kept in the audit log)</Label>
            <Input id="rel-reason" name="reason" required minLength={3} />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="danger" disabled={release.isPending}>
              Release
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function MapDialog({
  cell,
  projectId,
  attrs,
  onClose,
  onSaved,
}: {
  cell: QuotaCell;
  projectId: string;
  attrs: Catalogue['attributes'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [criteria, setCriteria] = useState<AudienceCriteria>(
    (cell.criteria as AudienceCriteria) ?? { panels: ['t2o'] },
  );
  const feas = useMutation({
    mutationFn: () =>
      api<Counts>(`/projects/${projectId}/quotas/${cell.id}/feasibility`, { method: 'POST', body: { criteria } }),
    onError: (e) => toast.error(errMsg(e)),
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/quotas/${cell.id}/mapping`, {
        method: 'PUT',
        body: { criteria: { ...criteria, panels: criteria.panels ?? [] } } satisfies CellMapping,
      }),
    onSuccess: () => {
      toast.success(`Mapped ${cellLabel(cell)}`);
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Map ${cellLabel(cell)}`}
      description={`SampTrek: ${describeConditions(cell.conditions)}. Supply360 adds the market country (${cell.countryCode}).`}
    >
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        <CriteriaBuilder value={criteria} onChange={setCriteria} attributes={attrs} singlePanel showCountries={false} />
        {feas.data && <CountsView counts={feas.data} />}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => feas.mutate()} disabled={feas.isPending}>
          <Calculator /> Count
        </Button>
        <Button
          variant="primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || criteria.panels?.length !== 1}
        >
          Save mapping
        </Button>
      </div>
    </Dialog>
  );
}

function ReserveDialog({
  cell,
  projectId,
  onClose,
  onDone,
}: {
  cell: QuotaCell;
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const room = Math.max(0, (cell.inviteCap ?? 0) - cell.held);
  const [count, setCount] = useState(Math.min(room, 500));
  const [days, setDays] = useState(7);
  const run = useMutation({
    mutationFn: () =>
      api<{ held: number; cappedTo: number; requested: number; eligible: number | null; dataMode: string }>(
        `/projects/${projectId}/quotas/${cell.id}/reserve`,
        { method: 'POST', body: { count, expiresInDays: days } },
      ),
    onSuccess: (r) => {
      toast.success(
        `Held ${r.held} people${r.cappedTo < r.requested ? ` (capped from ${r.requested})` : ''}${r.dataMode === 'demo' ? ' · DEMO' : ''}`,
      );
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reserve for ${cellLabel(cell)}`}
      description={`${fmtN(cell.held)} held of a cap of ${fmtN(cell.inviteCap)}. Room for ${fmtN(room)} more.`}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="res-count">People</Label>
            <Input
              id="res-count"
              type="number"
              min={1}
              max={Math.min(room, 5000)}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </div>
          <div>
            <Label htmlFor="res-days">Hold for (days, at most 14)</Label>
            <Input
              id="res-days"
              type="number"
              min={1}
              max={14}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </div>
        </div>
        <p className="text-xs text-muted">
          MADP picks eligible people in a stable order and holds them for this project only. Nobody is contacted yet:
          invitations arrive in Phase 4.
        </p>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={run.isPending || count < 1 || count > room}>
            <UserPlus /> Reserve
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
