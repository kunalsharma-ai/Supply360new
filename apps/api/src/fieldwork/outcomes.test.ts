import { describe, expect, it } from 'vitest';
import { derive, incidence, isSpeeder, kindOf, loiStats, signCallback, verifyCallback } from './outcomes.js';

const blank = { startedAt: null, outcome: null, outcomeSource: null, approval: null };
const t = new Date('2026-11-26T10:00:00Z');

describe('derive', () => {
  it('maps SampTrek statuses in either case, and nothing else', () => {
    expect(kindOf('COMPLETE')).toBe('complete');
    expect(kindOf('quota_full')).toBe('quota_full');
    expect(kindOf('STARTED')).toBe('started');
    expect(kindOf('ABANDONED')).toBeNull();
  });
  it('an outcome never invents a start', () => {
    expect(derive(blank, 'complete', 'samptrek_callback', t).patch.startedAt).toBeUndefined();
  });
  it('the first final outcome sticks; a partial gives way', () => {
    const done = { ...blank, outcome: 'complete', outcomeSource: 'samptrek_callback' };
    expect(derive(done, 'complete', 'samptrek_callback', t).effect).toBe('ignored:same_outcome');
    expect(derive(done, 'partial', 'samptrek_callback', t).effect).toBe('ignored:already_final');
    const partial = { ...blank, outcome: 'partial' };
    expect(derive(partial, 'terminate', 'samptrek_callback', t)).toMatchObject({
      effect: 'applied',
      patch: { outcome: 'terminate' },
    });
  });
  it('a disagreeing callback flags only; the sessions API overrides and flags', () => {
    const done = { ...blank, outcome: 'complete', outcomeSource: 'samptrek_callback', approval: 'approved' };
    const cb = derive(done, 'terminate', 'samptrek_callback', t);
    expect(cb).toMatchObject({ effect: 'conflict', patch: {}, flag: { kind: 'conflicting_outcome' } });
    const st = derive(done, 'terminate', 'samptrek_sessions', t);
    expect(st.patch).toMatchObject({ outcome: 'terminate', approval: null, outcomeReportedAt: null });
  });
  it('a client decision applies only to a complete', () => {
    expect(derive({ ...blank, outcome: 'terminate' }, 'client_approved', 'samptrek_sessions', t).flag?.kind).toBe(
      'approval_without_complete',
    );
    expect(derive({ ...blank, outcome: 'complete' }, 'client_rejected', 'samptrek_sessions', t).patch.approval).toBe(
      'rejected',
    );
  });
});

describe('S2S signature', () => {
  const url = 'https://s360.example/api/v1/s2s/samptrek/acme/x?uid=a&status=complete';
  it('verifies what SampTrek signs: {ts}.{url}.{body}', () => {
    const h = signCallback('secret-0123456789', url);
    const ok = verifyCallback(
      'secret-0123456789',
      { timestamp: h['x-projexa-timestamp'], signature: h['x-projexa-signature'] },
      url,
      '',
    );
    expect(ok.ok).toBe(true);
  });
  it('rejects another URL, an old timestamp and a missing signature', () => {
    const h = signCallback('secret-0123456789', url);
    const hd = { timestamp: h['x-projexa-timestamp'], signature: h['x-projexa-signature'] };
    expect(verifyCallback('secret-0123456789', hd, url.replace('complete', 'terminate'), '').ok).toBe(false);
    expect(verifyCallback('secret-0123456789', hd, url, '', Date.now() + 301_000)).toMatchObject({
      reason: 'timestamp outside window',
    });
    expect(verifyCallback('secret-0123456789', { timestamp: hd.timestamp }, url, '').ok).toBe(false);
  });
});

describe('stats', () => {
  it('incidence and speeders', () => {
    expect(incidence(3, 2)).toBe(60);
    expect(incidence(0, 0)).toBeNull();
    expect(isSpeeder(120, 12, 40)).toBe(true);
    expect(isSpeeder(300, 12, 40)).toBe(false);
  });
  it('LOI quartiles and histogram', () => {
    const s = loiStats([300, 600, 720, 900, 1200]);
    expect(s).toMatchObject({ n: 5, median: 12 });
    expect(s.histogram.reduce((a, b) => a + b.n, 0)).toBe(5);
    expect(loiStats([]).median).toBeNull();
  });
});
