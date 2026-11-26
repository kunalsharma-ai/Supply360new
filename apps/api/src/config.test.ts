import { describe, expect, it } from 'vitest';
import { loadEnv, productionProblems } from './config.js';

const good = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://s360_api:pw@db:5432/supply360',
  DATABASE_ADMIN_URL: 'postgres://postgres:pw@db:5432/supply360',
  SESSION_SECRET: 'x'.repeat(40),
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_ORIGIN: 'https://supply360.example.com',
  COOKIE_SECURE: 'true',
  PARTICIPATION_TOKEN_SECRET: 'p'.repeat(40),
};

describe('production configuration', () => {
  it('starts with safe settings', () => {
    expect(() => loadEnv(good)).not.toThrow();
    expect(productionProblems(loadEnv(good))).toEqual([]);
  });
  it.each([
    [{ COOKIE_SECURE: 'false' }, 'COOKIE_SECURE'],
    [{ WEB_ORIGIN: 'http://supply360.example.com' }, 'WEB_ORIGIN must be https'],
    [{ PUBLIC_BASE_URL: 'http://x.example.com' }, 'PUBLIC_BASE_URL'],
    [{ SESSION_SECRET: 'CHANGE-ME'.padEnd(40, 'x') }, 'SESSION_SECRET still holds'],
    [{ DATABASE_URL: 'postgres://postgres:pw@db:5432/supply360' }, 'owner role'],
    [{ LOGIN_RATE_LIMIT: '1000' }, 'load-test setting'],
    [{ PARTICIPATION_TOKEN_SECRET: undefined }, 'PARTICIPATION_TOKEN_SECRET must be set'],
    [{ FIELD_ENCRYPTION_KEY_PREVIOUS: Buffer.alloc(32, 1).toString('base64') }, 'must differ'],
  ])('refuses %o', (over, msg) => {
    expect(() => loadEnv({ ...good, ...over })).toThrow(msg);
  });
  it('reads the proxy hop count for client addresses', () => {
    expect(loadEnv({ ...good, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    expect(loadEnv(good).TRUST_PROXY_HOPS).toBeUndefined();
    expect(() => loadEnv({ ...good, TRUST_PROXY_HOPS: '9' })).toThrow();
  });
  it('allows local settings outside production', () => {
    expect(() => loadEnv({ ...good, NODE_ENV: 'development', COOKIE_SECURE: 'false', WEB_ORIGIN: 'http://localhost:3000' })).not.toThrow();
  });
});
