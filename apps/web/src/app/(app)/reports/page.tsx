'use client';
import { REPORT_FORMATS, REPORT_KINDS, REPORT_LABELS, type ReportKind } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileDown } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { errMsg } from '@/components/execution/use-batch-actions';
import { Table, Td, Th } from '@/components/fieldwork/fieldwork-views';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api } from '@/lib/api';
import { when } from '@/lib/execution';
import type { ProjectSummary } from '@/lib/ingestion';

interface Export {
  id: string;
  kind: ReportKind;
  label: string;
  format: string;
  status: 'queued' | 'building' | 'ready' | 'failed' | 'expired';
  rows: number | null;
  fileName: string | null;
  error: string | null;
  downloads: number;
  timezone: string;
  expiresAt: string;
  createdAt: string;
}
const TONE = { queued: 'accent', building: 'accent', ready: 'success', failed: 'danger', expired: 'neutral' } as const;
const NEEDS_PROJECT: ReportKind[] = ['project_summary', 'synthetic_qa'];

export default function ReportsPage() {
  const canRead = useCan('reports.read');
  const canExport = useCan('reports.export');
  const canAudit = useCan('audit.read');
  const qc = useQueryClient();
  const [kind, setKind] = useState<ReportKind>('invitation_funnel');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const projects = useQuery({
    queryKey: ['projects', '', ''],
    queryFn: () => api<{ items: ProjectSummary[] }>('/projects'),
    enabled: canRead,
  });
  const list = useQuery({
    queryKey: ['exports'],
    queryFn: () => api<{ items: Export[]; ttlHours: number }>('/reports/exports'),
    enabled: canRead,
    refetchInterval: (q) =>
      q.state.data?.items.some((x) => x.status === 'queued' || x.status === 'building') ? 1000 : false,
  });
  const create = useMutation({
    mutationFn: (body: unknown) => api<Export>('/reports/exports', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Export queued');
      void qc.invalidateQueries({ queryKey: ['exports'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!canRead) return <NoPermission permission="reports.read" />;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const iso = (v: FormDataEntryValue | null) => (v ? new Date(String(v)).toISOString() : undefined);
    create.mutate({
      kind,
      format: f.get('format'),
      projectId: f.get('projectId') || undefined,
      from: iso(f.get('from')),
      to: iso(f.get('to')),
      timezone: f.get('timezone'),
    });
  };
  const kinds = REPORT_KINDS.filter((k) => k !== 'audit' || canAudit);
  return (
    <>
      <PageHeader
        title="Reports and Analytics"
        description="Exports are built in the background, kept for 24 hours, and only you can download yours. Times are written in the time zone you pick; spreadsheet formulas in text are neutralised."
      />
      <div className="grid gap-6 lg:grid-cols-3">
        {canExport && (
          <Card>
            <CardHeader title="New export" />
            <CardBody>
              <form className="space-y-4" onSubmit={onSubmit}>
                <div>
                  <Label htmlFor="r-kind">Report</Label>
                  <Select id="r-kind" value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
                    {kinds.map((k) => (
                      <option key={k} value={k}>
                        {REPORT_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                  {kind === 'synthetic_qa' && (
                    <p className="mt-1 text-xs text-warning">
                      Synthetic QA from SampIntel AI. Kept separate and labelled; never human sample.
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="r-project">Project</Label>
                  <Select id="r-project" name="projectId" required={NEEDS_PROJECT.includes(kind)} defaultValue="">
                    {!NEEDS_PROJECT.includes(kind) && <option value="">All projects</option>}
                    {(projects.data?.items ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.projectCode} · {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="r-from">From</Label>
                    <Input id="r-from" name="from" type="date" />
                  </div>
                  <div>
                    <Label htmlFor="r-to">To</Label>
                    <Input id="r-to" name="to" type="date" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="r-format">Format</Label>
                    <Select id="r-format" name="format" defaultValue="xlsx">
                      {REPORT_FORMATS.map((f) => (
                        <option key={f} value={f}>
                          {f === 'xlsx' ? 'Excel' : f.toUpperCase()}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="r-tz">Time zone</Label>
                    <Input id="r-tz" name="timezone" defaultValue={zone} required />
                  </div>
                </div>
                <Button type="submit" variant="primary" disabled={create.isPending}>
                  <FileDown /> Export
                </Button>
              </form>
            </CardBody>
          </Card>
        )}
        <Card className={canExport ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <CardHeader title="Your exports" description={`Kept for ${list.data?.ttlHours ?? 24} hours, then removed.`} />
          <CardBody>
            {list.isLoading ? (
              <Loading />
            ) : list.error ? (
              <ErrorState error={list.error} />
            ) : !list.data?.items.length ? (
              <Empty title="No exports yet" />
            ) : (
              <Table
                head={
                  <>
                    <Th>Report</Th>
                    <Th>Status</Th>
                    <Th right>Rows</Th>
                    <Th>Requested</Th>
                    <Th>Expires</Th>
                    <Th />
                  </>
                }
              >
                {list.data.items.map((x) => (
                  <tr key={x.id} data-testid="export-row">
                    <Td>
                      {x.label}
                      <span className="block text-xs text-muted">
                        {x.format.toUpperCase()} · {x.timezone}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={TONE[x.status]}>{x.status}</Badge>
                      {x.error && <span className="block text-xs text-danger">{x.error}</span>}
                    </Td>
                    <Td right>{x.rows ?? '—'}</Td>
                    <Td>{when(x.createdAt)}</Td>
                    <Td>{when(x.expiresAt)}</Td>
                    <Td>
                      {x.status === 'ready' && canExport && (
                        <Button asChild size="sm">
                          <a href={`/api/v1/reports/exports/${x.id}/download`} download={x.fileName ?? undefined}>
                            <Download /> Download
                          </a>
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
