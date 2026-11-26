'use client';
import { ALLOCATION_LABELS, AllocationMode } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { cellLabel, fmtN, type ProjectQuotas } from '@/lib/audience';
import { ProjectPicker, useProjectParam } from './project-picker';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

export function AllocationView() {
  const canManage = useCan('allocation.manage');
  const qc = useQueryClient();
  const { id, items, list, select } = useProjectParam();
  const q = useQuery({
    queryKey: ['quotas', id],
    queryFn: () => api<ProjectQuotas>(`/projects/${id}/quotas`),
    enabled: canManage && !!id,
  });
  const [mode, setMode] = useState<AllocationMode>('proportional');
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [caps, setCaps] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!q.data) return;
    setMode(q.data.allocationMode);
    const live = q.data.cells.filter((c) => !c.removed);
    setTargets(Object.fromEntries(live.map((c) => [c.id, c.allocation])));
    setCaps(Object.fromEntries(live.map((c) => [c.id, c.inviteCap ?? c.suggestedCap])));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api<{ targets: Record<string, number> }>(`/projects/${id}/allocation`, {
        method: 'PUT',
        body: { mode, caps, ...(mode === 'manual' ? { targets } : {}) },
      }),
    onSuccess: () => {
      toast.success('Allocation saved');
      void qc.invalidateQueries({ queryKey: ['quotas', id] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!canManage) return <NoPermission permission="allocation.manage" />;
  const cells = q.data?.cells.filter((c) => !c.removed) ?? [];

  return (
    <>
      <PageHeader
        title="Smart Sample Allocation"
        description="How many completes Supply360 needs in each quota cell, and the most people it may hold per cell at once."
        actions={
          id && (
            <Button asChild variant="secondary">
              <Link href={`/quotas?project=${id}`}>Quota cells</Link>
            </Button>
          )
        }
      />
      <div className="mb-4">
        {list.isLoading ? <Loading /> : <ProjectPicker id={id} items={items} onSelect={select} />}
      </div>
      {q.isLoading || !q.data ? (
        q.error ? (
          <ErrorState error={q.error} />
        ) : !items.length && !list.isLoading ? (
          <Empty title="No projects yet" />
        ) : (
          <Loading />
        )
      ) : !cells.length ? (
        <Card>
          <Empty title="No quota cells">Supply360 is not a vendor in any market of this project.</Empty>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Allocation"
            description={`Supply360's targets at SampTrek: ${q.data.markets.map((m) => `${m.countryCode} ${fmtN(m.vendorTarget)}`).join(' · ')}`}
          />
          <CardBody className="space-y-5">
            <fieldset className="flex flex-wrap gap-2">
              <legend className="mb-1.5 text-xs font-medium text-muted">Mode</legend>
              {AllocationMode.options.map((m) => (
                <label key={m} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    className="accent-[var(--accent)]"
                  />
                  {ALLOCATION_LABELS[m]}
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-muted">
              Cells in the same SampTrek group share their market&apos;s target; different groups overlap by design.
              Preferred and exclusive allocation across several suppliers need more than one supply source and arrive
              with SampCloud.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="py-2 pr-3 font-medium">Cell</th>
                    <th className="px-3 py-2 text-right font-medium">SampTrek target</th>
                    <th className="px-3 py-2 text-right font-medium">Supply360 completes</th>
                    <th className="px-3 py-2 text-right font-medium">Cap on people held</th>
                    <th className="py-2 pl-3 text-right font-medium">Held now</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cells.map((c) => (
                    <tr key={c.id}>
                      <td className="py-2 pr-3">
                        {cellLabel(c)}
                        {c.group && <span className="ml-1 text-xs text-muted">({c.group})</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtN(c.sourceTarget)}</td>
                      <td className="px-3 py-2 text-right">
                        {mode === 'manual' ? (
                          <Input
                            aria-label={`Supply360 completes for ${cellLabel(c)}`}
                            type="number"
                            min={0}
                            className="ml-auto w-28 text-right"
                            value={targets[c.id] ?? 0}
                            onChange={(e) => setTargets({ ...targets, [c.id]: Number(e.target.value) })}
                          />
                        ) : (
                          <span className="tabular-nums">{fmtN(c.allocation)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          aria-label={`Cap for ${cellLabel(c)}`}
                          type="number"
                          min={0}
                          className="ml-auto w-28 text-right"
                          value={caps[c.id] ?? 0}
                          onChange={(e) => setCaps({ ...caps, [c.id]: Number(e.target.value) })}
                        />
                        {!c.inviteCap && (
                          <p className="mt-1 text-[11px] text-muted">suggested {fmtN(c.suggestedCap)}</p>
                        )}
                      </td>
                      <td className="py-2 pl-3 text-right tabular-nums">{fmtN(c.held)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              Suggested caps are three times the completes needed after incidence. They are a starting point, not a
              forecast.
            </p>
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
                Save allocation
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </>
  );
}
