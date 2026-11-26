'use client';
import type { AuditEvent, UserSummary } from '@s360/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  Check,
  Cloud,
  Database,
  FolderKanban,
  Lock,
  Network,
  Rocket,
  ShieldCheck,
  Sparkles,
  Trophy,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CountUp } from '@/components/fun/count-up';
import { FunSwitch } from '@/components/fun/fun-switch';
import { FunTabs } from '@/components/fun/fun-tabs';
import { HeroScene } from '@/components/fun/hero-scene';
import { ProgressRing } from '@/components/fun/progress-ring';
import { Tilt } from '@/components/fun/tilt';
import { useTheme } from '@/components/providers';
import { ModuleIcon } from '@/components/shell/icons';
import { useCan, useSession } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { Empty, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { lifecycleLabel, lifecycleTone, sourceTone, type Connection, type ProjectSummary } from '@/lib/ingestion';
import { MODULES } from '@/lib/modules';

const TINTS = {
  violet: 'from-violet-500 to-fuchsia-500',
  sky: 'from-sky-400 to-indigo-500',
  mint: 'from-emerald-400 to-teal-500',
  sun: 'from-amber-400 to-orange-500',
  pink: 'from-pink-400 to-rose-500',
} as const;
type Tint = keyof typeof TINTS;

function IconTile({ icon: Icon, tint, className }: { icon: LucideIcon; tint: Tint; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.4),0_3px_0_rgb(0_0_0/0.15),0_10px_18px_-8px_rgb(0_0_0/0.4)]',
        TINTS[tint],
        className,
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

function Stat({
  label,
  value,
  suffix,
  hint,
  icon,
  tint,
  progress,
  delay,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  hint: string;
  icon: LucideIcon;
  tint: Tint;
  progress?: number | null;
  delay: number;
}) {
  return (
    <Tilt className="fun-pop" style={{ ['--d' as string]: `${delay}ms` }}>
      <Card className="fun-wiggle relative h-full overflow-hidden p-5">
        <span
          aria-hidden
          className={cn(
            'absolute -top-10 -right-10 size-32 rounded-full bg-gradient-to-br opacity-15 blur-xl',
            TINTS[tint],
          )}
        />
        <div className="flex min-h-12 items-start justify-between gap-3">
          <IconTile icon={icon} tint={tint} />
          {progress != null && (
            <ProgressRing value={progress} id={`ring-${tint}`} size={48} stroke={6}>
              {Math.round(progress * 100)}%
            </ProgressRing>
          )}
        </div>
        <p className="mt-4 text-xs font-semibold tracking-wide text-muted uppercase">{label}</p>
        <p className="mt-1 text-3xl font-extrabold tracking-tight">
          {value === null ? '—' : <CountUp value={value} suffix={suffix} />}
        </p>
        <p className="mt-1 text-xs text-muted">{hint}</p>
      </Card>
    </Tilt>
  );
}

interface Quest {
  title: string;
  hint: string;
  href: string;
  /** null when this role cannot see the data behind the quest */
  done: boolean | null;
  icon: LucideIcon;
  tint: Tint;
}

function Quests({ quests }: { quests: Quest[] }) {
  const known = quests.filter((q) => q.done !== null);
  const done = known.filter((q) => q.done).length;
  const pct = known.length ? done / known.length : 0;
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Trophy className="size-4 text-warning" aria-hidden /> Workspace quests
          </span>
        }
        description="Set-up goals, checked against this workspace’s real records"
      />
      <div className="flex items-center gap-4 px-5 pt-4">
        <ProgressRing value={pct} id="ring-quests" size={64} stroke={8}>
          <span className="text-sm">
            {done}/{known.length}
          </span>
        </ProgressRing>
        <div>
          <p className="text-sm font-bold">Level {done + 1}</p>
          <p className="text-xs text-muted">
            {done === known.length && known.length
              ? 'Every quest complete. Nice work!'
              : `${known.length - done} quest${known.length - done === 1 ? '' : 's'} to the next level`}
          </p>
        </div>
      </div>
      <ul className="flex-1 space-y-2 p-4">
        {quests.map((q) => (
          <li key={q.title}>
            <Link
              href={q.href}
              className={cn(
                'fun-wiggle flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-border hover:bg-surface-2',
                q.done && 'bg-success/8',
              )}
            >
              <IconTile
                icon={q.done === null ? Lock : q.icon}
                tint={q.done === null ? 'sky' : q.tint}
                className="size-9 rounded-xl [&_svg]:size-4"
              />
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-semibold', q.done && 'text-success')}>{q.title}</p>
                <p className="truncate text-xs text-muted">{q.done === null ? 'Your role cannot see this' : q.hint}</p>
              </div>
              {q.done ? (
                <span className="grid size-6 place-items-center rounded-full bg-success text-white" aria-label="Done">
                  <Check className="size-3.5" />
                </span>
              ) : (
                <span className="size-6 rounded-full border-2 border-dashed border-border" aria-label="Not done yet" />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Hero({ name, children }: { name: string; children: ReactNode }) {
  const { motion, setMotion } = useTheme();
  return (
    <section className="fun-pop relative mb-6 overflow-hidden rounded-3xl border border-border bg-surface px-6 py-6 md:px-8">
      <div
        aria-hidden
        className="fun-shine absolute inset-0 bg-[linear-gradient(110deg,rgb(167_139_250/0.22),rgb(244_114_182/0.18),rgb(251_191_36/0.18),rgb(52_211_153/0.18),rgb(56_189_248/0.22))]"
      />
      <div className="relative grid items-center gap-4 md:grid-cols-[1.2fr_1fr]">
        <div>
          <Badge tone="accent" className="gap-1.5">
            <Sparkles className="size-3" aria-hidden /> Global Command Centre
          </Badge>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight md:text-4xl">
            Good to see you,{' '}
            <span className="bg-gradient-to-r from-violet-700 via-fuchsia-700 to-orange-700 bg-clip-text text-transparent">
              {name}
            </span>
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Everything here comes from this workspace’s own records. Fieldwork figures appear as SampTrek and MADP data
            arrives; FIXTURE data is always labelled.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-4">{children}</div>
          <FunSwitch className="mt-4" checked={motion} onCheckedChange={setMotion} label="Motion effects" />
        </div>
        <HeroScene />
      </div>
    </section>
  );
}

const LAUNCH = ['audience-finder', 'invitations', 'live', 'quality', 'copilot', 'reports'];

function QuickLaunch({ permissions }: { permissions: readonly string[] }) {
  const mods = MODULES.filter((m) => LAUNCH.includes(m.key) && m.ready && permissions.includes(m.permission));
  if (!mods.length) return null;
  const tints: Tint[] = ['violet', 'pink', 'sun', 'mint', 'sky', 'violet'];
  return (
    <Card className="flex-1">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Rocket className="size-4 text-accent" aria-hidden /> Quick launch
          </span>
        }
        description="Jump straight into the tools you use most"
      />
      <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
        {mods.map((m, i) => (
          <li key={m.key} className="fun-pop" style={{ ['--d' as string]: `${i * 50}ms` }}>
            <Link
              href={m.href}
              className="fun-wiggle flex h-full flex-col items-center gap-2 rounded-2xl border border-border bg-surface-2 px-2 py-4 text-center text-xs font-semibold transition-transform hover:-translate-y-1 hover:border-accent/40"
            >
              <span
                aria-hidden
                className={cn(
                  'grid size-12 place-items-center rounded-2xl bg-gradient-to-br text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.4),0_3px_0_rgb(0_0_0/0.15),0_10px_18px_-8px_rgb(0_0_0/0.4)]',
                  TINTS[tints[i % tints.length]!],
                )}
              >
                <ModuleIcon k={m.key} className="size-5" />
              </span>
              {m.name}
            </Link>
          </li>
        ))}
      </ul>
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

  const total = users.data?.items.length ?? 0;
  const anySource = sources.data ? sources.data.items.some((c) => c.enabled) : null;
  const quests: Quest[] = [
    {
      title: 'Connect SampTrek',
      hint: 'Add a source so projects can flow in',
      href: '/integrations/samptrek',
      done: canSources ? anySource : null,
      icon: Network,
      tint: 'violet',
    },
    {
      title: 'Import your first project',
      hint: 'Run a backfill from SampTrek',
      href: '/projects',
      done: canProjects && projects.data ? items.length > 0 : null,
      icon: FolderKanban,
      tint: 'sky',
    },
    {
      title: 'Launch a live project',
      hint: 'Move a project into fieldwork',
      href: '/projects',
      done: canProjects && projects.data ? live > 0 : null,
      icon: Rocket,
      tint: 'pink',
    },
    {
      title: 'Bring your team',
      hint: 'Invite at least one teammate',
      href: '/users',
      done: canUsers && users.data ? total > 1 : null,
      icon: Users,
      tint: 'mint',
    },
    {
      title: 'Everyone on two-step sign-in',
      hint: 'Every account has an authenticator',
      href: '/security',
      done: canUsers && users.data && total ? mfa === total : null,
      icon: ShieldCheck,
      tint: 'sun',
    },
  ];

  const projectList = !canProjects ? (
    <Empty title="Projects are not available for your role" />
  ) : projects.isLoading ? (
    <Loading />
  ) : items.length ? (
    <ul className="grid gap-3 p-4 md:grid-cols-2">
      {items.slice(0, 6).map((p, i) => (
        <li key={p.id} className="fun-pop" style={{ ['--d' as string]: `${i * 60}ms` }}>
          <Link
            href={`/projects/${p.id}`}
            className="fun-wiggle flex items-center gap-3 rounded-2xl border border-border bg-surface-2 px-4 py-3 transition-transform hover:-translate-y-0.5 hover:border-accent/40"
          >
            <IconTile
              icon={FolderKanban}
              tint={(['violet', 'sky', 'pink', 'mint', 'sun'] as const)[i % 5]!}
              className="size-10"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{p.name}</p>
              <p className="font-mono text-xs text-muted">
                {p.projectCode} · {p.markets?.join(' ')}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge tone={lifecycleTone(p.lifecycle)}>{lifecycleLabel(p.lifecycle)}</Badge>
              <Badge tone={sourceTone(p.sourceStatus)}>SampTrek {p.sourceStatus}</Badge>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  ) : (
    <CardBody>
      <Empty title="No projects yet">
        Connect SampTrek and run a backfill. FIXTURE mode loads labelled sample projects.
      </Empty>
    </CardBody>
  );

  const activityList = !canAudit ? (
    <Empty title="Audit log not available for your role" />
  ) : audit.isLoading ? (
    <Loading />
  ) : audit.data?.items.length ? (
    <ol className="relative mx-5 my-4 space-y-4 border-l-2 border-dashed border-border pl-5">
      {audit.data.items.map((e, i) => (
        <li key={e.id} className="fun-pop relative" style={{ ['--d' as string]: `${i * 50}ms` }}>
          <span
            aria-hidden
            className={cn(
              'absolute top-1 -left-[29px] size-3.5 rounded-full bg-gradient-to-br ring-4 ring-surface',
              TINTS[(['violet', 'sky', 'pink', 'mint', 'sun'] as const)[i % 5]!],
            )}
          />
          <p className="font-mono text-xs font-semibold text-text">{e.action}</p>
          <p className="mt-0.5 text-xs text-muted">
            {e.actorEmail ?? 'system'} · {new Date(e.at).toLocaleString()}
          </p>
        </li>
      ))}
    </ol>
  ) : (
    <Empty title="No activity yet" />
  );

  return (
    <>
      <Hero name={me.user.name.split(' ')[0] ?? ''}>
        <Link
          href="/projects"
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-accent-contrast"
        >
          <Rocket className="size-4" aria-hidden /> Open projects
        </Link>
        <Link
          href="/live"
          className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-5 text-sm font-semibold hover:bg-surface-2"
        >
          <Activity className="size-4 text-accent" aria-hidden /> Live fieldwork
        </Link>
      </Hero>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Live projects"
          value={projects.data ? live : null}
          hint={
            projects.data
              ? `${items.length} imported, ${dispatching} allowed to dispatch`
              : 'Projects come from SampTrek'
          }
          icon={Rocket}
          tint="violet"
          progress={projects.data && items.length ? live / items.length : null}
          delay={0}
        />
        <Stat
          label="People in this workspace"
          value={users.data ? total : null}
          hint="Accounts with access"
          icon={Users}
          tint="sky"
          delay={80}
        />
        <Stat
          label="Two-step sign-in coverage"
          value={mfa !== null && total ? Math.round((mfa / total) * 100) : null}
          suffix="%"
          hint="Accounts with an authenticator enrolled"
          icon={ShieldCheck}
          tint="mint"
          progress={mfa !== null && total ? mfa / total : null}
          delay={160}
        />
        <Stat
          label="Modules available"
          value={ready}
          suffix={` / ${MODULES.length}`}
          hint="Built and tested in this release"
          icon={ArrowUpRight}
          tint="sun"
          progress={ready / MODULES.length}
          delay={240}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Quests quests={quests} />
        <div className="flex flex-col gap-6 xl:col-span-2">
          <Card>
            <CardHeader
              title="Integration health"
              description="Live state of every source system. Supply360 never shows data from a source it cannot verify."
            />
            <ul className="grid gap-3 p-4 md:grid-cols-3">
              {integrations.map((i, n) => (
                <li key={i.name}>
                  <Tilt className="h-full" max={10}>
                    <div className="fun-wiggle flex h-full flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <IconTile icon={i.icon} tint={(['violet', 'pink', 'sky'] as const)[n % 3]!} />
                        <Badge tone={i.tone}>{i.state}</Badge>
                      </div>
                      <p className="text-base font-bold">{i.name}</p>
                      <p className="flex-1 text-xs text-muted">{i.note}</p>
                      <Link href={i.href} className="text-xs font-semibold text-accent hover:underline">
                        Details <span aria-hidden>→</span>
                      </Link>
                    </div>
                  </Tilt>
                </li>
              ))}
            </ul>
          </Card>
          <QuickLaunch permissions={me.permissions} />
        </div>
      </div>

      <Card className="mt-6">
        <FunTabs
          label="Workspace overview"
          tabs={[
            {
              value: 'projects',
              label: 'Projects',
              icon: FolderKanban,
              tint: TINTS.violet,
              count: projects.data ? items.length : undefined,
              content: (
                <>
                  <p className="px-5 pt-3 text-xs text-muted">
                    Imported from SampTrek. Supply360 never creates projects by hand.{' '}
                    {canProjects && (
                      <Link href="/projects" className="font-semibold text-accent hover:underline">
                        All projects
                      </Link>
                    )}
                  </p>
                  {projectList}
                </>
              ),
            },
            {
              value: 'activity',
              label: 'Recent activity',
              icon: Activity,
              tint: TINTS.pink,
              content: (
                <>
                  <p className="px-5 pt-3 text-xs text-muted">
                    From the audit log.{' '}
                    {canAudit && (
                      <Link href="/audit" className="font-semibold text-accent hover:underline">
                        All activity
                      </Link>
                    )}
                  </p>
                  {activityList}
                </>
              ),
            },
            {
              value: 'sources',
              label: 'Sources',
              icon: Database,
              tint: TINTS.mint,
              count: integrations.length,
              content: (
                <ul className="divide-y divide-border">
                  {integrations.map((i) => (
                    <li key={i.name} className="flex items-center gap-3 px-5 py-3">
                      <i.icon className="size-4 text-accent" aria-hidden />
                      <span className="flex-1 text-sm font-medium">{i.name}</span>
                      <Badge tone={i.tone}>{i.state}</Badge>
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
