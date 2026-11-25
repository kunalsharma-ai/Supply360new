'use client';
import { useQuery } from '@tanstack/react-query';
import { Copy, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api } from '@/lib/api';
import type { ProjectDetail, ProjectSummary } from '@/lib/ingestion';

export default function RedirectsPage() {
  const canRead = useCan('projects.read');
  const [pick, setPick] = useState('');
  const list = useQuery({
    queryKey: ['projects', '', ''],
    queryFn: () => api<{ items: ProjectSummary[] }>('/projects'),
    enabled: canRead,
  });
  const id = pick || list.data?.items[0]?.id || '';
  const d = useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetail>(`/projects/${id}`),
    enabled: canRead && !!id,
  });
  if (!canRead) return <NoPermission permission="projects.read" />;
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast.success('Copied'));

  return (
    <>
      <PageHeader
        title="Redirect Management"
        description="One Supply360 endpoint per SampTrek outcome. Respondents always land on Supply360's own page: the destination never comes from the link, so it cannot be used as an open redirect."
      />
      <Card className="mb-6">
        <CardBody className="flex items-start gap-3 text-sm text-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <p>
            Arrivals are stored with the opaque reference only, and marked unverified until SampTrek's signed
            server-to-server callback confirms the outcome (Phase 5). Unknown projects get the same response and are not
            recorded.
          </p>
        </CardBody>
      </Card>
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <ErrorState error={list.error} />
      ) : !list.data?.items.length ? (
        <Card>
          <Empty title="No projects yet">Import projects from SampTrek first.</Empty>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Vendor redirect URLs"
            description="Paste each into Supply360's redirect settings for the project in SampTrek. {respondent_uid} is SampTrek's macro."
            action={
              <div className="w-72">
                <Label htmlFor="project" className="sr-only">
                  Project
                </Label>
                <Select id="project" value={id} onChange={(e) => setPick(e.target.value)}>
                  {list.data.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.projectCode} · {p.name}
                    </option>
                  ))}
                </Select>
              </div>
            }
          />
          {d.isLoading ? (
            <Loading />
          ) : d.data ? (
            <>
              <ul className="divide-y divide-border">
                {d.data.redirects.map((r) => (
                  <li key={r.status} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="w-36 shrink-0 font-mono text-xs">{r.status}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={r.url}>
                      {r.url}
                    </code>
                    <span className="w-16 shrink-0 text-right text-xs text-muted tabular-nums">{r.hits} hits</span>
                    <Button size="icon" variant="ghost" aria-label={`Copy ${r.status} URL`} onClick={() => copy(r.url)}>
                      <Copy />
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border px-5 py-3 text-xs text-muted">
                <Link href={`/projects/${id}`} className="text-accent hover:underline">
                  Open {d.data.projectCode}
                </Link>
              </p>
            </>
          ) : (
            <ErrorState error={d.error} />
          )}
        </Card>
      )}
    </>
  );
}
