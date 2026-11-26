'use client';
import { SETUP_PART_LABELS, SETUP_PARTS, type SetupPart } from '@s360/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';

const errMsg = (e: unknown) => (e instanceof ApiError ? (e.problem.detail ?? e.message) : 'Request failed');

interface Template {
  id: string;
  name: string;
  description: string | null;
  sourceProjectCode: string | null;
  mode: string | null;
  mappedCells: number;
  cells: number;
}
interface Preview {
  from: string;
  changes: { part: SetupPart; text: string }[];
  skipped: { part: SetupPart; cell: string | null; reason: string }[];
  missingPermissions?: string[];
}
interface ProjectRow {
  id: string;
  projectCode: string;
  name: string;
}

/** Copy another project's Supply360 setup, or a saved template, onto this project. Shows exactly what will change. */
export function CopySetupDialog({
  open,
  onOpenChange,
  projectId,
  projectCode,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  projectCode: string;
}) {
  const qc = useQueryClient();
  const canManage = useCan('projects.manage');
  const [source, setSource] = useState('');
  const [parts, setParts] = useState<SetupPart[]>([...SETUP_PARTS]);
  const [reason, setReason] = useState('');
  const templates = useQuery({
    queryKey: ['setup-templates'],
    queryFn: () => api<Template[]>('/setup-templates'),
    enabled: open,
  });
  const projects = useQuery({
    queryKey: ['projects', 'all-for-copy'],
    queryFn: () => api<{ items: ProjectRow[] }>('/projects'),
    enabled: open,
  });
  const body = source
    ? { source: source.startsWith('t:') ? { templateId: source.slice(2) } : { projectId: source.slice(2) }, parts }
    : null;
  const preview = useQuery({
    queryKey: ['setup-preview', projectId, body],
    queryFn: () => api<Preview>(`/projects/${projectId}/setup/preview`, { method: 'POST', body }),
    enabled: open && !!body && parts.length > 0,
  });
  const apply = useMutation({
    mutationFn: () => api<Preview>(`/projects/${projectId}/setup/apply`, { method: 'POST', body: { ...body, reason } }),
    onSuccess: (r) => {
      toast.success(`Setup copied from ${r.from}`);
      void qc.invalidateQueries();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/setup-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Template removed');
      setSource('');
      void qc.invalidateQueries({ queryKey: ['setup-templates'] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  useEffect(() => {
    if (!open) {
      setSource('');
      setReason('');
      setParts([...SETUP_PARTS]);
    }
  }, [open]);

  const missing = preview.data?.missingPermissions ?? [];
  const chosenTemplate = source.startsWith('t:') ? templates.data?.find((t) => t.id === source.slice(2)) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Copy setup to ${projectCode}`}
      description="Take the sending policy, reminders, allocation, cell criteria and caps from another project or a saved template. You see every change before anything is saved."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          apply.mutate();
        }}
      >
        <div>
          <Label htmlFor="setup-source">Copy from</Label>
          <div className="flex gap-2">
            <Select id="setup-source" value={source} onChange={(e) => setSource(e.target.value)} required>
              <option value="">Choose a template or project…</option>
              {!!templates.data?.length && (
                <optgroup label="Saved templates">
                  {templates.data.map((t) => (
                    <option key={t.id} value={`t:${t.id}`}>
                      {t.name}
                      {t.sourceProjectCode ? ` (from ${t.sourceProjectCode})` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Projects">
                {projects.data?.items
                  .filter((p) => p.id !== projectId)
                  .map((p) => (
                    <option key={p.id} value={`p:${p.id}`}>
                      {p.projectCode} · {p.name}
                    </option>
                  ))}
              </optgroup>
            </Select>
            {chosenTemplate && canManage && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove template ${chosenTemplate.name}`}
                title="Remove this template"
                onClick={() => remove.mutate(chosenTemplate.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
          {chosenTemplate?.description && <p className="mt-1 text-xs text-muted">{chosenTemplate.description}</p>}
        </div>

        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-muted">What to copy</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {SETUP_PARTS.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={parts.includes(p)}
                  onChange={(e) => setParts((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))}
                />
                {SETUP_PART_LABELS[p]}
              </label>
            ))}
          </div>
        </fieldset>

        {body && parts.length > 0 && (
          <div data-testid="setup-preview" className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
            {preview.isLoading ? (
              <p className="text-muted">Working out what will change…</p>
            ) : preview.error ? (
              <p className="text-danger">{errMsg(preview.error)}</p>
            ) : (
              preview.data && (
                <>
                  <p className="mb-2 text-xs font-medium text-muted">What will change</p>
                  <ul className="space-y-1">
                    {preview.data.changes.map((c, i) => (
                      <li key={i} className="flex gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" />
                        <span>
                          <span className="font-medium">{SETUP_PART_LABELS[c.part]}:</span> {c.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!!preview.data.skipped.length && (
                    <>
                      <p className="mt-3 mb-1 text-xs font-medium text-muted">Left as it is</p>
                      <ul className="space-y-1 text-muted">
                        {preview.data.skipped.map((s, i) => (
                          <li key={i} className="flex gap-2">
                            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                            <span>
                              {s.cell ? `${s.cell}: ` : `${SETUP_PART_LABELS[s.part]}: `}
                              {s.reason}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {!!missing.length && (
                    <p className="mt-3 text-danger">
                      Your role cannot set some of these parts by hand ({missing.join(', ')}). Untick them or ask
                      someone who can.
                    </p>
                  )}
                </>
              )
            )}
          </div>
        )}

        <div>
          <Label htmlFor="setup-reason">Reason</Label>
          <Input
            id="setup-reason"
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Wave 2 runs like wave 1"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!body || !parts.length || !!missing.length || apply.isPending || !preview.data}
          >
            Copy setup
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Save this project's setup under a name, to apply to later projects in a click. */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
}) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (b: { name: string; description?: string }) =>
      api('/setup-templates', { method: 'POST', body: { ...b, fromProjectId: projectId } }),
    onSuccess: () => {
      toast.success('Template saved');
      void qc.invalidateQueries({ queryKey: ['setup-templates'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save setup as a template"
      description="Saves the sending policy, reminders, allocation mode, cell criteria and caps. No people or references are saved."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const description = String(f.get('description') ?? '').trim();
          save.mutate({ name: String(f.get('name')), ...(description ? { description } : {}) });
        }}
      >
        <div>
          <Label htmlFor="tpl-name">Template name</Label>
          <Input
            id="tpl-name"
            name="name"
            required
            minLength={2}
            maxLength={80}
            autoFocus
            placeholder="e.g. US gender split, Turn2Opinion"
          />
        </div>
        <div>
          <Label htmlFor="tpl-desc">Description (optional)</Label>
          <Input id="tpl-desc" name="description" maxLength={300} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Badge>Criteria and numbers only</Badge>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Save template
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
