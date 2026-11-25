import { AlertTriangle, Inbox, Loader2, Lock } from 'lucide-react';
import type { ReactNode } from 'react';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" /> {label}…
    </div>
  );
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
      <Inbox className="size-8 text-muted/60" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}
export function ErrorState({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div
      role="alert"
      className="m-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {msg}
    </div>
  );
}
export function NoPermission({ permission }: { permission: string }) {
  return (
    <div className="flex flex-col items-center gap-2 p-10 text-center">
      <Lock className="size-8 text-muted/60" aria-hidden />
      <p className="text-sm font-medium">You do not have access to this</p>
      <p className="text-sm text-muted">
        It needs the <code className="rounded bg-surface-3 px-1 font-mono text-xs">{permission}</code> permission. Ask a
        tenant admin.
      </p>
    </div>
  );
}
