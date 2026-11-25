'use client';
import { CalendarClock, CheckCircle2, CircleDashed } from 'lucide-react';
import { notFound, usePathname } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { NoPermission } from '@/components/ui/states';
import { MODULES } from '@/lib/modules';

const PHASES = [
  'Foundations',
  'Project ingestion',
  'Audience and quotas',
  'Invitations and modes',
  'Live events and reconciliation',
  'SampIntel AI',
  'Copilot and reporting',
  'Production readiness',
];

/** Modules whose phase has not arrived: an honest status page, never a mock screen. */
export default function PlannedModule() {
  const path = usePathname();
  const m = MODULES.find((x) => x.href === path);
  const allowed = useCan(m?.permission ?? 'projects.read');
  if (!m) notFound();
  if (!allowed) return <NoPermission permission={m.permission} />;
  return (
    <>
      <PageHeader eyebrow={<Badge tone="neutral">Module {m.n} of 35</Badge>} title={m.name} description={m.summary} />
      <Card>
        <CardBody className="flex flex-col gap-6 md:flex-row">
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="size-4 text-accent" /> Arrives in Phase {m.phase}: {PHASES[m.phase - 1]}
            </div>
            <p className="mt-2 text-sm text-muted">
              This module is not built yet, so this page shows no data and no controls. It will open here when its phase
              is delivered and tested.
            </p>
          </div>
          <ol className="flex-1 space-y-1.5" aria-label="Delivery phases">
            {PHASES.map((p, i) => (
              <li key={p} className="flex items-center gap-2 text-sm">
                {i + 1 < 2 ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : (
                  <CircleDashed className={i + 1 === m.phase ? 'size-4 text-accent' : 'size-4 text-muted/60'} />
                )}
                <span className={i + 1 === m.phase ? 'font-medium' : 'text-muted'}>
                  Phase {i + 1}: {p}
                </span>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </>
  );
}
