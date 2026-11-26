'use client';
import { ExecutionMode, MODE_LABELS, PANEL_LABELS, PanelCode } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, OctagonX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ProjectPicker, useProjectParam } from '@/components/audience/project-picker';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { ESCALATION_TEXT, when, type Overview, type Policy } from '@/lib/execution';
import { BatchesTable } from './batches-table';
import { SendState, useProjectExecution } from './invitations-view';
import { errMsg, useBatchActions } from './use-batch-actions';

const MODE_HELP: Record<ExecutionMode, string> = {
  manual: 'A person creates and sends every batch.',
  semi_auto: 'Supply360 proposes batches at each review; a person with approval rights approves each one.',
  auto: 'Supply360 sends batches on its own within these limits, and stops and asks a person when something looks wrong.',
};

type Form = Omit<Policy, 'escalatedAt' | 'escalationReason' | 'version' | 'lastReviewAt' | 'updatedAt'> & {
  reason: string;
};

/** No example value from the spec is a default: every limit starts empty and a person fills it in. */
const EMPTY = {
  mode: 'manual',
  batchSize: '',
  dailyMax: '',
  reviewIntervalMinutes: '',
  quietStartHour: '',
  quietEndHour: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  reminderOffsetsHours: '',
  allowedPanels: [] as string[],
  linkValidDays: '',
  escalateRefusalPercent: '',
  speederPercent: '',
  reason: '',
};
type Draft = typeof EMPTY;

const fromPolicy = (p: Policy): Draft => ({
  mode: p.mode,
  batchSize: String(p.batchSize),
  dailyMax: String(p.dailyMax),
  reviewIntervalMinutes: String(p.reviewIntervalMinutes),
  quietStartHour: String(p.quietStartHour),
  quietEndHour: String(p.quietEndHour),
  timezone: p.timezone,
  reminderOffsetsHours: p.reminderOffsetsHours.join(', '),
  allowedPanels: p.allowedPanels,
  linkValidDays: String(p.linkValidDays),
  escalateRefusalPercent: String(p.escalateRefusalPercent),
  speederPercent: p.speederPercent == null ? '' : String(p.speederPercent),
  reason: '',
});

const toBody = (d: Draft): Form => ({
  mode: d.mode as ExecutionMode,
  batchSize: Number(d.batchSize),
  dailyMax: Number(d.dailyMax),
  reviewIntervalMinutes: Number(d.reviewIntervalMinutes),
  quietStartHour: Number(d.quietStartHour),
  quietEndHour: Number(d.quietEndHour),
  timezone: d.timezone,
  reminderOffsetsHours: d.reminderOffsetsHours
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number),
  allowedPanels: d.allowedPanels as PanelCode[],
  linkValidDays: Number(d.linkValidDays),
  escalateRefusalPercent: Number(d.escalateRefusalPercent),
  speederPercent: d.speederPercent.trim() ? Number(d.speederPercent) : null,
  reason: d.reason,
});

