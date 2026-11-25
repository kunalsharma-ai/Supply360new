'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';

type N = {
  id: string;
  title: string;
  body: string;
  severity: string;
  kind: string;
  createdAt: string;
  readAt: string | null;
};

export default function NotificationsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: N[]; unread: number }>('/notifications'),
  });
  const read = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <>
      <PageHeader
        title="Notifications Centre"
        description="Operational alerts only: failed integrations, delivery and quota risk, authorization expiry, job failures and targets reached."
      />
      <Card>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data?.items.length ? (
          <Empty title="No notifications">Alerts appear here once projects and integrations are running.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {q.data.items.map((n) => (
              <li key={n.id} className="flex items-start gap-3 px-5 py-4">
                <Badge tone={n.severity === 'critical' ? 'danger' : n.severity === 'warning' ? 'warning' : 'accent'}>
                  {n.severity}
                </Badge>
                <div className="flex-1">
                  <p className={n.readAt ? 'text-sm' : 'text-sm font-medium'}>{n.title}</p>
                  <p className="text-xs text-muted">{n.body}</p>
                  <p className="mt-1 text-[11px] text-muted tabular-nums">{new Date(n.createdAt).toLocaleString()}</p>
                </div>
                {!n.readAt && (
                  <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)}>
                    Mark read
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
