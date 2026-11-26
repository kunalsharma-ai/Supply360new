'use client';
import {
  DROPOUT_KINDS,
  DROPOUT_LABELS,
  MAX_REINVITES,
  OUTCOME_LABELS,
  OUTCOMES,
  type DropoutKind,
} from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ProjectPicker, useProjectParam } from '@/components/audience/project-picker';
import { errMsg } from '@/components/execution/use-batch-actions';
import { PageHeader } from '@/components/page-header';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Empty, ErrorState, Loading } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtN, type ProjectQuotas } from '@/lib/audience';
import { when } from '@/lib/execution';
import { OUTCOME_TONE, RANGES, type Dropout, type Participant } from '@/lib/fieldwork';
import type { ProjectSummary } from '@/lib/ingestion';
import { Table, Td, Th } from './fieldwork-views';

/** Checkbox selection with "everything on this page" and "everyone matching" (the server applies the filter). */
function useSelection() {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  return {
    ids,
    all,
    has: (id: string) => all || ids.has(id),
    toggle: (id: string) => {
      setAll(false);
      setIds((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    },
    setPage: (page: string[], on: boolean) => {
      setAll(false);
      setIds((s) => {
        const n = new Set(s);
        for (const id of page) {
          if (on) n.add(id);
          else n.delete(id);
        }
        return n;
      });
    },
    selectAll: () => setAll(true),
    clear: () => {
      setAll(false);
      setIds(new Set());
    },
  };
}

export function RecontactView() {
  const [tab, setTab] = useState<'recontact' | 'reinvite'>('recontact');
  return (
    <>
      <PageHeader
        title="Recontact and reinvite"
        description="Invite people who took part before into a new project, or invite dropouts again to finish the same survey. Supply360 only handles MADP references; MADP rechecks consent and contact rules before anyone is contacted."
        actions={
          <Button asChild>
            <Link href="/invitations">Back to invitations</Link>
          </Button>
        }
      />
      <div
        role="tablist"
        aria-label="Recontact or reinvite"
        className="mb-4 inline-flex rounded-lg border border-border bg-surface-2 p-1"
      >
        {(
          [
            ['recontact', 'Recontact past participants'],
            ['reinvite', 'Reinvite dropouts'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? 'bg-surface font-medium text-text shadow-sm' : 'text-muted hover:text-text'}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'recontact' ? <Recontact /> : <Reinvite />}
    </>
  );
}

function Recontact() {
  const qc = useQueryClient();
  const canHold = useCan('audience.select');
  const projects = useQuery({
    queryKey: ['projects', '', ''],
    queryFn: () => api<{ items: ProjectSummary[] }>('/projects'),
  });
  const [from, setFrom] = useState('');
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [outcomes, setOutcomes] = useState<string[]>(['complete']);
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [country, setCountry] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const sel = useSelection();

  const filter = useMemo(() => {
    const r = RANGES.find((x) => x.key === range)!;
    const f: Record<string, unknown> = {};
    if (from) f.fromProjectId = from;
    if (r.days > 0) f.participatedFrom = new Date(Date.now() - r.days * 86_400_000).toISOString();
    if (r.days < 0) {
      if (customFrom) f.participatedFrom = new Date(customFrom).toISOString();
      if (customTo) f.participatedTo = new Date(`${customTo}T23:59:59`).toISOString();
    }
    if (outcomes.length) f.outcomes = outcomes;
    if (approvedOnly) f.approvedOnly = true;
    if (country) f.countryCode = country;
    return f;
    // The relative ranges are recomputed when the filter changes, not on every render.
  }, [from, range, customFrom, customTo, outcomes, approvedOnly, country]);
  const qs = new URLSearchParams(
    Object.entries(filter).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
  );
  const q = useQuery({
    queryKey: ['recontact', 'participants', qs.toString(), cursor],
    queryFn: () =>
      api<{ total: number; people: number; items: Participant[]; nextCursor: string | null }>(
        `/recontact/participants?${qs}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
  });

  const [target, setTarget] = useState('');
  const [cellId, setCellId] = useState('');
  const cellsQ = useQuery({
    queryKey: ['quotas', target],
    queryFn: () => api<ProjectQuotas>(`/projects/${target}/quotas`),
    enabled: !!target,
  });
  const cells = cellsQ.data?.cells.filter((c) => !c.removed && c.isOpen && c.criteria && c.inviteCap) ?? [];
  const cell = cells.find((c) => c.id === cellId) ?? cells[0];
  const hold = useMutation({
    mutationFn: () =>
      api<{ held: number; refused: unknown[]; considered: number; skipped: Record<string, number> }>(
        `/projects/${target}/quotas/${cell!.id}/recontact`,
        { method: 'POST', body: sel.all ? { filter } : { invitationIds: [...sel.ids] } },
      ),
    onSuccess: (r) => {
      const skipped = Object.values(r.skipped).reduce((a, b) => a + b, 0);
      toast.success(
        `Held ${r.held} of ${r.considered} people for recontact${r.refused.length ? `, ${r.refused.length} refused by MADP` : ''}${skipped ? `, ${skipped} skipped` : ''}`,
      );
      sel.clear();
      void qc.invalidateQueries({ queryKey: ['quotas'] });
      void qc.invalidateQueries({ queryKey: ['execution'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const count = sel.all ? (q.data?.people ?? 0) : sel.ids.size;
  const page = q.data?.items.map((p) => p.invitationId) ?? [];
  const pageOn = page.length > 0 && page.every((id) => sel.has(id));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Who took part"
          description="When someone took part is their latest outcome, else their start, else when they opened the link."
        />
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="rc-from">Earlier project</Label>
            <Select id="rc-from" value={from} onChange={(e) => (setFrom(e.target.value), setCursor(null), sel.clear())}>
              <option value="">Any project</option>
              {projects.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.projectCode} · {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="rc-range">Took part</Label>
            <Select
              id="rc-range"
              value={range}
              onChange={(e) => (setRange(e.target.value as typeof range), setCursor(null), sel.clear())}
            >
              {RANGES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
          {range === 'custom' && (
            <>
              <div>
                <Label htmlFor="rc-cfrom">From</Label>
                <Input
                  id="rc-cfrom"
                  type="date"
                  value={customFrom}
                  onChange={(e) => (setCustomFrom(e.target.value), sel.clear())}
                />
              </div>
              <div>
                <Label htmlFor="rc-cto">To</Label>
                <Input
                  id="rc-cto"
                  type="date"
                  value={customTo}
                  onChange={(e) => (setCustomTo(e.target.value), sel.clear())}
                />
              </div>
            </>
          )}
          <div>
            <Label htmlFor="rc-country">Market</Label>
            <Input
              id="rc-country"
              value={country}
              maxLength={2}
              placeholder="Any, or e.g. US"
              onChange={(e) => (setCountry(e.target.value.toUpperCase()), setCursor(null), sel.clear())}
            />
          </div>
          <fieldset className="sm:col-span-2 lg:col-span-4">
            <legend className="mb-1.5 text-xs font-medium text-muted">
              Outcome (none ticked means any, including no outcome yet)
            </legend>
            <div className="flex flex-wrap gap-2">
              {OUTCOMES.map((o) => (
                <label
                  key={o}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={outcomes.includes(o)}
                    onChange={(e) => {
                      setOutcomes((s) => (e.target.checked ? [...s, o] : s.filter((x) => x !== o)));
                      setCursor(null);
                      sel.clear();
                    }}
                  />
                  {OUTCOME_LABELS[o]}
                </label>
              ))}
              <label className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={approvedOnly}
                  onChange={(e) => (setApprovedOnly(e.target.checked), sel.clear())}
                />
                Client-approved only
              </label>
            </div>
          </fieldset>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Participants"
          description={q.data ? `${fmtN(q.data.total)} participations by ${fmtN(q.data.people)} people` : undefined}
          action={
            q.data && q.data.people > 0 ? (
              sel.all ? (
                <Button size="sm" onClick={sel.clear}>
                  Clear selection
                </Button>
              ) : (
                <Button size="sm" onClick={sel.selectAll}>
                  Select all {fmtN(q.data.people)} matching
                </Button>
              )
            ) : null
          }
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data ? (
          <Loading />
        ) : !q.data.items.length ? (
          <Empty title="Nobody matches">Try a wider date range or fewer outcomes.</Empty>
        ) : (
          <CardBody>
            <Table
              head={
                <>
                  <Th>
                    <input
                      type="checkbox"
                      aria-label="Select everyone on this page"
                      checked={pageOn}
                      onChange={(e) => sel.setPage(page, e.target.checked)}
                    />
                  </Th>
                  <Th>Person</Th>
                  <Th>Project</Th>
                  <Th>Market</Th>
                  <Th>Outcome</Th>
                  <Th>Took part</Th>
                </>
              }
            >
              {q.data.items.map((p) => (
                <tr key={p.invitationId}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.person}`}
                      checked={sel.has(p.invitationId)}
                      onChange={() => sel.toggle(p.invitationId)}
                    />
                  </Td>
                  <Td mono>{p.person}</Td>
                  <Td>
                    <span className="font-mono text-xs">{p.projectCode}</span>
                  </Td>
                  <Td mono>
                    {p.countryCode} · {p.panel}
                  </Td>
                  <Td>
                    <Badge tone={OUTCOME_TONE(p.outcome)}>{(p.outcome ?? '').replaceAll('_', ' ')}</Badge>
                    {p.approval && <span className="ml-1 text-xs text-muted">{p.approval}</span>}
                  </Td>
                  <Td>
                    <span className="text-xs text-muted">{when(p.participatedAt)}</span>
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="mt-3 flex justify-end gap-2">
              {cursor && (
                <Button size="sm" onClick={() => setCursor(null)}>
                  First page
                </Button>
              )}
              {q.data.nextCursor && (
                <Button size="sm" onClick={() => setCursor(q.data.nextCursor)}>
                  Next page
                </Button>
              )}
            </div>
          </CardBody>
        )}
      </Card>

      {canHold && (
        <Card>
          <CardHeader
            title={`Recontact ${fmtN(count)} ${count === 1 ? 'person' : 'people'}`}
            description="Holds them for a quota cell of the new project through MADP. Only people on the cell's panel and in its market qualify, never anyone already invited to it. They are then invited by that project's mode: you send in manual mode, semi-automatic proposes a batch for approval, automatic sends within its limits."
          />
          <CardBody>
            <form
              className="grid items-end gap-3 sm:grid-cols-[2fr_2fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                hold.mutate();
              }}
            >
              <div>
                <Label htmlFor="rc-target">New project</Label>
                <Select
                  id="rc-target"
                  value={target}
                  onChange={(e) => (setTarget(e.target.value), setCellId(''))}
                  required
                >
                  <option value="">Choose…</option>
                  {projects.data?.items
                    .filter((p) => p.lifecycle !== 'closed' && p.lifecycle !== 'source_hold')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.projectCode} · {p.name}
                      </option>
                    ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="rc-cell">Quota cell</Label>
                <Select
                  id="rc-cell"
                  value={cell?.id ?? ''}
                  onChange={(e) => setCellId(e.target.value)}
                  required
                  disabled={!cells.length}
                >
                  {!cells.length && (
                    <option value="">{target ? 'No mapped, capped cell' : 'Choose a project first'}</option>
                  )}
                  {cells.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.countryCode} · {c.name} ({fmtN(c.held)} of {fmtN(c.inviteCap)} held)
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" variant="primary" disabled={!count || !cell || hold.isPending}>
                Hold for recontact
              </Button>
            </form>
            {target && (
              <p className="mt-3 text-xs text-muted">
                Then send from{' '}
                <Link className="underline" href={`/invitations?project=${target}`}>
                  Invitations
                </Link>
                , or let the project&apos;s mode pick them up.
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Reinvite() {
  const qc = useQueryClient();
  const canSend = useCan('invitations.dispatch');
  const { id, items, list, select } = useProjectParam();
  const [kinds, setKinds] = useState<DropoutKind[]>(['not_started', 'not_finished', 'partial']);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const sel = useSelection();
  const q = useQuery({
    queryKey: ['fieldwork', 'dropouts', id, kinds.join(',')],
    queryFn: () =>
      api<{ counts: Record<DropoutKind, number>; maxReinvites: number; items: Dropout[] }>(
        `/projects/${id}/dropouts?kinds=${kinds.join(',')}`,
      ),
    enabled: !!id && kinds.length > 0,
  });
  const send = useMutation({
    mutationFn: () =>
      api<{ reinvited: number; refused: number; skipped: Record<string, number>; stoppedText: string | null }>(
        `/projects/${id}/reinvite`,
        { method: 'POST', body: sel.all ? { dropouts: kinds, reason } : { invitationIds: [...sel.ids], reason } },
      ),
    onSuccess: (r) => {
      const skipped = Object.entries(r.skipped)
        .map(([k, n]) => `${n} ${k.replaceAll('_', ' ')}`)
        .join(', ');
      if (r.stoppedText) toast.warning(`Stopped: ${r.stoppedText}. ${r.reinvited} reinvited first.`);
      else
        toast.success(
          `Reinvited ${r.reinvited}${r.refused ? `, ${r.refused} refused by MADP` : ''}${skipped ? ` (skipped: ${skipped})` : ''}`,
        );
      setConfirm(false);
      setReason('');
      sel.clear();
      void qc.invalidateQueries({ queryKey: ['fieldwork'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rows = q.data?.items ?? [];
  const eligible = rows.filter((r) => r.canReinvite).map((r) => r.invitationId);
  const total = q.data ? kinds.reduce((a, k) => a + (q.data.counts[k] ?? 0), 0) : 0;
  const count = sel.all ? total : sel.ids.size;
  const pageOn = eligible.length > 0 && eligible.every((x) => sel.has(x));

  return (
    <div className="space-y-4">
      <div>
        {list.isLoading ? (
          <Loading />
        ) : (
          <ProjectPicker id={id} items={items} onSelect={(p) => (select(p), sel.clear())} />
        )}
      </div>
      <Card>
        <CardHeader
          title="Who did not finish"
          description={`People with a final outcome are never reinvited. Each person at most ${MAX_REINVITES} times, a day apart; a reinvite replaces any reminder still waiting.`}
        />
        <CardBody className="flex flex-wrap gap-2">
          {DROPOUT_KINDS.map((k) => (
            <label
              key={k}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm"
            >
              <input
                type="checkbox"
                checked={kinds.includes(k)}
                onChange={(e) => {
                  setKinds((s) => (e.target.checked ? [...s, k] : s.filter((x) => x !== k)));
                  sel.clear();
                }}
              />
              {DROPOUT_LABELS[k]}
              {q.data && <Badge>{fmtN(q.data.counts[k])}</Badge>}
            </label>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Dropouts"
          description={q.data ? `${fmtN(total)} people` : undefined}
          action={
            canSend && (
              <div className="flex gap-2">
                {total > 0 &&
                  (sel.all ? (
                    <Button size="sm" onClick={sel.clear}>
                      Clear selection
                    </Button>
                  ) : (
                    <Button size="sm" onClick={sel.selectAll}>
                      Select all {fmtN(total)} matching
                    </Button>
                  ))}
                <Button size="sm" variant="primary" disabled={!count} onClick={() => setConfirm(true)}>
                  Reinvite {fmtN(count)}
                </Button>
              </div>
            )
          }
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !kinds.length ? (
          <Empty title="Tick at least one kind of dropout" />
        ) : !q.data ? (
          <Loading />
        ) : !rows.length ? (
          <Empty title="No dropouts of these kinds" />
        ) : (
          <CardBody>
            <Table
              head={
                <>
                  <Th>
                    <input
                      type="checkbox"
                      aria-label="Select everyone on this page who can be reinvited"
                      checked={pageOn}
                      onChange={(e) => sel.setPage(eligible, e.target.checked)}
                    />
                  </Th>
                  <Th>Person</Th>
                  <Th>Dropout</Th>
                  <Th>Invited</Th>
                  <Th>Opened</Th>
                  <Th right>Reinvites</Th>
                </>
              }
            >
              {rows.map((r) => (
                <tr key={r.invitationId}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.person}`}
                      disabled={!r.canReinvite}
                      checked={r.canReinvite && sel.has(r.invitationId)}
                      onChange={() => sel.toggle(r.invitationId)}
                    />
                  </Td>
                  <Td mono>
                    {r.countryCode} {r.person}
                  </Td>
                  <Td>{r.dropout ? DROPOUT_LABELS[r.dropout] : '—'}</Td>
                  <Td>
                    <span className="text-xs text-muted">{when(r.sentAt)}</span>
                  </Td>
                  <Td>
                    <span className="text-xs text-muted">{when(r.clickedAt)}</span>
                  </Td>
                  <Td right>
                    {r.reinviteCount} / {MAX_REINVITES}
                    {!r.canReinvite && <span className="block text-xs text-muted">not now</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          </CardBody>
        )}
      </Card>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Reinvite ${fmtN(count)} ${count === 1 ? 'person' : 'people'}`}
        description="They get their same participation link again through MADP. Every send rechecks the emergency stop, the project, quiet hours, the daily maximum and consent first."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <div>
            <Label htmlFor="ri-reason">Reason (kept in the audit log)</Label>
            <Input id="ri-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setConfirm(false)}>
              Back
            </Button>
            <Button type="submit" variant="primary" disabled={send.isPending}>
              Reinvite
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
