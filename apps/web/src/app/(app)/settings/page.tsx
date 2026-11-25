'use client';
import type { TenantSettings } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useTheme } from '@/components/providers';
import { useCan } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { ErrorState, Loading, NoPermission } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';
import { THEMES, type ThemeId } from '@/lib/themes';
import { cn } from '@/lib/cn';

const ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function SettingsPage() {
  const can = useCan('settings.read');
  const canManage = useCan('settings.manage');
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ value: TenantSettings; version: number }>('/settings/tenant'),
    enabled: can,
  });
  const save = useMutation({
    mutationFn: (v: TenantSettings) => api<{ version: number }>('/settings/tenant', { method: 'PUT', body: v }),
    onSuccess: (r) => {
      toast.success(`Saved (version ${r.version})`);
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Save failed'),
  });
  if (!can) return <NoPermission permission="settings.read" />;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({
      displayName: String(f.get('displayName')),
      timezone: String(f.get('timezone')),
      locale: String(f.get('locale')),
      defaultTheme: f.get('defaultTheme') as ThemeId,
      defaultExecutionMode: 'manual',
    });
  };

  return (
    <>
      <PageHeader
        title="System settings"
        description="Workspace defaults. Every change is versioned and recorded in the audit log."
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Workspace" />
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            q.data && (
              <CardBody>
                <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
                  <fieldset disabled={!canManage} className="contents">
                    <div className="sm:col-span-2">
                      <Label htmlFor="displayName">Display name</Label>
                      <Input
                        id="displayName"
                        name="displayName"
                        defaultValue={q.data.value.displayName}
                        required
                        minLength={2}
                      />
                    </div>
                    <div>
                      <Label htmlFor="timezone">Time zone</Label>
                      <Select id="timezone" name="timezone" defaultValue={q.data.value.timezone}>
                        {ZONES.map((z) => (
                          <option key={z}>{z}</option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="locale">Locale</Label>
                      <Select id="locale" name="locale" defaultValue={q.data.value.locale}>
                        {['en', 'en-GB', 'en-IN', 'en-US', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP'].map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="defaultTheme">Default theme for new people</Label>
                      <Select id="defaultTheme" name="defaultTheme" defaultValue={q.data.value.defaultTheme}>
                        {THEMES.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="execMode">Default execution mode</Label>
                      <Input id="execMode" value="Manual (until automation is configured)" readOnly aria-readonly />
                    </div>
                    {canManage && (
                      <div className="flex justify-end sm:col-span-2">
                        <Button type="submit" variant="primary" disabled={save.isPending}>
                          <Save /> Save settings
                        </Button>
                      </div>
                    )}
                  </fieldset>
                </form>
                <p className="mt-4 text-xs text-muted">Version {q.data.version}</p>
              </CardBody>
            )
          )}
        </Card>
        <Card>
          <CardHeader title="Your theme" description="Saved on this device" />
          <CardBody className="grid gap-2">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                aria-pressed={theme === t.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-surface-2',
                  theme === t.id && 'border-accent ring-1 ring-accent/40',
                )}
              >
                <span className="flex h-8 w-12 overflow-hidden rounded-md ring-1 ring-border" aria-hidden>
                  <span className="w-2/3" style={{ background: t.swatch[0] }} />
                  <span className="w-1/3" style={{ background: t.swatch[1] }} />
                </span>
                <span>
                  <span className="block text-sm font-medium">{t.name}</span>
                  <span className="block text-xs text-muted">{t.hint}</span>
                </span>
              </button>
            ))}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
