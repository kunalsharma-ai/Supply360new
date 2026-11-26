import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSUMPTIONS,
  forecast,
  MIN_SAMPLE,
  recommendBatch,
  underperforming,
  wilson,
  type ForecastInput,
} from './forecast.js';

const base: ForecastInput = {
  counts: {
    sent: 1000,
    started: 200,
    complete: 60,
    terminate: 60,
    quota_full: 10,
    quality_fail: 6,
    approved: 40,
    rejected: 5,
  },
  matured: { sent: 1000, started: 200 },
  target: 200,
  daysLeft: 10,
  recentCompletes: 30,
  heldNotInvited: 2000,
  briefIrPercent: 30,
  assumptions: DEFAULT_ASSUMPTIONS,
};

describe('wilson', () => {
  it('brackets the observed rate', () => {
    const w = wilson(20, 100);
    expect(w.low).toBeLessThan(0.2);
    expect(w.high).toBeGreaterThan(0.2);
  });
  it('is the whole range with no data', () => expect(wilson(0, 0)).toEqual({ low: 0, high: 1 }));
});

describe('forecast', () => {
  it('uses the three observed rates once each', () => {
    const f = forecast(base);
    expect(f.rates.start.value).toBeCloseTo(0.2);
    expect(f.rates.qualification.value).toBeCloseTo(66 / 126);
    expect(f.rates.qualifiedToComplete.value).toBeCloseTo(60 / 66);
    expect(f.completesPerInvite.value).toBeCloseTo(0.2 * (66 / 126) * (60 / 66));
    expect(f.assumptionsUsed).toEqual([]);
    expect(f.invitationsNeeded!.value).toBe(Math.ceil(140 / f.completesPerInvite.value));
    expect(f.invitationsNeeded!.low).toBeLessThan(f.invitationsNeeded!.value);
    expect(f.invitationsNeeded!.high).toBeGreaterThan(f.invitationsNeeded!.value);
  });
  it('keeps provisional and approved remaining apart', () => {
    expect(forecast(base).remaining).toEqual({ provisional: 140, approved: 160 });
  });
  it('falls back to labelled values on a cold start, the brief IR first', () => {
    const f = forecast({
      ...base,
      counts: { ...base.counts, complete: 0, terminate: 0, quality_fail: 0 },
      matured: { sent: 10, started: 1 },
    });
    expect(f.rates.start.basis).toBe('assumption');
    expect(f.rates.qualification.basis).toBe('source_brief');
    expect(f.rates.qualification.value).toBeCloseTo(0.3);
    expect(f.rates.qualifiedToComplete.basis).toBe('assumption');
    expect(f.assumptionsUsed).toHaveLength(3);
    expect(f.risk).toBe('not_enough_data');
  });
  it('never treats a sample below the minimum as data', () => {
    const f = forecast({ ...base, matured: { sent: MIN_SAMPLE.sent - 1, started: 99 } });
    expect(f.rates.start.basis).toBe('assumption');
  });
  it('rates the deadline risk from the needed pace', () => {
    // 140 left over 10 days is 14 a day needed.
    expect(forecast({ ...base, recentCompletes: 45 }).risk).toBe('on_track'); // 15 a day
    expect(forecast(base).risk).toBe('at_risk'); // 10 a day, at least 70% of the need
    expect(forecast({ ...base, recentCompletes: 15 }).risk).toBe('off_track'); // 5 a day
    expect(forecast({ ...base, target: 60 }).risk).toBe('reached');
    expect(forecast({ ...base, daysLeft: null }).risk).toBe('no_deadline');
  });
  it('reports the shortfall against people held', () => {
    const f = forecast({ ...base, heldNotInvited: 100 });
    expect(f.shortfall).toBe(f.invitationsNeeded!.value - 100);
  });
});

describe('recommendBatch', () => {
  it('sizes one day of need inside every limit and says which one capped it', () => {
    const f = forecast(base);
    const r = recommendBatch(f, { batchSize: 50, dailyMaxLeft: 1000 });
    expect(r.size).toBe(50);
    expect(r.why).toContain('batch size limit (50)');
    const free = recommendBatch(f, { batchSize: 10_000, dailyMaxLeft: 10_000 });
    expect(free.size).toBe(Math.ceil(14 / f.completesPerInvite.value));
  });
  it('recommends nothing once the target is reached', () => {
    expect(recommendBatch(forecast({ ...base, target: 50 }), { batchSize: 100, dailyMaxLeft: 100 }).size).toBe(0);
  });
});

describe('underperforming', () => {
  const cells = [
    { id: 'a', name: 'Female', countryCode: 'GB', target: 100, complete: 10, terminate: 30, isOpen: true },
    { id: 'b', name: 'Male', countryCode: 'GB', target: 100, complete: 45, terminate: 30, isOpen: true },
    { id: 'c', name: 'Closed', countryCode: 'GB', target: 100, complete: 0, terminate: 0, isOpen: false },
  ];
  it('lists open cells more than 20 points behind the field time used', () => {
    const u = underperforming(cells, 0.5);
    expect(u.map((c) => c.id)).toEqual(['a']);
    expect(u[0]).toMatchObject({ progress: 10, expected: 50, incidence: 25 });
  });
  it('says nothing without field dates', () => expect(underperforming(cells, null)).toEqual([]));
});
