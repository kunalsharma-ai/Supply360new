import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureMadp, fixturePopulation } from './madp/fixture.js';
import { LiveMadp } from './madp/live.js';
import { AudienceError } from './madp/source.js';
import { allocate, audienceChecks, split, suggestedCap, type CellState } from './quotas.js';

/** MADP's own verifier (madp apps/api/src/supply360/signature.ts), copied so a drift in Supply360's signer fails here. */
function madpVerify(o: {
  secret: string;
  header?: string;
  ts?: string;
  nonce?: string;
  method: string;
  path: string;
  raw: Buffer;
}) {
  if (!o.ts || !/^\d{9,11}$/.test(o.ts)) return 'missing_timestamp';
  if (Math.abs(Date.now() / 1000 - Number(o.ts)) > 300) return 'stale_timestamp';
  if (!o.nonce || !/^[A-Za-z0-9_-]{8,64}$/.test(o.nonce)) return 'bad_nonce';
  if (!o.header || !/^v1=[0-9a-f]{64}$/.test(o.header)) return 'bad_signature_format';
  const h = createHash('sha256').update(o.raw).digest('hex');
  const want = createHmac('sha256', o.secret).update(`${o.ts}.${o.nonce}.${o.method}.${o.path}.${h}`).digest();
  const got = Buffer.from(o.header.slice(3), 'hex');
  return got.length === want.length && timingSafeEqual(got, want) ? 'ok' : 'bad_signature';
}

