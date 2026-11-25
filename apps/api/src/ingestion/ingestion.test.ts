import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Permission } from '@s360/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChecks } from './launch.js';
import { applySourceStatus, dispatchAllowed, marketDispatchAllowed, transition } from './lifecycle.js';
import { contentHash, normalize, stableJson } from './normalize.js';
import { FixtureSampTrek, fixtureProjects, FIXTURE_VENDOR_CODE } from './samptrek/fixture.js';
import { LiveSampTrek } from './samptrek/live.js';
import { signSampTrek, verifySampTrek } from './signature.js';

describe('normalize', () => {
  const p = fixtureProjects()[0]!;
  it("keeps only Supply360's own vendor link and drops prices and e-mails", () => {
    const n = normalize(p, FIXTURE_VENDOR_CODE);
    const us = n.markets.find((m) => m.countryCode === 'US')!;
    expect(us.vendorLinkId).toBe('fx-vl-1');
    expect(us.vendorTarget).toBe(400);
    expect(JSON.stringify(n)).not.toMatch(/cpi|revenue|payout|@/i);
    expect(JSON.stringify(n)).not.toContain('Another vendor');
  });
  it('the hash ignores progress counters but sees content changes', () => {
    const a = contentHash(normalize(p, 'S360'));
    const progressed = structuredClone(p);
    progressed.markets[0]!.completes += 50;
    progressed.markets[0]!.vendorLinks[0]!.completes! += 10;
    expect(contentHash(normalize(progressed, 'S360'))).toBe(a);
    const retargeted = structuredClone(p);
    retargeted.markets[0]!.loiMinutes = 15;
    expect(contentHash(normalize(retargeted, 'S360'))).not.toBe(a);
  });
  it('stable JSON does not depend on key order', () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe('lifecycle', () => {
  it('the source always wins', () => {
    expect(applySourceStatus('live', 'HOLD')).toBe('source_hold');
    expect(applySourceStatus('live', 'CLOSED')).toBe('closed');
    expect(applySourceStatus('ready', 'INVOICED')).toBe('closed');
    expect(applySourceStatus('closed', 'LIVE')).toBe('closed');
  });
  it('coming back from a source hold needs a person: it lands on paused, never live', () => {
    expect(applySourceStatus('source_hold', 'LIVE')).toBe('paused');
    expect(applySourceStatus('imported', 'LIVE')).toBe('imported');
  });
  it('dispatch needs live here and LIVE at the source', () => {
    expect(dispatchAllowed({ lifecycle: 'live', sourceStatus: 'LIVE' })).toBe(true);
    expect(dispatchAllowed({ lifecycle: 'live', sourceStatus: 'HOLD' })).toBe(false);
    expect(dispatchAllowed({ lifecycle: 'paused', sourceStatus: 'LIVE' })).toBe(false);
    const p = { lifecycle: 'live' as const, sourceStatus: 'LIVE' };
    expect(marketDispatchAllowed(p, { sourceStatus: 'LIVE', vendorLinkStatus: 'PAUSED', entryUrl: 'x' })).toBe(false);
    expect(marketDispatchAllowed(p, { sourceStatus: 'LIVE', vendorLinkStatus: 'ACTIVE', entryUrl: null })).toBe(false);
    expect(marketDispatchAllowed(p, { sourceStatus: 'LIVE', vendorLinkStatus: 'ACTIVE', entryUrl: 'x' })).toBe(true);
  });
  const all: Permission[] = ['projects.manage', 'execution.approve', 'execution.control'];
  it('enforces from-states, source status, checks and permissions', () => {
    const ok = [{ key: 'x', label: 'X', ok: true }];
    const bad = [{ key: 'x', label: 'Entry link', ok: false }];
    const pending = [{ key: 'q', label: 'Quotas', ok: false, pendingPhase: 3 }];
    expect(transition({ lifecycle: 'imported', sourceStatus: 'LIVE' }, 'launch', all, ok)).toMatchObject({
      ok: false,
      code: 'invalid_transition',
    });
    expect(transition({ lifecycle: 'ready', sourceStatus: 'TEST' }, 'launch', all, ok)).toMatchObject({
      ok: false,
      code: 'source_status',
    });
    expect(transition({ lifecycle: 'imported', sourceStatus: 'LIVE' }, 'mark_ready', all, bad)).toMatchObject({
      ok: false,
      code: 'launch_checks',
    });
    expect(transition({ lifecycle: 'imported', sourceStatus: 'LIVE' }, 'mark_ready', all, pending)).toEqual({
      ok: true,
      to: 'ready',
    });
    expect(transition({ lifecycle: 'ready', sourceStatus: 'LIVE' }, 'launch', ['projects.manage'], ok)).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    expect(transition({ lifecycle: 'live', sourceStatus: 'HOLD' }, 'pause', all, bad)).toEqual({
      ok: true,
      to: 'paused',
    });
    expect(transition({ lifecycle: 'closed', sourceStatus: 'LIVE' }, 'close', all, ok)).toMatchObject({ ok: false });
  });
});

describe('launch checks', () => {
  const m = {
    countryCode: 'US',
    sourceStatus: 'LIVE',
    loiMinutes: 12,
    irPercent: 40,
    targetCompletes: 100,
    vendorLinkId: 'vl',
    vendorLinkStatus: 'ACTIVE',
    vendorTarget: 50,
    entryUrl: null as string | null,
  };
  it('names the markets that are missing an approved entry link', () => {
    const c = launchChecks({ sourceStatus: 'LIVE', fieldEndAt: null }, [
      m,
      { ...m, countryCode: 'GB', entryUrl: 'https://x/[UID]' },
    ]);
    expect(c.find((x) => x.key === 'entry_link')).toMatchObject({ ok: false, detail: 'Missing in US' });
  });
  it('fails when Supply360 is not a vendor anywhere, and lists later-phase checks as pending', () => {
    const c = launchChecks({ sourceStatus: 'LIVE', fieldEndAt: null }, [{ ...m, vendorLinkId: null }]);
    expect(c.find((x) => x.key === 'vendor_link')?.ok).toBe(false);
    expect(c.filter((x) => x.pendingPhase).map((x) => x.key)).toEqual(['quota_map', 'audience']);
  });
  it('fails after the field end date', () => {
    const c = launchChecks({ sourceStatus: 'LIVE', fieldEndAt: new Date('2020-01-01') }, [m]);
    expect(c.find((x) => x.key === 'field_dates')?.ok).toBe(false);
  });
});

describe('webhook signature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","event":"ping","createdAt":"2026-11-25T10:00:00.000Z","data":{}}';
  it('accepts a SampTrek-signed body and rejects any change', () => {
    const h = signSampTrek(secret, body);
    const hdr = { timestamp: h['x-projexa-timestamp'], signature: h['x-projexa-signature'] };
    expect(verifySampTrek(secret, hdr, Buffer.from(body)).ok).toBe(true);
    expect(verifySampTrek(secret, hdr, Buffer.from(body.replace('ping', 'pong')))).toEqual({
      ok: false,
      reason: 'bad signature',
    });
    expect(verifySampTrek('whsec_other', hdr, Buffer.from(body)).ok).toBe(false);
  });
  it('rejects outside the five minute window', () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    const h = signSampTrek(secret, body, old);
    expect(
      verifySampTrek(
        secret,
        { timestamp: h['x-projexa-timestamp'], signature: h['x-projexa-signature'] },
        Buffer.from(body),
      ),
    ).toEqual({
      ok: false,
      reason: 'timestamp outside window',
    });
  });
});

describe('FIXTURE adapter', () => {
  it('pages newest first like SampTrek', async () => {
    const a = new FixtureSampTrek('unit-paging');
    const p1 = await a.listProjects({});
    expect(p1.data).toHaveLength(2);
    const p2 = await a.listProjects({ cursor: p1.nextCursor });
    expect(p2.nextCursor).toBeNull();
    expect([...p1.data, ...p2.data].map((p) => p.projectCode).sort()).toEqual(['PRX10001', 'PRX10002', 'PRX10003']);
  });
});

describe('LIVE adapter against a local stub of the documented SampTrek API', () => {
  let server: Server;
  let base: string;
  const seen: { auth?: string; url?: string }[] = [];
  beforeAll(async () => {
    const [p] = fixtureProjects();
    server = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, url: req.url });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer pjx_${'a'.repeat(32)}`) {
        res.statusCode = 401;
        return res.end('{"message":"bad key"}');
      }
      if (req.url?.startsWith('/api/v1/public/projects?')) {
        const { id, projectCode, name, status, updatedAt } = p!;
        return res.end(
          JSON.stringify({ data: [{ id, projectCode, name, status, updatedAt, extra: 1 }], nextCursor: null }),
        );
      }
      if (req.url === `/api/v1/public/projects/${p!.id}`) return res.end(JSON.stringify(p));
      if (req.url === '/api/v1/public/projects/slow') return void setTimeout(() => res.end('{}'), 500);
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sends the key as a bearer token and parses list and detail', async () => {
    const a = new LiveSampTrek(base, `pjx_${'a'.repeat(32)}`);
    const list = await a.listProjects({ updatedSince: new Date('2026-01-01T00:00:00Z') });
    expect(list.data[0]!.projectCode).toBe('PRX10001');
    expect(seen.at(-1)!.url).toContain('updatedSince=2026-01-01T00%3A00%3A00.000Z');
    expect((await a.getProject('fx-prj-10001'))!.markets).toHaveLength(2);
    expect(await a.getProject('missing')).toBeNull();
  });
  it('reports a rejected key as permanent and a timeout as retryable', async () => {
    await expect(new LiveSampTrek(base, `pjx_${'b'.repeat(32)}`).listProjects({})).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
    await expect(new LiveSampTrek(base, `pjx_${'a'.repeat(32)}`, fetch, 100).getProject('slow')).rejects.toMatchObject({
      retryable: true,
    });
  });
});
