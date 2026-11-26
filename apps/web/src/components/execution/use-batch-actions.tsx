'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import type { BatchRow } from '@/lib/execution';
import { BatchActions } from './batches-table';

export const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

const VERB = { approve: 'Approve', reject: 'Reject', cancel: 'Cancel' } as const;

/** Approve, reject, cancel (each with a reason, for the audit log) and send-now for batch rows. */
export function useBatchActions() {
  const qc = useQueryClient();
  const canApprove = useCan('execution.approve');
  const canDispatch = useCan('invitations.dispatch');
  const [pending, setPending] = useState<{ b: BatchRow; d: keyof typeof VERB } | null>(null);
  const [reason, setReason] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['execution'] });
  const report = (b: BatchRow) =>
    b.status === 'sent'
      ? toast.success(`Sent ${b.sent} invitations${b.refused ? `, ${b.refused} refused by MADP` : ''}`)
      : b.blockedText
        ? toast.warning(`${b.status === 'blocked' ? 'Stopped' : 'Waiting'}: ${b.blockedText}`)
        : toast.success(`Batch ${b.status}`);
  const decide = useMutation({
    mutationFn: ({ b, d }: { b: BatchRow; d: string }) =>
      api<BatchRow>(`/projects/${b.projectId}/batches/${b.id}/decision`, {
        method: 'POST',
        body: { decision: d, reason },
      }),
    onSuccess: (b) => {
      report(b);
      setPending(null);
      setReason('');
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const send = useMutation({
    mutationFn: (b: BatchRow) => api<BatchRow>(`/projects/${b.projectId}/batches/${b.id}/send`, { method: 'POST' }),
    onSuccess: (b) => {
      report(b);
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const actions = (b: BatchRow) => (
    <BatchActions
      b={b}
      canApprove={canApprove}
      canDispatch={canDispatch}
      busy={decide.isPending || send.isPending}
      onDecide={(b, d) => setPending({ b, d })}
      onSend={(b) => send.mutate(b)}
    />
  );
  const dialog = (
    <Dialog
      open={!!pending}
      onOpenChange={(o) => !o && setPending(null)}
      title={pending ? `${VERB[pending.d]} this batch of ${pending.b.size}` : ''}
      description={
        pending?.d === 'approve' ? 'It is sent at once (or at its scheduled time) if every check passes.' : undefined
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) decide.mutate({ b: pending.b, d: pending.d });
        }}
      >
        <div>
          <Label htmlFor="decision-reason">Reason (kept in the audit log)</Label>
          <Input
            id="decision-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            required
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={() => setPending(null)}>
            Back
          </Button>
          <Button type="submit" variant={pending?.d === 'approve' ? 'primary' : 'danger'} disabled={decide.isPending}>
            {pending ? VERB[pending.d] : ''}
          </Button>
        </div>
      </form>
    </Dialog>
  );
  return { actions, dialog };
}
