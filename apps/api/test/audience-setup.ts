import { expect } from 'vitest';
import type { signIn } from './harness.js';

type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
const csrf = { 'x-s360-csrf': '1' };

export interface Cell {
  id: string;
  countryCode: string;
  name: string;
  isMarketCell: boolean;
  held: number;
  allocation: number;
  inviteCap: number | null;
  criteria: unknown;
}

export async function madpConnection(admin: Agent) {
  const list = await admin.get('/api/v1/audience/connections');
  if (list.body.activeId) return list.body.activeId as string;
  const r = await admin
    .post('/api/v1/audience/connections')
    .set(csrf)
    .send({ name: 'MADP (FIXTURE)', mode: 'fixture' });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

export const quotas = async (admin: Agent, projectId: string) =>
  (await admin.get(`/api/v1/projects/${projectId}/quotas`)).body as {
    cells: Cell[];
    checks: { key: string; ok: boolean }[];
  };

/** Maps every cell to Turn2Opinion (gender cells by gender), caps each and holds a few people, so a project can launch. */
export async function prepareAudience(admin: Agent, projectId: string, cap = 40, hold = 10) {
  await madpConnection(admin);
  const { cells } = await quotas(admin, projectId);
  expect(cells.length).toBeGreaterThan(0);
  for (const c of cells) {
    const gender = c.isMarketCell ? null : c.name.toLowerCase();
    const r = await admin
      .put(`/api/v1/projects/${projectId}/quotas/${c.id}/mapping`)
      .set(csrf)
      .send({
        criteria: {
          panels: ['t2o'],
          ...(gender ? { attributes: [{ key: 'demographics.gender', values: [gender] }] } : {}),
        },
      });
    expect(r.status).toBe(200);
  }
  const a = await admin
    .put(`/api/v1/projects/${projectId}/allocation`)
    .set(csrf)
    .send({ mode: 'proportional', caps: Object.fromEntries(cells.map((c) => [c.id, cap])) });
  expect(a.status).toBe(200);
  for (const c of cells) {
    const r = await admin.post(`/api/v1/projects/${projectId}/quotas/${c.id}/reserve`).set(csrf).send({ count: hold });
    expect(r.status).toBe(200);
  }
}
