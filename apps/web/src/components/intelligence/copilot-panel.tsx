'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Send, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { errMsg } from '@/components/execution/use-batch-actions';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

interface Interaction {
  id: string;
  prompt: string;
  intent: string;
  query: Record<string, unknown> | null;
  modelVersion: string;
  rationale: string;
  status: 'answered' | 'proposed' | 'approved' | 'rejected' | 'failed' | 'refused';
  action: { type: 'create_batch'; projectCode: string; cellName: string; size: number; reason: string } | null;
  answer: { text: string; batch?: { id: string; status: string; blockedReason: string | null } } | null;
  createdAt: string;
}
const TONE = {
  answered: 'success',
  proposed: 'accent',
  approved: 'success',
  rejected: 'neutral',
  failed: 'danger',
  refused: 'warning',
} as const;

function Proposal({ x }: { x: Interaction }) {
  const canDispatch = useCan('invitations.dispatch');
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      api(`/copilot/${x.id}/decision`, { method: 'POST', body: { decision, reason } }),
    onSuccess: (_d, decision) => {
      toast.success(decision === 'approve' ? 'Batch created through the normal checks' : 'Proposal rejected');
      void qc.invalidateQueries({ queryKey: ['copilot'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const a = x.action!;
  return (
    <div className="mt-2 rounded-md border border-accent/30 bg-accent/5 p-3 text-xs" data-testid="copilot-proposal">
      <p className="font-medium">
        Proposed: a batch of {a.size} for {a.projectCode}, cell {a.cellName}.
      </p>
      {canDispatch ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <Label htmlFor={`cp-r-${x.id}`}>Reason</Label>
            <Input id={`cp-r-${x.id}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={reason.trim().length < 3 || decide.isPending}
            onClick={() => decide.mutate('approve')}
          >
            <Check /> Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={reason.trim().length < 3 || decide.isPending}
            onClick={() => decide.mutate('reject')}
          >
            <X /> Reject
          </Button>
        </div>
      ) : (
        <p className="mt-1 text-muted">Someone who may send invitations needs to approve this.</p>
      )}
    </div>
  );
}

export function CopilotPanel({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const q = useQuery({
    queryKey: ['copilot'],
    queryFn: () => api<{ items: Interaction[]; examples: string[]; modelVersion: string }>('/copilot'),
  });
  const ask = useMutation({
    mutationFn: (p: string) => api<Interaction>('/copilot/ask', { method: 'POST', body: { prompt: p } }),
    onSuccess: () => {
      setPrompt('');
      void qc.invalidateQueries({ queryKey: ['copilot'] });
      void qc.invalidateQueries({ queryKey: ['exports'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (prompt.trim().length >= 2) ask.mutate(prompt.trim());
  };
  const items = [...(q.data?.items ?? [])].reverse();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('min-h-0 flex-1 space-y-4 overflow-y-auto', compact ? 'p-4' : 'py-2')} aria-live="polite">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !items.length ? (
          <Empty title="Ask about audiences, delivery, quotas, reminders or exports">
            Questions become typed, permission-checked queries. Anything that would send invitations is only proposed.
          </Empty>
        ) : (
          items.map((x) => (
            <div key={x.id} className="space-y-1.5" data-testid="copilot-turn">
              <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-accent/15 px-3 py-2 text-sm">{x.prompt}</p>
              <div className="max-w-[95%] rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                  <Bot className="size-3.5" /> <Badge tone={TONE[x.status]}>{x.status}</Badge>
                  <span>{x.modelVersion}</span>
                </div>
                <p data-testid="copilot-answer">{x.answer?.text}</p>
                {x.answer?.batch && (
                  <p className="mt-1 text-xs text-muted">
                    Batch {x.answer.batch.status}
                    {x.answer.batch.blockedReason ? `: ${x.answer.batch.blockedReason}` : ''}
                  </p>
                )}
                {x.status === 'proposed' && x.action && <Proposal x={x} />}
                <details className="mt-1 text-xs text-muted">
                  <summary className="cursor-pointer">Why and how</summary>
                  <p className="mt-1">{x.rationale}</p>
                  {x.query && Object.keys(x.query).length > 0 && (
                    <pre className="mt-1 overflow-x-auto rounded bg-surface-3 p-2 font-mono text-[11px]">
                      {JSON.stringify(x.query, null, 2)}
                    </pre>
                  )}
                </details>
              </div>
            </div>
          ))
        )}
      </div>
      <div className={cn('border-t border-border', compact ? 'p-3' : 'pt-4')}>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(q.data?.examples ?? []).slice(0, compact ? 3 : 6).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setPrompt(e)}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-text"
            >
              {e}
            </button>
          ))}
        </div>
        <form onSubmit={onSubmit} className="flex gap-2">
          <label htmlFor={compact ? 'copilot-input-drawer' : 'copilot-input'} className="sr-only">
            Ask the Copilot
          </label>
          <Input
            id={compact ? 'copilot-input-drawer' : 'copilot-input'}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={500}
            placeholder="Ask about audiences, delivery or exports"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={ask.isPending || prompt.trim().length < 2}
            aria-label="Send"
          >
            <Send />
          </Button>
        </form>
      </div>
    </div>
  );
}
