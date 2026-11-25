'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { fmtTime, type InboxEvent } from '@/lib/ingestion';

const TONE = { processed: 'success', ignored: 'neutral', failed: 'danger', pending: 'warning' } as const;

export default function DevelopersPage() {
  const canRead = useCan('integrations.read');
  const canManage = useCan('integrations.manage');
  const qc = useQueryClient();
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<{ items: InboxEvent[] }>('/sources/events?limit=100'),
    enabled: canRead,
    refetchInterval: 15_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api<{ status: string }>(`/sources/events/${id}/retry`, { method: 'POST' }),
    onSuccess: (r) => {
      toast[r.status === 'failed' ? 'error' : 'success'](`Retry: ${r.status}`);
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Retry failed'),
  });
  if (!canRead) return <NoPermission permission="integrations.read" />;

  return (
    <>
      <PageHeader
        title="API and Webhook Management"
        description={
          <>
            Every signed webhook SampTrek delivered, kept once per event id. Duplicates are counted, not reprocessed.
            Signing secrets are on the{' '}
            <Link className="text-accent underline underline-offset-2" href="/integrations/samptrek">
              SampTrek page
            </Link>
            .
          </>
        }
      />
      <Card>
        <CardHeader title="Webhook inbox" description="Failed events are retried automatically, up to five times." />
        {inbox.isLoading ? (
          <Loading />
        ) : inbox.error ? (
          <ErrorState error={inbox.error} />
        ) : !inbox.data?.items.length ? (
          <Empty title="No webhooks received yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-5 py-3 font-medium">Event</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 text-right font-medium">Duplicates</th>
                  <th className="px-3 py-3 font-medium">Note</th>
                  <th className="px-3 py-3 font-medium">Received</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inbox.data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="px-5 py-3">
                      <p className="font-mono text-xs font-medium">{e.eventType}</p>
                      <p className="font-mono text-[11px] text-muted">{e.eventId}</p>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={TONE[e.status]}>{e.status}</Badge>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{e.duplicates}</td>
                    <td className="max-w-80 px-3 py-3 text-xs text-muted">{e.error ?? '—'}</td>
                    <td className="px-3 py-3 text-xs text-muted tabular-nums">{fmtTime(e.receivedAt)}</td>
                    <td className="px-5 py-3 text-right">
                      {canManage && e.status === 'failed' && (
                        <Button size="sm" variant="ghost" onClick={() => retry.mutate(e.id)}>
                          <RotateCcw /> Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
