'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api } from '@/lib/api';
import { describeCriteria, fmtN, type Segment, type Selection } from '@/lib/audience';
import { fmtTime } from '@/lib/ingestion';

export default function SegmentsPage() {
  const canRead = useCan('audience.read');
  const canEdit = useCan('audience.select');
  const qc = useQueryClient();
  const segments = useQuery({
    queryKey: ['segments'],
    queryFn: () => api<{ items: Segment[] }>('/audience/segments'),
    enabled: canRead,
  });
  const selections = useQuery({
    queryKey: ['selections'],
    queryFn: () => api<{ items: Selection[] }>('/audience/selections'),
    enabled: canRead,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/audience/segments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Segment deleted');
      void qc.invalidateQueries({ queryKey: ['segments'] });
    },
  });
  if (!canRead) return <NoPermission permission="audience.read" />;

  return (
    <>
      <PageHeader
        title="Audience Segmentation"
        description="Saved criteria to reuse, and an immutable snapshot of every selection MADP returned for a project."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader title="Saved segments" description="Open one in the Dynamic Audience Filter to count it again." />
          {segments.isLoading ? (
            <Loading />
          ) : segments.error ? (
            <ErrorState error={segments.error} />
          ) : !segments.data?.items.length ? (
            <Empty title="No segments yet">Build criteria in the Dynamic Audience Filter and save them.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {segments.data.items.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <Link href={`/audience/filter?segment=${s.id}`} className="font-medium hover:text-accent">
                      {s.name}
                    </Link>
                    <p className="truncate text-xs text-muted">{describeCriteria(s.criteria)}</p>
                  </div>
                  {canEdit && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => remove.mutate(s.id)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Selection snapshots"
            description="Kept as MADP returned them. References are counted here, never listed."
          />
          {selections.isLoading ? (
            <Loading />
          ) : selections.error ? (
            <ErrorState error={selections.error} />
          ) : !selections.data?.items.length ? (
            <Empty title="No selections yet">Reserve people for a quota cell to create one.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-5 py-3 font-medium">When</th>
                    <th className="px-3 py-3 font-medium">Project · cell</th>
                    <th className="px-3 py-3 font-medium">Criteria</th>
                    <th className="px-3 py-3 text-right font-medium">Eligible</th>
                    <th className="px-3 py-3 text-right font-medium">Picked</th>
                    <th className="px-5 py-3 font-medium">Excluded by MADP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {selections.data.items.map((s) => (
                    <tr key={s.id}>
                      <td className="px-5 py-3 text-xs text-muted tabular-nums">{fmtTime(s.createdAt)}</td>
                      <td className="px-3 py-3">
                        <Link href={`/quotas?project=${s.projectId}`} className="font-mono text-xs hover:text-accent">
                          {s.projectCode}
                        </Link>
                        <p className="text-xs text-muted">
                          {s.countryCode} · {s.cellName} {s.dataMode === 'demo' && <Badge tone="demo">DEMO</Badge>}
                        </p>
                      </td>
                      <td className="max-w-xs px-3 py-3 text-xs">{describeCriteria(s.criteria)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{fmtN(s.eligible)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{fmtN(s.refs)}</td>
                      <td className="px-5 py-3 text-xs text-muted">
                        {Object.entries(s.excluded)
                          .map(([k, n]) => `${k.replaceAll('_', ' ')} ${n}`)
                          .join(' · ') || 'none'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
