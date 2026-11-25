'use client';
import type { AuditEvent, UserSummary } from '@s360/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Cloud, Database, Network, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { useCan, useSession } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Empty, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { MODULES } from '@/lib/modules';

function Stat({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: typeof Users }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{label}</p>
        <Icon className="size-4 text-accent" />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </Card>
  );
}

const INTEGRATIONS = [
  {
    name: 'SampTrek',
    icon: Network,
    state: 'Not connected',
    tone: 'neutral' as const,
    note: 'Project import arrives in Phase 2. Uses SampTrek’s public API, signed webhooks and vendor callbacks.',
    href: '/integrations/samptrek',
  },
  {
    name: 'MADP',
    icon: Database,
    state: 'Not connected',
    tone: 'neutral' as const,
    note: 'Audience counts and selection arrive in Phase 3 through MADP’s signed Supply360 API.',
    href: '/integrations/madp',
  },
  {
    name: 'SampCloud',
    icon: Cloud,
    state: 'Blocked',
    tone: 'warning' as const,
    note: 'Repository not available yet. Only an adapter interface will be built until it is.',
    href: '/integrations/sampcloud',
  },
];

export default function CommandCentre() {
  const me = useSession();
  const canUsers = useCan('users.read');
  const canAudit = useCan('audit.read');
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: UserSummary[] }>('/users?limit=200'),
    enabled: canUsers,
  });
  const audit = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () => api<{ items: AuditEvent[] }>('/audit?limit=8'),
    enabled: canAudit,
  });
  const ready = MODULES.filter((m) => m.ready).length;
  const mfa = users.data ? users.data.items.filter((u) => u.mfaEnabled).length : null;

  return (
    <>
      <PageHeader
        eyebrow={<Badge tone="accent">Global Command Centre</Badge>}
        title={`Good to see you, ${me.user.name.split(' ')[0]}`}
        description="Everything here comes from this workspace’s own records. Fieldwork figures appear once SampTrek and MADP are connected; nothing on this page is simulated."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active projects" value="0" hint="No project source connected yet" icon={Network} />
        <Stat
          label="People in this workspace"
          value={users.data ? String(users.data.items.length) : canUsers ? '…' : '—'}
          hint="Accounts with access"
          icon={Users}
        />
        <Stat
          label="Two-step sign-in coverage"
          value={
            mfa !== null && users.data?.items.length ? `${Math.round((mfa / users.data.items.length) * 100)}%` : '—'
          }
          hint="Accounts with an authenticator enrolled"
          icon={ShieldCheck}
        />
        <Stat
          label="Modules available"
          value={`${ready} / ${MODULES.length}`}
          hint="Built and tested in this release"
          icon={ArrowUpRight}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Integration health"
            description="Live state of every source system. Supply360 never shows data from a source it cannot verify."
          />
          <ul className="divide-y divide-border">
            {INTEGRATIONS.map((i) => (
              <li key={i.name} className="flex items-start gap-4 px-5 py-4">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2">
                  <i.icon className="size-4 text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{i.name}</p>
                    <Badge tone={i.tone}>{i.state}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{i.note}</p>
                </div>
                <Link href={i.href} className="text-xs text-accent hover:underline">
                  Details
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader
            title="Recent activity"
            description="From the audit log"
            action={
              canAudit && (
                <Link href="/audit" className="text-xs text-accent hover:underline">
                  All
                </Link>
              )
            }
          />
          {!canAudit ? (
            <Empty title="Audit log not available for your role" />
          ) : audit.isLoading ? (
            <Loading />
          ) : audit.data?.items.length ? (
            <ul className="divide-y divide-border">
              {audit.data.items.map((e) => (
                <li key={e.id} className="px-5 py-3">
                  <p className="font-mono text-xs text-text">{e.action}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {e.actorEmail ?? 'system'} · {new Date(e.at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No activity yet" />
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Projects" description="Imported from SampTrek once the integration is connected" />
        <CardBody>
          <Empty title="No projects yet">
            Supply360 imports projects from SampTrek automatically; it never creates them by hand. The SampTrek
            integration arrives in Phase 2.
          </Empty>
        </CardBody>
      </Card>
    </>
  );
}
