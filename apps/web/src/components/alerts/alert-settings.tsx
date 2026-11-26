'use client';
import { ALERT_CATEGORIES, ALERT_CATEGORY_LABELS, type AlertCategory } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageSquare, Send, Sunrise } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/input';
import { Loading } from '@/components/ui/states';
import { api, ApiError } from '@/lib/api';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

interface View {
  settings: {
    emailEnabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    hasSmtpPassword: boolean;
    fromAddress: string;
    recipients: string[];
    webhookEnabled: boolean;
    hasWebhook: boolean;
    categories: AlertCategory[];
    minSeverity: string;
    irDropPoints: number;
    digestEnabled: boolean;
    digestHour: number;
    digestTimezone: string;
    lastDigestOn: string | null;
  };
  recent: {
    id: string;
    channel: string;
    kind: string;
    status: string;
    error: string | null;
    subject: string;
    at: string;
    attempts: number;
  }[];
}

const MAIL_PRESETS = [
  { label: 'Zoho Mail (India)', host: 'smtp.zoho.in', port: 465, secure: true },
  { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true },
  { label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 465, secure: true },
  { label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, secure: false },
  { label: 'Amazon SES (Mumbai)', host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, secure: false },
  { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
];

function Toggle({
  id,
  checked,
  onChange,
  disabled,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 text-sm font-medium">
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className="relative h-6 w-11 shrink-0 rounded-full bg-surface-3 transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5"
      />
      {children}
    </label>
  );
}

/** Email and chat alerts, and the morning digest. Everything is set here; nothing is read from environment files. */
export function AlertSettingsCard() {
  const qc = useQueryClient();
  const canRead = useCan('settings.read');
  const canManage = useCan('settings.manage');
  const q = useQuery({ queryKey: ['alerts'], queryFn: () => api<View>('/alerts'), enabled: canRead });
  const [s, setS] = useState<View['settings'] | null>(null);
  const [password, setPassword] = useState('');
  const [webhook, setWebhook] = useState('');
  const [recipients, setRecipients] = useState('');
  useEffect(() => {
    if (q.data) {
      setS(q.data.settings);
      setRecipients(q.data.settings.recipients.join(', '));
    }
  }, [q.data]);
  const set = <K extends keyof View['settings']>(k: K, v: View['settings'][K]) =>
    setS((x) => (x ? { ...x, [k]: v } : x));

  const save = useMutation({
    mutationFn: () =>
      api('/alerts', {
        method: 'PUT',
        body: {
          emailEnabled: s!.emailEnabled,
          ...(s!.smtpHost.trim() ? { smtpHost: s!.smtpHost.trim() } : {}),
          smtpPort: s!.smtpPort,
          smtpSecure: s!.smtpSecure,
          ...(s!.smtpUser.trim() ? { smtpUser: s!.smtpUser.trim() } : {}),
          ...(password ? { smtpPassword: password } : {}),
          ...(s!.fromAddress.trim() ? { fromAddress: s!.fromAddress.trim() } : {}),
          recipients: recipients
            .split(/[,;\s]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          webhookEnabled: s!.webhookEnabled,
          ...(webhook.trim() ? { webhookUrl: webhook.trim() } : {}),
          categories: s!.categories,
          minSeverity: s!.minSeverity,
          irDropPoints: s!.irDropPoints,
          digestEnabled: s!.digestEnabled,
          digestHour: s!.digestHour,
          digestTimezone: s!.digestTimezone,
        },
      }),
    onSuccess: () => {
      toast.success('Alert settings saved');
      setPassword('');
      setWebhook('');
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const test = useMutation({
    mutationFn: (channel: 'email' | 'webhook' | 'digest') =>
      api<{ ok: boolean; results: { channel: string; error: string | null }[] }>('/alerts/test', {
        method: 'POST',
        body: { channel },
      }),
    onSuccess: (r) => {
      if (r.ok) toast.success('Sent. Check your inbox or chat.');
      else toast.error(r.results.map((x) => `${x.channel}: ${x.error}`).join(' · '));
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!canRead) return null;
  if (!s)
    return (
      <Card className="mt-6">
        <Loading />
      </Card>
    );
  const off = !canManage;

  return (
    <Card className="mt-6" data-testid="alert-settings">
      <CardHeader
        title="Email and chat alerts"
        description="Get the alerts that matter by email or in Slack, Google Chat or Teams, plus one summary every morning. Nobody has to keep watching the screens."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <CardBody className="space-y-6">
          <section className="space-y-3">
            <Toggle id="al-email" checked={s.emailEnabled} disabled={off} onChange={(v) => set('emailEnabled', v)}>
              <Mail className="size-4 text-accent" /> Email alerts
            </Toggle>
            {s.emailEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="al-preset">Mail service</Label>
                  <Select
                    id="al-preset"
                    disabled={off}
                    value={MAIL_PRESETS.find((p) => p.host === s.smtpHost)?.host ?? ''}
                    onChange={(e) => {
                      const p = MAIL_PRESETS.find((x) => x.host === e.target.value);
                      if (p) setS((x) => (x ? { ...x, smtpHost: p.host, smtpPort: p.port, smtpSecure: p.secure } : x));
                    }}
                  >
                    <option value="">Other (type the server below)</option>
                    {MAIL_PRESETS.map((p) => (
                      <option key={p.host} value={p.host}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="al-host">Mail server (SMTP)</Label>
                  <Input
                    id="al-host"
                    value={s.smtpHost}
                    disabled={off}
                    placeholder="smtp.zoho.in"
                    onChange={(e) => set('smtpHost', e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="al-port">Port</Label>
                    <Select
                      id="al-port"
                      value={s.smtpPort}
                      disabled={off}
                      onChange={(e) => set('smtpPort', Number(e.target.value))}
                    >
                      {[465, 587, 2525, 25].map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex items-end pb-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        checked={s.smtpSecure}
                        disabled={off}
                        onChange={(e) => set('smtpSecure', e.target.checked)}
                      />
                      SSL (465)
                    </label>
                  </div>
                </div>
                <div>
                  <Label htmlFor="al-user">Username</Label>
                  <Input
                    id="al-user"
                    value={s.smtpUser}
                    autoComplete="off"
                    disabled={off}
                    placeholder="alerts@yourcompany.com"
                    onChange={(e) => set('smtpUser', e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="al-pass">Password or app password</Label>
                  <Input
                    id="al-pass"
                    type="password"
                    autoComplete="new-password"
                    disabled={off}
                    value={password}
                    placeholder={s.hasSmtpPassword ? '•••••••• (stored, sealed)' : ''}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="al-from">From address</Label>
                  <Input
                    id="al-from"
                    type="email"
                    value={s.fromAddress}
                    disabled={off}
                    placeholder="alerts@yourcompany.com"
                    onChange={(e) => set('fromAddress', e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="al-to">Send to (comma separated)</Label>
                  <Input
                    id="al-to"
                    value={recipients}
                    disabled={off}
                    placeholder="ops@yourcompany.com, head@yourcompany.com"
                    onChange={(e) => setRecipients(e.target.value)}
                  />
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <Toggle id="al-hook" checked={s.webhookEnabled} disabled={off} onChange={(v) => set('webhookEnabled', v)}>
              <MessageSquare className="size-4 text-accent" /> Slack, Google Chat or Teams
            </Toggle>
            {s.webhookEnabled && (
              <div>
                <Label htmlFor="al-url">Incoming webhook address</Label>
                <Input
                  id="al-url"
                  type="url"
                  autoComplete="off"
                  disabled={off}
                  value={webhook}
                  placeholder={
                    s.hasWebhook
                      ? '•••••••• (stored, sealed). Paste a new one to replace it.'
                      : 'https://hooks.slack.com/services/…'
                  }
                  onChange={(e) => setWebhook(e.target.value)}
                />
              </div>
            )}
          </section>

          <section>
            <p className="mb-2 text-xs font-medium text-muted">Send these alerts</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {ALERT_CATEGORIES.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    disabled={off}
                    checked={s.categories.includes(c)}
                    onChange={(e) =>
                      set('categories', e.target.checked ? [...s.categories, c] : s.categories.filter((x) => x !== c))
                    }
                  />
                  {ALERT_CATEGORY_LABELS[c]}
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="al-sev">Only when at least</Label>
                <Select
                  id="al-sev"
                  value={s.minSeverity}
                  disabled={off}
                  onChange={(e) => set('minSeverity', e.target.value)}
                >
                  <option value="info">Info (everything)</option>
                  <option value="warning">Warning</option>
                  <option value="danger">Danger</option>
                  <option value="critical">Critical only</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="al-ir">Alert when IR is this many points below expected</Label>
                <Input
                  id="al-ir"
                  type="number"
                  min={5}
                  max={80}
                  value={s.irDropPoints}
                  disabled={off}
                  onChange={(e) => set('irDropPoints', Number(e.target.value))}
                />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <Toggle id="al-digest" checked={s.digestEnabled} disabled={off} onChange={(v) => set('digestEnabled', v)}>
              <Sunrise className="size-4 text-accent" /> Daily digest of every live project
            </Toggle>
            {s.digestEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="al-hour">At</Label>
                  <Select
                    id="al-hour"
                    value={s.digestHour}
                    disabled={off}
                    onChange={(e) => set('digestHour', Number(e.target.value))}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, '0')}:00
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="al-tz">Time zone</Label>
                  <Input
                    id="al-tz"
                    value={s.digestTimezone}
                    disabled={off}
                    onChange={(e) => set('digestTimezone', e.target.value)}
                  />
                </div>
              </div>
            )}
          </section>

          {canManage && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={test.isPending} onClick={() => test.mutate('email')}>
                  <Send /> Test email
                </Button>
                <Button type="button" size="sm" disabled={test.isPending} onClick={() => test.mutate('webhook')}>
                  <Send /> Test chat
                </Button>
                <Button type="button" size="sm" disabled={test.isPending} onClick={() => test.mutate('digest')}>
                  <Sunrise /> Send today’s digest now
                </Button>
              </div>
              <Button type="submit" variant="primary" disabled={save.isPending}>
                Save alerts
              </Button>
            </div>
          )}

          {!!q.data?.recent.length && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Recently sent</p>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {q.data.recent.slice(0, 10).map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                    <Badge tone={d.status === 'sent' ? 'success' : 'danger'}>{d.status}</Badge>
                    <span className="flex-1 truncate" title={d.error ?? d.subject}>
                      {d.subject}
                      {d.error && <span className="text-danger"> · {d.error}</span>}
                    </span>
                    <span className="text-xs text-muted">
                      {d.channel} · {new Date(d.at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      </form>
    </Card>
  );
}
