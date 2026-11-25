'use client';
import type { LoginResponse } from '@s360/contracts';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import QRCode from 'qrcode';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Logo } from '@/components/shell/logo';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';

/** Only same-site paths, so a crafted link cannot bounce the person to another site after sign-in. */
function safeNext(v: string | null) {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [stage, setStage] = useState<'password' | 'mfa_setup' | 'mfa_challenge'>('password');
  const [uri, setUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (uri) QRCode.toDataURL(uri, { margin: 1, width: 192 }).then(setQr, () => setQr(null));
  }, [uri]);

  async function submitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { tenant: f.get('tenant'), email: f.get('email'), password: f.get('password') },
      });
      if (r.stage === 'mfa_setup') {
        setUri(r.otpauthUri);
        setStage('mfa_setup');
      } else if (r.stage === 'mfa_challenge') setStage('mfa_challenge');
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : 'The API is not reachable');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setBusy(true);
    setError(null);
    try {
      await api('/auth/mfa', { method: 'POST', body: { code } });
      router.replace(safeNext(params.get('next')));
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : 'The API is not reachable');
      if (err instanceof ApiError && err.problem.code === 'session_invalid') setStage('password');
    } finally {
      setBusy(false);
    }
  }

  const secret = uri ? new URL(uri).searchParams.get('secret') : null;

  return (
    <div className="bg-grid relative grid min-h-screen place-items-center overflow-hidden p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-accent/15 blur-3xl"
      />
      <div className="relative w-full max-w-sm rounded-2xl border border-border bg-surface/90 p-7 shadow-glow backdrop-blur">
        <Logo />
        {stage === 'password' && (
          <form onSubmit={submitPassword} className="mt-6 space-y-4" noValidate>
            <div>
              <h1 className="text-lg font-semibold">Sign in</h1>
              <p className="text-sm text-muted">Audience supply and fieldwork automation.</p>
            </div>
            <div>
              <Label htmlFor="tenant">Workspace</Label>
              <Input id="tenant" name="tenant" autoComplete="organization" required placeholder="your-workspace" />
            </div>
            <div>
              <Label htmlFor="email">Work e-mail</Label>
              <Input id="email" name="email" type="email" autoComplete="username" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Continue
            </Button>
          </form>
        )}
        {stage !== 'password' && (
          <form onSubmit={submitCode} className="mt-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-5 text-accent" />
              <div>
                <h1 className="text-lg font-semibold">
                  {stage === 'mfa_setup' ? 'Set up two-step sign-in' : 'Enter your code'}
                </h1>
                <p className="text-sm text-muted">
                  {stage === 'mfa_setup'
                    ? 'Scan this with an authenticator app, then enter the 6-digit code it shows.'
                    : 'Open your authenticator app and enter the current 6-digit code.'}
                </p>
              </div>
            </div>
            {stage === 'mfa_setup' && (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-white p-3">
                {qr ? (
                  <img src={qr} alt="QR code for your authenticator app" width={192} height={192} />
                ) : (
                  <div className="size-48" />
                )}
                {secret && <code className="font-mono text-[11px] break-all text-slate-700">{secret}</code>}
              </div>
            )}
            <div>
              <Label htmlFor="code">6-digit code</Label>
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                autoFocus
                className="font-mono tracking-[0.4em]"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify and sign in
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
