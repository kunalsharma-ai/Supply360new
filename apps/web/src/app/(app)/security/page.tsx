'use client';
import type { UserSummary } from '@s360/contracts';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Card, CardHeader } from '@/components/ui/card';
import { NoPermission } from '@/components/ui/states';
import { api } from '@/lib/api';

const CONTROLS: { name: string; done: boolean; note: string }[] = [
  {
    name: 'Tenant isolation by row-level security',
    done: true,
    note: 'Every tenant table is filtered by the database for the request’s workspace; tested in CI.',
  },
  { name: 'Two-step sign-in required', done: true, note: 'TOTP at every sign-in; codes can be used once.' },
  { name: 'Account lockout', done: true, note: 'Five wrong passwords lock an account for 15 minutes.' },
  { name: 'Session revocation', done: true, note: 'Sign-out and disabling an account end sessions at once.' },
  { name: 'Append-only audit log', done: true, note: 'The application role cannot update or delete audit entries.' },
  { name: 'CSRF protection', done: true, note: 'SameSite=Strict cookies plus a required header on every write.' },
  { name: 'Secrets sealed at rest', done: true, note: 'Authenticator secrets are encrypted with AES-256-GCM.' },
  { name: 'Single sign-on (OIDC)', done: false, note: 'Planned before production (ADR-010).' },
  { name: 'Signed inbound webhooks', done: false, note: 'Phase 2, with the SampTrek integration.' },
];

export default function SecurityPage() {
  const can = useCan('security.read');
  const canUsers = useCan('users.read');
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: UserSummary[] }>('/users?limit=200'),
    enabled: can && canUsers,
  });
  if (!can) return <NoPermission permission="security.read" />;
  const items = users.data?.items ?? [];
  const pending = items.filter((u) => !u.mfaEnabled && u.status === 'active');
  return (
    <>
      <PageHeader
        title="Security Centre"
        description="Controls in force in this release, and accounts that still need attention."
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Controls" />
          <ul className="divide-y divide-border">
            {CONTROLS.map((c) => (
              <li key={c.name} className="flex items-start gap-3 px-5 py-3">
                {c.done ? (
                  <CheckCircle2 className="mt-0.5 size-4 text-success" aria-label="In force" />
                ) : (
                  <CircleDashed className="mt-0.5 size-4 text-muted" aria-label="Planned" />
                )}
                <div>
                  <p className="text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-muted">{c.note}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader
            title="Two-step sign-in not set up"
            description="Active accounts that have never completed enrolment"
          />
          {!canUsers ? (
            <p className="p-5 text-sm text-muted">Needs users.read.</p>
          ) : pending.length ? (
            <ul className="divide-y divide-border">
              {pending.map((u) => (
                <li key={u.id} className="px-5 py-3 text-sm">
                  {u.name}
                  <span className="block text-xs text-muted">{u.email}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-5 text-sm text-muted">Every active account has an authenticator enrolled.</p>
          )}
        </Card>
      </div>
    </>
  );
}
