'use client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtN } from '@/lib/audience';
import { BATCH_TONE, when, type BatchRow } from '@/lib/execution';

/** Batches with what happened to each: authorised by MADP, refused, sent, and why one waits or stopped. */
export function BatchesTable({
  rows,
  showProject,
  actions,
}: {
  rows: BatchRow[];
  showProject?: boolean;
  actions?: (b: BatchRow) => React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {showProject && <th className="py-2 pr-3 font-medium">Project</th>}
            <th className="py-2 pr-3 font-medium">Cell</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 text-right font-medium">Size</th>
            <th className="px-3 py-2 text-right font-medium">Refused</th>
            <th className="px-3 py-2 text-right font-medium">Sent</th>
            <th className="px-3 py-2 font-medium">When</th>
            {actions && <th className="py-2 pl-3 text-right font-medium">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((b) => (
            <tr key={b.id}>
              {showProject && <td className="py-2 pr-3 font-mono text-xs">{b.projectCode}</td>}
              <td className="py-2 pr-3">{b.countryCode ? `${b.countryCode} · ${b.cellName}` : b.cellId.slice(0, 8)}</td>
              <td className="px-3 py-2">
                <Badge tone={BATCH_TONE[b.status]}>{b.status}</Badge>
                {b.blockedText && (
                  <p className="mt-1 text-xs text-muted">
                    {b.status === 'blocked' ? 'Stopped: ' : 'Waiting: '}
                    {b.blockedText}
                  </p>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-muted">
                {b.origin === 'system' ? `System (${b.mode.replace('_', '-')})` : 'Person'}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtN(b.size)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtN(b.refused)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtN(b.sent)}</td>
              <td className="px-3 py-2 text-xs text-muted">
                {b.scheduledAt && b.status === 'approved'
                  ? `Scheduled ${when(b.scheduledAt)}`
                  : when(b.finishedAt ?? b.createdAt)}
              </td>
              {actions && <td className="py-2 pl-3 text-right">{actions(b)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BatchActions({
  b,
  canApprove,
  canDispatch,
  onDecide,
  onSend,
  busy,
}: {
  b: BatchRow;
  canApprove: boolean;
  canDispatch: boolean;
  onDecide: (b: BatchRow, d: 'approve' | 'reject' | 'cancel') => void;
  onSend: (b: BatchRow) => void;
  busy: boolean;
}) {
  return (
    <div className="flex justify-end gap-1.5">
      {b.status === 'proposed' && canApprove && (
        <>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide(b, 'approve')}>
            Approve
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onDecide(b, 'reject')}>
            Reject
          </Button>
        </>
      )}
      {b.status === 'approved' && canDispatch && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onSend(b)}>
          Send now
        </Button>
      )}
      {(b.status === 'proposed' || b.status === 'approved') && canDispatch && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(b, 'cancel')}>
          Cancel
        </Button>
      )}
    </div>
  );
}
