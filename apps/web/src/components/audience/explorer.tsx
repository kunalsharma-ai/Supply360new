'use client';
import type { AudienceCriteria } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Save } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { describeCriteria, type Catalogue, type Counts, type Segment } from '@/lib/audience';
import { CountsView } from './counts-view';
import { CriteriaBuilder } from './criteria-builder';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

export function AudienceExplorer({ variant }: { variant: 'finder' | 'filter' }) {
  const canRead = useCan('audience.read');
  const canSave = useCan('audience.select');
  const qc = useQueryClient();
  const params = useSearchParams();
  const [criteria, setCriteria] = useState<AudienceCriteria>({});
  const [name, setName] = useState('');
  const catalogue = useQuery({
    queryKey: ['audience-attributes'],
    queryFn: () => api<Catalogue>('/audience/attributes'),
    enabled: canRead,
    retry: false,
  });
  const segments = useQuery({
    queryKey: ['segments'],
    queryFn: () => api<{ items: Segment[] }>('/audience/segments'),
    enabled: canRead && variant === 'filter',
  });
  const count = useMutation({
    mutationFn: (c: AudienceCriteria) => api<Counts>('/audience/counts', { method: 'POST', body: c }),
    onError: (e) => toast.error(errMsg(e)),
  });
  const save = useMutation({
    mutationFn: () => api<Segment>('/audience/segments', { method: 'POST', body: { name, criteria } }),
    onSuccess: (s) => {
      toast.success(`Saved segment “${s.name}”`);
      setName('');
      void qc.invalidateQueries({ queryKey: ['segments'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const segmentId = params.get('segment');
  useEffect(() => {
    const s = segments.data?.items.find((x) => x.id === segmentId);
    if (s) {
      setCriteria(s.criteria);
      count.mutate(s.criteria);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId, segments.data]);

  if (!canRead) return <NoPermission permission="audience.read" />;
  const title = variant === 'finder' ? 'Global Audience Finder' : 'Dynamic Audience Filter';
  const description =
    variant === 'finder'
      ? 'How many people MADP can reach, by panel and geography. A person in two panels is one person here.'
      : "Filter on MADP's canonical attributes. Health and other special-category attributes are never offered.";
  const noSource = catalogue.error instanceof ApiError && catalogue.error.problem.code === 'no_audience_source';

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          catalogue.data &&
          (catalogue.data.source.mode === 'fixture' ? (
            <Badge tone="demo">MADP FIXTURE</Badge>
          ) : (
            <Badge tone="accent">MADP LIVE</Badge>
          ))
        }
      />
      {catalogue.isLoading ? (
        <Loading />
      ) : noSource ? (
        <Card>
          <Empty
            title="MADP is not connected"
            action={
              <Button asChild variant="primary">
                <Link href="/integrations/madp">Connect MADP</Link>
              </Button>
            }
          >
            Counts come from MADP. Start with a FIXTURE connection to use the labelled DEMO population.
          </Empty>
        </Card>
      ) : catalogue.error ? (
        <ErrorState error={catalogue.error} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
          <Card>
            <CardHeader title="Criteria" />
            <CardBody className="space-y-4">
              <CriteriaBuilder
                key={segmentId ?? 'new'}
                value={criteria}
                onChange={setCriteria}
                attributes={variant === 'finder' ? [] : (catalogue.data?.attributes ?? [])}
              />
              <Button
                variant="primary"
                className="w-full"
                disabled={count.isPending}
                onClick={() => count.mutate(criteria)}
              >
                <Calculator /> Count
              </Button>
              {variant === 'filter' && canSave && (
                <form
                  className="space-y-2 border-t border-border pt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate();
                  }}
                >
                  <Label htmlFor="seg-name">Save as a segment</Label>
                  <div className="flex gap-2">
                    <Input
                      id="seg-name"
                      placeholder="e.g. US urban women"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Button type="submit" disabled={name.trim().length < 2 || save.isPending}>
                      <Save /> Save
                    </Button>
                  </div>
                </form>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Feasibility"
              description={count.data ? describeCriteria(count.variables ?? {}, catalogue.data?.attributes) : undefined}
            />
            <CardBody>
              {count.isPending ? (
                <Loading label="Asking MADP" />
              ) : count.data ? (
                <CountsView counts={count.data} />
              ) : (
                <Empty title="Pick criteria and count">Nothing is reserved here; counting is read-only.</Empty>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
