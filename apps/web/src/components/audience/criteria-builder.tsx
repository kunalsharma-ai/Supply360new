'use client';
import { AudienceCategory, CATEGORY_LABELS, PANEL_LABELS, PanelCode, type AudienceCriteria } from '@s360/contracts';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import type { Attribute } from '@/lib/audience';
import { cn } from '@/lib/cn';

const chip = (on: boolean) =>
  cn(
    'rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-text',
    on && 'border-accent/50 bg-accent/10 text-text',
  );

/**
 * Builds MADP criteria. MADP matches AND across attribute filters and OR within one filter's values; it has no
 * nested groups yet, so neither does this builder.
 */
export function CriteriaBuilder({
  value,
  onChange,
  attributes,
  singlePanel = false,
  showCountries = true,
}: {
  value: AudienceCriteria;
  onChange: (c: AudienceCriteria) => void;
  attributes: Attribute[];
  /** Quota mappings need exactly one panel. */
  singlePanel?: boolean;
  showCountries?: boolean;
}) {
  const [countryText, setCountryText] = useState((value.countries ?? []).join(', '));
  const set = (patch: Partial<AudienceCriteria>) => {
    const next = { ...value, ...patch };
    for (const k of Object.keys(next) as (keyof AudienceCriteria)[]) {
      const v = next[k];
      if (v === undefined || (Array.isArray(v) && !v.length) || v === false) delete next[k];
    }
    onChange(next);
  };
  const toggle = <T extends string>(list: T[] | undefined, x: T) =>
    list?.includes(x) ? list.filter((y) => y !== x) : [...(list ?? []), x];
  const filters = value.attributes ?? [];
  const unused = attributes.filter((a) => !filters.some((f) => f.key === a.key));

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted">
          Panel{singlePanel ? ' (exactly one: MADP gives one reference per panel membership)' : 's'}
        </legend>
        <div className="flex flex-wrap gap-1">
          {PanelCode.options.map((p) => (
            <button
              type="button"
              key={p}
              aria-pressed={!!value.panels?.includes(p)}
              className={chip(!!value.panels?.includes(p))}
              onClick={() => set({ panels: singlePanel ? [p] : toggle(value.panels, p) })}
            >
              {PANEL_LABELS[p]}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted">Audience categories (any of)</legend>
        <div className="flex flex-wrap gap-1">
          {AudienceCategory.options.map((c) => (
            <button
              type="button"
              key={c}
              aria-pressed={!!value.categories?.includes(c)}
              className={chip(!!value.categories?.includes(c))}
              onClick={() => set({ categories: toggle(value.categories, c) })}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </fieldset>
      {showCountries && (
        <div>
          <Label htmlFor="cb-countries">Countries (ISO codes, comma separated)</Label>
          <Input
            id="cb-countries"
            placeholder="US, GB"
            value={countryText}
            onChange={(e) => {
              setCountryText(e.target.value);
              const cs = e.target.value
                .toUpperCase()
                .split(/[\s,]+/)
                .filter((x) => /^[A-Z]{2}$/.test(x));
              set({ countries: [...new Set(cs)] });
            }}
          />
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!value.verifiedEmailOnly}
          onChange={(e) => set({ verifiedEmailOnly: e.target.checked })}
        />
        Verified e-mail only
      </label>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted">Attributes (all must match; any value within one)</p>
        {filters.map((f, i) => {
          const a = attributes.find((x) => x.key === f.key);
          return (
            <div key={f.key} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{a?.label ?? f.key}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${a?.label ?? f.key}`}
                  onClick={() => set({ attributes: filters.filter((_, j) => j !== i) })}
                >
                  <X />
                </Button>
              </div>
              {a?.values?.length ? (
                <div className="flex flex-wrap gap-1">
                  {a.values.map((v) => (
                    <button
                      type="button"
                      key={v}
                      aria-pressed={f.values.includes(v)}
                      className={chip(f.values.includes(v))}
                      onClick={() => {
                        const values = toggle(f.values, v);
                        set({
                          attributes: values.length
                            ? filters.map((x, j) => (j === i ? { ...x, values } : x))
                            : filters.filter((_, j) => j !== i),
                        });
                      }}
                    >
                      {v.replaceAll('_', ' ')}
                    </button>
                  ))}
                </div>
              ) : (
                <Input
                  aria-label={`Values for ${a?.label ?? f.key}`}
                  placeholder="Canonical values, comma separated"
                  defaultValue={f.values.join(', ')}
                  onBlur={(e) => {
                    const values = e.target.value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean);
                    set({
                      attributes: filters.map((x, j) =>
                        j === i ? { ...x, values: values.length ? values : x.values } : x,
                      ),
                    });
                  }}
                />
              )}
            </div>
          );
        })}
        {unused.length > 0 && filters.length < 10 && (
          <div className="flex items-center gap-2">
            <Select
              aria-label="Add an attribute"
              value=""
              onChange={(e) => {
                const a = attributes.find((x) => x.key === e.target.value);
                if (a)
                  set({
                    attributes: [...filters, { key: a.key, values: a.values?.length ? [a.values[0]!] : ['value'] }],
                  });
              }}
            >
              <option value="">Add an attribute…</option>
              {unused.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </Select>
            <Plus className="size-4 text-muted" aria-hidden />
          </div>
        )}
      </div>
    </div>
  );
}
