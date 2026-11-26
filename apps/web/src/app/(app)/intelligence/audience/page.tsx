'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Table, Td, Th } from '@/components/fieldwork/fieldwork-views';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtN } from '@/lib/audience';
import type { Perf } from '@/lib/intelligence';

interface Data {
  days: number;
  minSample: { sent: number; screened: number };
  definitions: Record<string, string>;
  panels: Perf[];
  countries: Perf[];
  segments: Perf[];
}

function PerfTable({ title, rows, keyLabel }: { title: string; rows: Perf[]; keyLabel: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        {!rows.length ? (
          <Empty title="No invitations in this period" />
        ) : (
          <Table
            head={
              <>
                <Th>{keyLabel}</Th>
                <Th right>Sent</Th>
                <Th right>Started</Th>
                <Th right>Start rate</Th>
                <Th right>Completes</Th>
                <Th right>Incidence</Th>
                <Th right>Completes / invite</Th>
                <Th right>Median LOI</Th>
              </>
            }
          >
            {rows.map((r) => (
              <tr key={r.key} data-testid="perf-row">
                <Td>
                  {r.key}
                  {!r.enoughData && (
                    <Badge tone="neutral" className="ml-2">
                      small sample
                    </Badge>
                  )}
                </Td>
                <Td right>{fmtN(r.sent)}</Td>
                <Td right>{fmtN(r.started)}</Td>
                <Td right>{r.startRate == null ? '—' : `${r.startRate}%`}</Td>
                <Td right>{fmtN(r.complete)}</Td>
                <Td right>{r.incidence == null ? '—' : `${r.incidence}%`}</Td>
                <Td right>{r.completesPerInvite == null ? '—' : `${r.completesPerInvite}%`}</Td>
                <Td right>{r.medianLoiMinutes == null ? '—' : `${r.medianLoiMinutes} min`}</Td>
              </tr>
            ))}
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

export default function AudienceIntelligencePage() {
  const can = useCan('audience.read');
  const [days, setDays] = useState(90);
  const q = useQuery({
    queryKey: ['audience-intel', days],
    queryFn: () => api<Data>(`/intelligence/audience?days=${days}`),
    enabled: can,
  });
  if (!can) return <NoPermission permission="audience.read" />;
  return (
    <>
      <PageHeader
        title="AI Audience Intelligence"
        description="How each panel, country and quota segment has performed on Supply360's own invitations. Every rate shows what it is out of; small samples are marked and never ranked."
      />
      <div className="mb-4 w-48">
        <Label htmlFor="ai-days">Period</Label>
        <Select id="ai-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </Select>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <div className="space-y-6">
          <p className="text-xs text-muted">
            Start rate: {q.data!.definitions.startRate}. Incidence: {q.data!.definitions.incidence}. A small sample has
            fewer than {q.data!.minSample.sent} invitations or {q.data!.minSample.screened} screened sessions.
          </p>
          <PerfTable title="Panels" keyLabel="Panel" rows={q.data!.panels} />
          <PerfTable title="Countries" keyLabel="Country" rows={q.data!.countries} />
          <PerfTable title="Quota segments" keyLabel="Segment" rows={q.data!.segments} />
        </div>
      )}
    </>
  );
}
