'use client';
import type { AuditEvent } from '@s360/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api } from '@/lib/api';

type Page = { items: AuditEvent[]; nextCursor: string | null };

export default function AuditPage() {
  const can = useCan('audit.read');
  const q = useInfiniteQuery({
    queryKey: ['audit', 'all'],
    queryFn: ({ pageParam }) =>
      api<Page>(`/audit?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: can,
  });
  if (!can) return <NoPermission permission="audit.read" />;
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title="Activity and audit log"
        description="Append-only. The application can add entries but cannot change or delete them; the database enforces this."
      />
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !rows.length ? (
          <Empty title="No activity yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-3 py-3 font-medium">Action</th>
                  <th className="px-3 py-3 font-medium">Actor</th>
                  <th className="px-3 py-3 font-medium">Target</th>
                  <th className="px-5 py-3 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-surface-2/60">
                    <td className="px-5 py-2.5 text-xs whitespace-nowrap text-muted tabular-nums">
                      {new Date(e.at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{e.action}</td>
                    <td className="px-3 py-2.5 text-xs">{e.actorEmail ?? 'system'}</td>
                    <td className="px-3 py-2.5 text-xs text-muted">
                      {e.targetType}
                      {e.targetId ? ` · ${e.targetId.slice(0, 8)}` : ''}
                    </td>
                    <td className="px-5 py-2.5 text-xs text-muted">{e.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.hasNextPage && (
          <div className="border-t border-border p-3 text-center">
            <Button size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              Load older entries
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