export function AutomationView() {
  const qc = useQueryClient();
  const canManage = useCan('automation.manage');
  const canApprove = useCan('execution.approve');
  const canStop = useCan('execution.emergency_stop');
  const { id, items, list, select } = useProjectParam();
  const q = useProjectExecution(id);
  const ov = useQuery({ queryKey: ['execution', 'overview'], queryFn: () => api<Overview>('/execution/overview') });
  const { actions, dialog } = useBatchActions();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopReason, setStopReason] = useState('');
  useEffect(() => {
    if (q.data) setDraft(q.data.policy ? fromPolicy(q.data.policy) : EMPTY);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api<{ policy: Policy; cancelledSystemBatches: number }>(`/projects/${id}/execution/policy`, {
        method: 'PUT',
        body: toBody(draft),
      }),
    onSuccess: (r) => {
      toast.success(
        `Policy saved as version ${r.policy.version}${r.cancelledSystemBatches ? `; ${r.cancelledSystemBatches} system batch(es) from the old mode cancelled` : ''}`,
      );
      void qc.invalidateQueries({ queryKey: ['execution'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const halt = useMutation({
    mutationFn: (halted: boolean) =>
      api('/execution/kill-switch', { method: 'PUT', body: { halted, reason: stopReason } }),
    onSuccess: (_, halted) => {
      toast[halted ? 'warning' : 'success'](halted ? 'Emergency stop on: nothing is sent' : 'Sending resumed');
      setStopOpen(false);
      setStopReason('');
      void qc.invalidateQueries({ queryKey: ['execution'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const d = q.data;
  const halted = ov.data?.halted ?? d?.halted ?? false;

  return (
    <>
      <PageHeader
        title="Workflow Automation"
        description="Execution mode and limits per project, the approval queue, and the emergency stop."
        actions={
          canStop && (
            <Button variant={halted ? 'primary' : 'danger'} onClick={() => setStopOpen(true)}>
              <OctagonX /> {halted ? 'Lift emergency stop' : 'Emergency stop'}
            </Button>
          )
        }
      />
      {halted && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
        >
          <OctagonX className="mt-0.5 size-4 shrink-0" /> Emergency stop is on for every project: {ov.data?.haltReason}
        </div>
      )}
      <div className="mb-4">
        {list.isLoading ? <Loading /> : <ProjectPicker id={id} items={items} onSelect={select} />}
      </div>
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !d ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <SendState d={d} />
          {d.policy?.escalatedAt && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Automation stopped on {when(d.policy.escalatedAt)}:{' '}
                {ESCALATION_TEXT[d.policy.escalationReason ?? ''] ?? d.policy.escalationReason}. It proposes nothing
                more until someone reviews the limits below and saves them.
              </span>
            </div>
          )}
          <Card>
            <CardHeader
              title="Mode and limits"
              description={
                d.policy
                  ? `Version ${d.policy.version}, saved ${when(d.policy.updatedAt)}`
                  : 'Not set: nothing can be sent until this is saved.'
              }
            />
            <CardBody>
              <form
                className="space-y-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate();
                }}
              >
                <fieldset className="grid gap-2 sm:grid-cols-3" disabled={!canManage}>
                  <legend className="mb-1.5 text-xs font-medium text-muted">Mode</legend>
                  {ExecutionMode.options.map((m) => (
                    <label key={m} className="flex gap-2 rounded-md border border-border p-3 text-sm">
                      <input
                        type="radio"
                        name="mode"
                        checked={draft.mode === m}
                        disabled={m === 'auto' && !canApprove}
                        onChange={() => setDraft((x) => ({ ...x, mode: m }))}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span>
                        <span className="font-medium">{MODE_LABELS[m]}</span>
                        <span className="mt-0.5 block text-xs text-muted">{MODE_HELP[m]}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <fieldset className="grid gap-3 sm:grid-cols-4" disabled={!canManage}>
                  <Num
                    id="p-batch"
                    label="Batch size"
                    value={draft.batchSize}
                    onChange={set('batchSize')}
                    min={1}
                    max={5000}
                  />
                  <Num id="p-daily" label="Daily maximum" value={draft.dailyMax} onChange={set('dailyMax')} min={1} />
                  <Num
                    id="p-review"
                    label="Review every (minutes)"
                    value={draft.reviewIntervalMinutes}
                    onChange={set('reviewIntervalMinutes')}
                    min={5}
                    max={1440}
                  />
                  <Num
                    id="p-esc"
                    label="Escalate above refusal %"
                    value={draft.escalateRefusalPercent}
                    onChange={set('escalateRefusalPercent')}
                    min={1}
                    max={100}
                  />
                  <Num
                    id="p-qs"
                    label="Quiet hours from (hour)"
                    value={draft.quietStartHour}
                    onChange={set('quietStartHour')}
                    min={0}
                    max={23}
                  />
                  <Num
                    id="p-qe"
                    label="Quiet hours until (hour)"
                    value={draft.quietEndHour}
                    onChange={set('quietEndHour')}
                    min={0}
                    max={23}
                  />
                  <div>
                    <Label htmlFor="p-tz">Time zone</Label>
                    <Input id="p-tz" value={draft.timezone} onChange={set('timezone')} required />
                  </div>
                  <Num
                    id="p-link"
                    label="Link valid (days)"
                    value={draft.linkValidDays}
                    onChange={set('linkValidDays')}
                    min={1}
                    max={60}
                  />
                  <div>
                    <Label htmlFor="p-speed">Flag completes faster than (% of expected LOI, empty for off)</Label>
                    <Input
                      id="p-speed"
                      type="number"
                      min={1}
                      max={100}
                      value={draft.speederPercent}
                      onChange={set('speederPercent')}
                      placeholder="Off"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="p-rem">
                      Reminders, hours after the invitation (comma separated, empty for none)
                    </Label>
                    <Input
                      id="p-rem"
                      value={draft.reminderOffsetsHours}
                      onChange={set('reminderOffsetsHours')}
                      placeholder="e.g. 24, 72"
                    />
                  </div>
                  <fieldset className="sm:col-span-2">
                    <legend className="mb-1.5 text-xs font-medium text-muted">Panels allowed</legend>
                    <div className="flex flex-wrap gap-2">
                      {PanelCode.options.map((pc) => (
                        <label
                          key={pc}
                          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={draft.allowedPanels.includes(pc)}
                            onChange={(e) =>
                              setDraft((x) => ({
                                ...x,
                                allowedPanels: e.target.checked
                                  ? [...x.allowedPanels, pc]
                                  : x.allowedPanels.filter((y) => y !== pc),
                              }))
                            }
                            className="accent-[var(--accent)]"
                          />
                          {PANEL_LABELS[pc]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </fieldset>
                {canManage && (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-64 flex-1">
                      <Label htmlFor="p-reason">Reason for this change</Label>
                      <Input id="p-reason" value={draft.reason} onChange={set('reason')} minLength={3} required />
                    </div>
                    <Button type="submit" variant="primary" disabled={save.isPending}>
                      Save policy
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted">
                  Changing the mode cancels batches the system proposed under the old mode. Invitations already sent,
                  reminders and history stay as they are.
                </p>
              </form>
            </CardBody>
          </Card>
        </div>
      )}
      <Card className="mt-4">
        <CardHeader
          title="Waiting for approval"
          description="Batches proposed in semi-automatic mode, or by people without approval rights, across all projects."
        />
        {ov.isLoading ? (
          <Loading />
        ) : ov.data?.approvals.length ? (
          <CardBody>
            <BatchesTable rows={ov.data.approvals} showProject actions={actions} />
          </CardBody>
        ) : (
          <Empty title="Nothing waits for approval" />
        )}
      </Card>
      {dialog}
      <Dialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title={halted ? 'Lift the emergency stop' : 'Emergency stop'}
        description={
          halted
            ? 'Approved batches and due reminders go again, each after its own checks.'
            : 'Stops every invitation and reminder in every project at once, in every mode, until lifted.'
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            halt.mutate(!halted);
          }}
        >
          <div>
            <Label htmlFor="stop-reason">Reason (kept in the audit log)</Label>
            <Input
              id="stop-reason"
              value={stopReason}
              onChange={(e) => setStopReason(e.target.value)}
              minLength={3}
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setStopOpen(false)}>
              Back
            </Button>
            <Button type="submit" variant={halted ? 'primary' : 'danger'} disabled={halt.isPending}>
              {halted ? 'Lift the stop' : 'Stop all sending'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function Num(p: {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <Label htmlFor={p.id}>{p.label}</Label>
      <Input id={p.id} type="number" value={p.value} onChange={p.onChange} min={p.min} max={p.max} required />
    </div>
  );
}