describe('FIXTURE MADP (gate: overlap is counted once)', () => {
  const madp = new FixtureMadp('unit');
  it('counts a person in two panels once in uniquePeople and twice in memberships', async () => {
    const c = await madp.counts({});
    const people = fixturePopulation();
    expect(c.uniquePeople).toBe(people.length);
    expect(c.panelMemberships).toBe(people.reduce((a, p) => a + p.memberships.length, 0));
    expect(c.panelMemberships).toBeGreaterThan(c.uniquePeople);
    // Adding up the panel split would count people twice: that is why Supply360 only plans with uniquePeople.
    const summed = c.byPanel.reduce((a, b) => a + (b.value ?? 0), 0);
    expect(summed).toBeGreaterThan(c.uniquePeople);
    expect(c.dataMode).toBe('demo');
  });
  it('ANDs attribute filters and ORs values within one, like MADP', async () => {
    const f = await madp.counts({
      countries: ['US'],
      attributes: [{ key: 'demographics.gender', values: ['female'] }],
    });
    const m = await madp.counts({ countries: ['US'], attributes: [{ key: 'demographics.gender', values: ['male'] }] });
    const both = await madp.counts({
      countries: ['US'],
      attributes: [{ key: 'demographics.gender', values: ['female', 'male'] }],
    });
    expect(both.uniquePeople).toBe(f.uniquePeople + m.uniquePeople);
    const narrower = await madp.counts({
      countries: ['US'],
      attributes: [
        { key: 'demographics.gender', values: ['female'] },
        { key: 'location.urbanicity', values: ['rural'] },
      ],
    });
    expect(narrower.uniquePeople).toBeLessThan(f.uniquePeople);
  });
  it('suppresses small cells', async () => {
    const c = await madp.counts({ countries: ['AU'], attributes: [{ key: 'b2b.job_role', values: ['c_suite'] }] });
    for (const x of [...c.byPanel, ...c.byCountry]) if (x.suppressed) expect(x.value).toBeNull();
  });
  it('matches in a stable order per project and excludes people held by another project', async () => {
    const q = { panels: ['t2o' as const], countries: ['GB'], limit: 50 };
    const a = await madp.match({ ...q, projectRef: 's360:a' });
    const again = await madp.match({ ...q, projectRef: 's360:a' });
    expect(again.members.map((m) => m.ref)).toEqual(a.members.map((m) => m.ref));
    expect(a.excluded.opted_out).toBeGreaterThan(0);
    await madp.reserve(
      {
        projectRef: 's360:a',
        refs: a.members.slice(0, 10).map((m) => m.ref),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      'k1-unit-test',
    );
    const b = await madp.match({ ...q, projectRef: 's360:b', limit: 5000 });
    const held = new Set(a.members.slice(0, 10).map((m) => m.ref));
    expect(b.members.some((m) => held.has(m.ref))).toBe(false);
    expect(b.excluded.reserved_elsewhere).toBe(10);
  });
  it('replays a reservation for the same idempotency key', async () => {
    const m = await madp.match({ countries: ['DE'], panels: ['mfr'], projectRef: 's360:c', limit: 5 });
    const body = {
      projectRef: 's360:c',
      refs: m.members.map((x) => x.ref),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const r1 = await madp.reserve(body, 'same-key-123');
    const r2 = await madp.reserve(body, 'same-key-123');
    expect(r2.reservationId).toBe(r1.reservationId);
  });
});

describe('allocation', () => {
  it('splits by largest remainder so the parts add up', () => {
    expect(split(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(split(7, [0, 0])).toEqual([4, 3]);
    expect(split(400, [400, 400])).toEqual([200, 200]);
  });
  it('splits each SampTrek group of a market on its own', () => {
    const cells = [
      { id: 'f', countryCode: 'US', groupName: 'Gender', sourceTarget: 300, isOpen: true, removed: false },
      { id: 'm', countryCode: 'US', groupName: 'Gender', sourceTarget: 100, isOpen: true, removed: false },
      { id: 'y', countryCode: 'US', groupName: 'Age', sourceTarget: 1, isOpen: true, removed: false },
      { id: 'x', countryCode: 'US', groupName: 'Age', sourceTarget: 1, isOpen: false, removed: false },
    ];
    const t = allocate('proportional', cells, () => 200);
    expect(Object.fromEntries(t)).toEqual({ f: 150, m: 50, y: 200, x: 0 });
    expect(Object.fromEntries(allocate('equal', cells, () => 200))).toMatchObject({ f: 100, m: 100 });
    expect(Object.fromEntries(allocate('manual', cells, () => 200, { f: 7 }))).toMatchObject({ f: 7, m: 0 });
  });
  it('suggests a cap from incidence', () => expect(suggestedCap(100, 50)).toBe(600));
});

describe('launch checks for audience', () => {
  const base = {
    id: 'c1',
    countryCode: 'US',
    sourceCellId: '_market',
    name: 'Whole market',
    removed: false,
    isOpen: true,
    criteria: null,
    inviteCap: null,
    held: 0,
  } as unknown as CellState;
  const markets = [{ countryCode: 'US', vendorLinkId: 'vl' }];
  it('fails until every cell is mapped, capped and holding people', () => {
    let [map, aud] = audienceChecks(markets, [base]);
    expect(map).toMatchObject({ ok: false, detail: 'Not mapped: US', stage: 'launch' });
    [map, aud] = audienceChecks(markets, [{ ...base, criteria: { panels: ['t2o'] }, inviteCap: 10 } as CellState]);
    expect(map!.ok).toBe(true);
    expect(aud).toMatchObject({ ok: false, detail: 'Nothing held for: US' });
    [, aud] = audienceChecks(markets, [
      { ...base, criteria: { panels: ['t2o'] }, inviteCap: 10, held: 3 } as CellState,
    ]);
    expect(aud!.ok).toBe(true);
  });
  it('says so when no cells were imported for a market', () => {
    expect(audienceChecks(markets, [])[0]).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not imported'),
    });
  });
});

describe('LIVE MADP client against a stub that verifies like MADP', () => {
  let server: Server;
  let base: string;
  const secret = 'madp-test-secret-0123456789abcdef';
  const nonces = new Set<string>();
  const seen: { method: string; path: string; idem?: string; verdict: string }[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((ok) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c)).on('end', () => ok(Buffer.concat(parts)));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const raw = await read(req);
      const path = req.url!.split('?')[0]!;
      const nonce = req.headers['x-madp-nonce'] as string;
      let verdict = madpVerify({
        secret,
        header: req.headers['x-madp-signature'] as string,
        ts: req.headers['x-madp-timestamp'] as string,
        nonce,
        method: req.method!,
        path,
        raw,
      });
      if (verdict === 'ok' && nonces.has(nonce)) verdict = 'replayed_nonce';
      nonces.add(nonce);
      seen.push({ method: req.method!, path, idem: req.headers['idempotency-key'] as string | undefined, verdict });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (verdict !== 'ok' || req.headers['x-madp-client'] !== 's360-client')
        return send(401, { message: 'Bad request signature' });
      const fx = new FixtureMadp('stub');
      if (path === '/api/v1/supply360/attributes') return send(200, await fx.attributes());
      if (path === '/api/v1/supply360/counts') return send(200, await fx.counts(JSON.parse(raw.toString())));
      if (path === '/api/v1/supply360/match') return send(200, await fx.match(JSON.parse(raw.toString())));
      if (path === '/api/v1/supply360/reservations')
        return send(201, await fx.reserve(JSON.parse(raw.toString()), 'x'.repeat(10)));
      if (path.startsWith('/api/v1/supply360/reservations/') && req.method === 'DELETE')
        return send(200, { reservationId: path.split('/').pop(), status: 'released' });
      if (path === '/api/v1/supply360/forbidden') return send(403, { message: 'This client may not read mho' });
      send(404, { message: 'nope' });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it('signs every call so MADP accepts it, with a fresh nonce each time', async () => {
    const live = new LiveMadp(base, 's360-client', secret);
    expect((await live.attributes()).attributes.length).toBeGreaterThan(3);
    const c = await live.counts({ countries: ['US'] });
    expect(c.uniquePeople).toBeGreaterThan(0);
    const m = await live.match({ countries: ['US'], panels: ['t2o'], projectRef: 's360:live', limit: 5 });
    const r = await live.reserve(
      {
        projectRef: 's360:live',
        refs: m.members.map((x) => x.ref),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      's360-idem-key-1',
    );
    await live.release(r.reservationId);
    expect(seen.map((s) => s.verdict)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(seen.find((s) => s.path.endsWith('/reservations'))?.idem).toBe('s360-idem-key-1');
  });
  it('fails with a clear error on a wrong secret, and never retries a 401', async () => {
    const live = new LiveMadp(base, 's360-client', 'wrong-secret-wrong-secret-xx');
    const e = await live.attributes().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AudienceError);
    expect(e).toMatchObject({ status: 401, retryable: false });
  });
  it('treats an unreachable MADP as retryable', async () => {
    const live = new LiveMadp('http://127.0.0.1:1', 's360-client', secret, fetch, 500);
    await expect(live.attributes()).rejects.toMatchObject({ retryable: true });
  });
});
