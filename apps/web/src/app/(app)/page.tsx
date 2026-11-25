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
import { lifecycleLabel, lifecycleTone, sourceTone, type Connection, type ProjectSummary } from '@/lib/ingestion';
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

type Tone = 'neutral' | 'warning' | 'success' | 'demo' | 'danger';

function sampTrekHealth(
  conns: Connection[] | undefined,
  allowed: boolean,
): { state: string; tone: Tone; note: string } {
  if (!allowed) return { state: 'Hidden', tone: 'neutral', note: 'Your role cannot see integration details.' };
  if (!conns) return { state: '…', tone: 'neutral', note: 'Checking' };
  const on = conns.filter((c) => c.enabled);
  if (!on.length)
    return { state: 'Not connected', tone: 'neutral', note: 'Add a SampTrek connection to import projects.' };
  const failing = on.find((c) => c.lastSyncResult && !c.lastSyncResult.ok);
  if (failing)
    return { state: 'Sync problem', tone: 'danger', note: failing.lastSyncResult!.errors[0] ?? 'The last sync failed' };
  const live = on.some((c) => c.mode === 'live');
  const rejected = on.reduce((a, c) => a + c.rejectedCount, 0);
  return {
    state: live ? 'Connected' : 'FIXTURE',
    tone: live ? 'success' : 'demo',
    note: `${live ? 'Reading the live SampTrek API' : 'Labelled sample projects, shaped like SampTrek'}; signed webhooks on.${
      rejected ? ` ${rejected} deliveries refused for a bad signature.` : ''
    }`,
  };
}

const INTEGRATIONS = [
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
  const canProjects = useCan('projects.read');
  const canSources = useCan('integrations.read');
  const projects = useQuery({
    queryKey: ['projects', '', ''],
    queryFn: () => api<{ items: ProjectSummary[] }>('/projects'),
    enabled: canProjects,
  });
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ items: Connection[] }>('/sources'),
    enabled: canSources,
  });
  const st = sampTrekHealth(sources.data?.items, canSources);
  const integrations = [
    {
      name: 'SampTrek',
      icon: Network,
      ...st,
      href: '/integrations/samptrek',
    },
    ...INTEGRATIONS,
  ];
  const items = projects.data?.items ?? [];
  const live = items.filter((p) => p.lifecycle === 'live').length;
  const dispatching = items.filter((p) => p.dispatchAllowed).length;
  const ready = MODULES.filter((m) => m.ready).length;
  const mfa = users.data ? users.data.items.filter((u) => u.mfaEnabled).length : null;

  return (
    <>
      <PageHeader
        eyebrow={<Badge tone="accent">Global Command Centre</Badge>}
        title={`Good to see you, ${me.user.name.split(' ')[0]}`}
        description="Everything here comes from this workspace’s own records. Fieldwork figures appear as SampTrek and MADP data arrives; FIXTURE data is always labelled."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Live projects"
          value={projects.data ? String(live) : canProjects ? '…' : '—'}
          hint={
            projects.data
              ? `${items.length} imported, ${dispatching} allowed to dispatch`
              : 'Projects come from SampTrek'
          }
          icon={Network}
        />
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
            {integrations.map((i) => (
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
        <CardHeader
          title="Projects"
          description="Imported from SampTrek. Supply360 never creates projects by hand."
          action={
            canProjects && (
              <Link href="/projects" className="text-xs text-accent hover:underline">
                All projects
              </Link>
            )
          }
        />
        {!canProjects ? (
          <Empty title="Projects are not available for your role" />
        ) : projects.isLoading ? (
          <Loading />
        ) : items.length ? (
          <ul className="divide-y divide-border">
            {items.slice(0, 6).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/projects/${p.id}`} className="text-sm font-medium hover:text-accent">
                    {p.name}
                  </Link>
                  <p className="font-mono text-xs text-muted">
                    {p.projectCode} · {p.markets?.join(' ')}
                  </p>
                </div>
                <Badge tone={sourceTone(p.sourceStatus)}>SampTrek {p.sourceStatus}</Badge>
                <Badge tone={lifecycleTone(p.lifecycle)}>{lifecycleLabel(p.lifecycle)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <CardBody>
            <Empty title="No projects yet">
              Connect SampTrek and run a backfill. FIXTURE mode loads labelled sample projects.
            </Empty>
          </CardBody>
        )}
      </Card>
    </>
  );
}
