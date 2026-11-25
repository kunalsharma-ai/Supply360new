'use client';
import { ROLE_LABELS, Role, canGrant, type UserSummary } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, ShieldCheck, ShieldOff, UserCog } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useCan, useSession } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Empty, ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

type RoleRow = { role: Role; label: string; permissions: string[] };
const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

function RolePicker({
  value,
  onChange,
  grantable,
}: {
  value: Role[];
  onChange: (r: Role[]) => void;
  grantable: (r: Role) => boolean;
}) {
  return (
    <fieldset className="grid grid-cols-2 gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-muted">Roles</legend>
      {Role.options.map((r) => {
        const on = value.includes(r);
        const ok = grantable(r);
        return (
          <label
            key={r}
            className={cn(
              'flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm',
              on && 'border-accent/50 bg-accent/10',
              !ok && 'opacity-40',
            )}
          >
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={on}
              disabled={!ok}
              onChange={() => onChange(on ? value.filter((x) => x !== r) : [...value, r])}
            />
            {ROLE_LABELS[r]}
          </label>
        );
      })}
    </fieldset>
  );
}

export default function UsersPage() {
  const me = useSession();
  const canRead = useCan('users.read');
  const canManage = useCan('users.manage');
  const qc = useQueryClient();
  const [tab, setTab] = useState<'people' | 'roles'>('people');
  const [creating, setCreating] = useState(false);
  const [newRoles, setNewRoles] = useState<Role[]>(['supply_executive']);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [editRoles, setEditRoles] = useState<Role[]>([]);
  const [disabling, setDisabling] = useState<UserSummary | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ items: UserSummary[]; nextCursor: string | null }>('/users?limit=200'),
    enabled: canRead,
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleRow[]>('/roles'), enabled: tab === 'roles' });
  const grantable = (r: Role) => canGrant(me.permissions, r);
  const done = (msg: string) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: ['users'] });
  };

  const create = useMutation({
    mutationFn: (body: unknown) => api<UserSummary>('/users', { method: 'POST', body }),
    onSuccess: (u) => {
      setCreating(false);
      done(`${u.name} added. They set up two-step sign-in the first time they sign in.`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const setRoles = useMutation({
    mutationFn: ({ id, roles }: { id: string; roles: Role[] }) =>
      api(`/users/${id}/roles`, { method: 'PATCH', body: { roles } }),
    onSuccess: () => {
      setEditing(null);
      done('Roles saved');
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: 'active' | 'disabled'; reason: string }) =>
      api(`/users/${id}/status`, { method: 'PATCH', body: { status, reason } }),
    onSuccess: (_d, v) => {
      setDisabling(null);
      done(v.status === 'disabled' ? 'Account disabled and signed out everywhere' : 'Account enabled');
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!canRead) return <NoPermission permission="users.read" />;

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({ name: f.get('name'), email: f.get('email'), password: f.get('password'), roles: newRoles });
  };

  return (
    <>
      <PageHeader
        title="Users and roles"
        description="Who can use this workspace and what each role may do. The server enforces the same matrix you see here."
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> Add person
            </Button>
          )
        }
      />
      <div role="tablist" className="mb-4 inline-flex rounded-lg border border-border bg-surface p-1">
        {(['people', 'roles'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('rounded-md px-3 py-1.5 text-sm text-muted', tab === t && 'bg-surface-3 text-text')}
          >
            {t === 'people' ? 'People' : 'Role matrix'}
          </button>
        ))}
      </div>

      {tab === 'people' && (
        <Card>
          {users.isLoading ? (
            <Loading />
          ) : users.error ? (
            <ErrorState error={users.error} />
          ) : !users.data?.items.length ? (
            <Empty title="No people yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-5 py-3 font-medium">Name</th>
                    <th className="px-3 py-3 font-medium">Roles</th>
                    <th className="px-3 py-3 font-medium">Two-step</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 font-medium">Last sign-in</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.data.items.map((u) => (
                    <tr key={u.id} className="hover:bg-surface-2/60">
                      <td className="px-5 py-3">
                        <p className="font-medium">{u.name}</p>
                        <p className="text-xs text-muted">{u.email}</p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((r) => (
                            <Badge key={r} tone="accent">
                              {ROLE_LABELS[r]}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {u.mfaEnabled ? (
                          <Badge tone="success">
                            <Check className="size-3" /> On
                          </Badge>
                        ) : (
                          <Badge tone="warning">Pending</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {u.status === 'active' ? (
                          <Badge tone="success">Active</Badge>
                        ) : (
                          <Badge tone="danger">Disabled</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs text-muted tabular-nums">
                        {u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString() : 'Never'}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        {canManage && u.id !== me.user.id && u.roles.every(grantable) && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditing(u);
                                setEditRoles(u.roles);
                              }}
                            >
                              <UserCog /> Roles
                            </Button>
                            {u.status === 'active' ? (
                              <Button size="sm" variant="ghost" onClick={() => setDisabling(u)}>
                                <ShieldOff /> Disable
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setStatus.mutate({ id: u.id, status: 'active', reason: 'Re-enabled by admin' })
                                }
                              >
                                <ShieldCheck /> Enable
                              </Button>
                            )}
                          </>
                        )}
                        {u.id === me.user.id && <span className="text-xs text-muted">You</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'roles' && (
        <Card>
          <CardHeader title="Role matrix" description="Eleven roles from the specification, served by the API." />
          {roles.isLoading ? (
            <Loading />
          ) : roles.error ? (
            <ErrorState error={roles.error} />
          ) : (
            <ul className="divide-y divide-border">
              {roles.data?.map((r) => (
                <li key={r.role} className="px-5 py-4">
                  <p className="text-sm font-medium">{r.label}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.permissions.map((p) => (
                      <code key={p} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
                        {p}
                      </code>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Add a person"
        description="They sign in with this password and set up an authenticator app at first sign-in."
      >
        <form onSubmit={onCreate} className="space-y-4">
          <div>
            <Label htmlFor="n-name">Full name</Label>
            <Input id="n-name" name="name" required minLength={2} />
          </div>
          <div>
            <Label htmlFor="n-email">Work e-mail</Label>
            <Input id="n-email" name="email" type="email" required />
          </div>
          <div>
            <Label htmlFor="n-pass">Initial password</Label>
            <Input id="n-pass" name="password" type="password" required minLength={14} autoComplete="new-password" />
            <p className="mt-1 text-xs text-muted">
              At least 14 characters with letters and numbers. Share it securely.
            </p>
          </div>
          <RolePicker value={newRoles} onChange={setNewRoles} grantable={grantable} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={create.isPending || !newRoles.length}>
              Add person
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={`Roles for ${editing?.name ?? ''}`}
        description="Changes apply at their next request and are recorded in the audit log."
      >
        <RolePicker value={editRoles} onChange={setEditRoles} grantable={grantable} />
        <div className="flex justify-end gap-2 pt-5">
          <Button variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!editRoles.length || setRoles.isPending}
            onClick={() => editing && setRoles.mutate({ id: editing.id, roles: editRoles })}
          >
            Save roles
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!disabling}
        onOpenChange={(o) => !o && setDisabling(null)}
        title={`Disable ${disabling?.name ?? ''}?`}
        description="They are signed out everywhere at once and cannot sign in until enabled again."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
            if (disabling) setStatus.mutate({ id: disabling.id, status: 'disabled', reason });
          }}
          className="space-y-4"
        >
          <div>
            <Label htmlFor="reason">Reason (kept in the audit log)</Label>
            <Input id="reason" name="reason" required minLength={3} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDisabling(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={setStatus.isPending}>
              Disable account
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
