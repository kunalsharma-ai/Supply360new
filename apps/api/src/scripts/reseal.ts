import 'reflect-metadata';
import pg from 'pg';
import { callbackContext } from '../fieldwork/fieldwork.service.js';
import { keyContext, secretContext } from '../ingestion/ingestion.service.js';
import { madpSecretContext } from '../audience/audience.service.js';
import { Sealer } from '../crypto/sealer.js';

/**
 * Key rotation, step 3: re-seal every sealed column with the current FIELD_ENCRYPTION_KEY.
 * Needs FIELD_ENCRYPTION_KEY (new) and FIELD_ENCRYPTION_KEY_PREVIOUS (old), and DATABASE_ADMIN_URL (row-level
 * security would hide other tenants' rows from the app role). One transaction: either every value moves or none.
 * Safe to run twice: values the current key already opens are left alone. Prints counts, never values.
 */
const url = process.env.DATABASE_ADMIN_URL;
const key = process.env.FIELD_ENCRYPTION_KEY;
const previous = process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
if (!url || !key || !previous)
  throw new Error('DATABASE_ADMIN_URL, FIELD_ENCRYPTION_KEY and FIELD_ENCRYPTION_KEY_PREVIOUS are required');
const sealer = new Sealer(key, previous);

const COLUMNS: { table: string; column: string; id: string; context: (id: string) => string }[] = [
  { table: 'users', column: 'totp_secret', id: 'id', context: (id) => `totp:${id}` },
  { table: 'source_connections', column: 'api_key_sealed', id: 'id', context: keyContext },
  { table: 'source_connections', column: 'webhook_secret_sealed', id: 'id', context: secretContext },
  { table: 'source_connections', column: 'callback_secret_sealed', id: 'id', context: callbackContext },
  { table: 'audience_connections', column: 'secret_sealed', id: 'id', context: madpSecretContext },
  { table: 'sampintel_connections', column: 'token_sealed', id: 'tenant_id', context: (id) => `sampintel:${id}` },
  { table: 'alert_settings', column: 'smtp_password_sealed', id: 'tenant_id', context: (id) => `alerts-smtp:${id}` },
  { table: 'alert_settings', column: 'webhook_url_sealed', id: 'tenant_id', context: (id) => `alerts-webhook:${id}` },
];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  for (const c of COLUMNS) {
    const { rows } = await client.query<{ id: string; v: string }>(
      `select ${c.id} as id, ${c.column} as v from ${c.table} where ${c.column} is not null for update`,
    );
    let moved = 0;
    for (const r of rows) {
      let opened: { plain: string; keyIndex: number };
      try {
        opened = sealer.openWithKey(r.v, c.context(r.id));
      } catch {
        throw new Error(`${c.table}.${c.column} for ${c.id}=${r.id} opens with neither key; nothing was changed`);
      }
      const { plain, keyIndex } = opened;
      if (keyIndex === 0) continue;
      await client.query(`update ${c.table} set ${c.column} = $1 where ${c.id} = $2`, [
        sealer.seal(plain, c.context(r.id)),
        r.id,
      ]);
      moved++;
    }
    console.log(`${c.table}.${c.column}: ${rows.length} sealed, ${moved} re-sealed`);
  }
  await client.query('commit');
  console.log('re-seal complete: FIELD_ENCRYPTION_KEY_PREVIOUS can now be removed');
} catch (e) {
  await client.query('rollback');
  throw e;
} finally {
  await client.end();
}
