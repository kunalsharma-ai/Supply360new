'use client';
import { Lifecycle, LIFECYCLE_LABELS } from '@s360/contracts';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleSlash, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, lifecycleLabel, lifecycleTone, sourceTone, type ProjectSummary } from '@/lib/ingestion';

export default function ProjectsPage() {
  const canRead = useCan('projects.read');
  const canSources = useCan('integrations.read');
  const [lifecycle, setLifecycle] = useState<Lifecycle | ''>('');
  const [q, setQ] = useState('');
  const params = new URLSearchParams({ ...(lifecycle ? { lifecycle } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
  const list = useQuery({
    queryKey: ['projects', lifecycle, q.trim()],
    queryFn: () => api<{ items: ProjectSummary[] }>(`/projects?${params}`),
    enabled: canRead,
  });
  if (!canRead) return <NoPermission permission="projects.read" />;

  return (
    <>
      <PageHeader
        title="Project Execution Centre"
        description="Projects imported from SampTrek. SampTrek's status always wins: a hold or closure there stops Supply360 straight away."
        actions={
          canSources && (
            <Button asChild variant="secondary">
              <Link href="/integrations/samptrek">SampTrek connection</Link>
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            aria-label="Search projects"
            placeholder="Search by name or code"
            className="pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div role="group" aria-label="Filter by state" className="flex flex-wrap gap-1">
          {(['', ...Lifecycle.options] as const).map((l) => (
            <button
              key={l || 'all'}
              aria-pressed={lifecycle === l}
              onClick={() => setLifecycle(l)}
              className={cn(
                'rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-text',
                lifecycle === l && 'border-accent/50 bg-accent/10 text-text',
              )}
            >
              {l ? LIFECYCLE_LABELS[l] : 'All'}
            </button>
          ))}
        </div>
      </div>
      <Card>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : !list.data?.items.length ? (
          <Empty title={lifecycle || q ? 'No projects match' : 'No projects yet'}>
            {lifecycle || q
              ? 'Try another filter.'
              : 'Connect SampTrek and run a backfill to import projects. FIXTURE mode loads labelled sample projects.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-5 py-3 font-medium">Project</th>
                  <th className="px-3 py-3 font-medium">Markets</th>
                  <th className="px-3 py-3 font-medium">SampTrek</th>
                  <th className="px-3 py-3 font-medium">Supply360</th>
                  <th className="px-3 py-3 font-medium">Dispatch</th>
                  <th className="px-3 py-3 text-right font-medium">Supply360 completes</th>
                  <th className="px-5 py-3 font-medium">Field ends</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.data.items.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-2/60">
                    <td className="px-5 py-3">
                      <Link href={`/projects/${p.id}`} className="font-medium hover:text-accent">
                        {p.name}
                      </Link>
                      <p className="font-mono text-xs text-muted">
                        {p.projectCode}
                        {p.clientName ? ` · ${p.clientName}` : ''}
                      </p>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">{p.markets?.join(' ')}</td>
                    <td className="px-3 py-3">
                      <Badge tone={sourceTone(p.sourceStatus)}>{p.sourceStatus}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={lifecycleTone(p.lifecycle)}>{lifecycleLabel(p.lifecycle)}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      {p.dispatchAllowed ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <CircleCheck className="size-3.5" /> Allowed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-muted">
                          <CircleSlash className="size-3.5" /> Stopped
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {p.vendorCompletes ?? 0} <span className="text-muted">/ {p.vendorTarget ?? 0}</span>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted tabular-nums">{fmtDate(p.fieldEndAt)}</td>
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
