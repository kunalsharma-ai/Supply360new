'use client';
import { CATEGORY_LABELS, PANEL_LABELS, type AudienceCategory, type PanelCode } from '@s360/contracts';
import { Badge } from '@/components/ui/badge';
import { fmtN, type Counts } from '@/lib/audience';
import { fmtTime } from '@/lib/ingestion';

function Breakdown({ title, rows, label }: { title: string; rows: Counts['byPanel']; label: (k: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-muted">{title}</h3>
      {!rows.length ? (
        <p className="text-sm text-muted">Nobody</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-2 text-sm">
              <span className="truncate">{label(r.key)}</span>
              <span className="h-2 rounded bg-surface-3" aria-hidden>
                <span className="block h-2 rounded bg-accent" style={{ width: `${((r.value ?? 0) / max) * 100}%` }} />
              </span>
              <span className="text-right tabular-nums">
                {r.suppressed ? <span className="text-muted">hidden</span> : fmtN(r.value)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Unique people is the number to plan with. Memberships count a person once per panel, so they are larger. */
export function CountsView({ counts }: { counts: Counts }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <p className="text-xs text-muted">Unique people</p>
          <p className="text-3xl font-semibold tabular-nums" data-testid="unique-people">
            {fmtN(counts.uniquePeople)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Panel memberships</p>
          <p className="text-lg tabular-nums text-muted">{fmtN(counts.panelMemberships)}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {counts.dataMode === 'demo' ? <Badge tone="demo">DEMO population</Badge> : <Badge tone="accent">LIVE</Badge>}
          <span className="text-xs text-muted">
            Cells under {counts.minimumCellSize} are hidden · synced {fmtTime(counts.freshestSourceSyncAt)}
          </span>
        </div>
      </div>
      {counts.panelMemberships > counts.uniquePeople && (
        <p className="text-xs text-muted">
          {fmtN(counts.panelMemberships - counts.uniquePeople)} memberships belong to people who are in more than one
          panel. They are counted once in unique people; the panel split below counts them in each panel.
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-3">
        <Breakdown title="By panel (people)" rows={counts.byPanel} label={(k) => PANEL_LABELS[k as PanelCode] ?? k} />
        <Breakdown title="By country (people)" rows={counts.byCountry.slice(0, 10)} label={(k) => k} />
        <Breakdown
          title="By category (people)"
          rows={counts.byCategory}
          label={(k) => CATEGORY_LABELS[k as AudienceCategory] ?? k}
        />
      </div>
    </div>
  );
}
