'use client';
import { QA_MODE_LABELS, type QaMode, type SyntheticQaSummary } from '@s360/contracts';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';

export interface SyntheticQaView {
  qaMode: QaMode;
  connection: 'fixture' | 'live' | 'off' | 'missing' | null;
  summary: SyntheticQaSummary | null;
  error: string | null;
}

/** Module 26 on the project page: SampIntel's synthetic QA, shown beside human sample and never added to it. */
export function SyntheticQaCard({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: ['synthetic-qa', projectId],
    queryFn: () => api<SyntheticQaView>(`/projects/${projectId}/synthetic-qa`),
  });
  const v = q.data;
  if (!v) return null;
  const s = v.summary;
  return (
    <Card className="lg:col-span-2" data-testid="synthetic-qa-card">
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <FlaskConical className="size-4 text-warning" aria-hidden /> Synthetic QA from SampIntel AI
            <Badge tone={v.qaMode === 'human_only' ? 'neutral' : 'warning'}>{QA_MODE_LABELS[v.qaMode]}</Badge>
            {v.connection === 'fixture' && <Badge tone="demo">FIXTURE</Badge>}
          </span>
        }
        description="Authorized test runs by fictional profiles. Never counted in quotas, IR, LOI, rewards, invoices or delivery."
      />
      <CardBody className="space-y-3 text-sm">
        {v.qaMode === 'human_only' ? (
          <p className="text-muted">
            This project is human only, so no synthetic QA is read. An admin can change it in{' '}
            <Link className="text-accent underline" href="/integrations/sampintel">
              SampIntel AI Integration
            </Link>
            .
          </p>
        ) : v.connection === 'missing' || v.connection === 'off' ? (
          <p className="text-muted">
            The SampIntel link is {v.connection === 'off' ? 'turned off' : 'not set up yet'}.{' '}
            <Link className="text-accent underline" href="/integrations/sampintel">
              Set it up
            </Link>
          </p>
        ) : v.error ? (
          <p className="text-danger">SampIntel could not be read: {v.error}. No numbers are shown until it answers.</p>
        ) : s ? (
          <>
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {s.notice}
            </p>
            {v.qaMode === 'synthetic_qa_only' && (
              <p className="text-xs text-muted">
                Human invitations are off for this project while it is set to synthetic QA only.
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
              <dt className="text-muted">Synthetic sessions</dt>
              <dd className="tabular-nums">{s.sessions}</dd>
              <dt className="text-muted">Assertions</dt>
              <dd className="tabular-nums">
                {s.assertions.passed} passed ·{' '}
                <span className={s.assertions.failed ? 'text-danger' : ''}>{s.assertions.failed} failed</span>
              </dd>
              <dt className="text-muted">Blocked redirects</dt>
              <dd className="tabular-nums">{s.blockedRedirects}</dd>
              <dt className="text-muted">Last session</dt>
              <dd className="tabular-nums">{s.lastSessionAt ? new Date(s.lastSessionAt).toLocaleString() : '—'}</dd>
            </dl>
            <ul className="flex flex-wrap gap-2" aria-label="Synthetic outcomes">
              {Object.entries(s.outcomes).map(([k, n]) => (
                <li key={k}>
                  <Badge tone="neutral">
                    {k.replaceAll('_', ' ')} · {n}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
