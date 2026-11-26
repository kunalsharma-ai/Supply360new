import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createDb, createPool } from './client.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required to run migrations');
const pool = createPool(url, 1);
await migrate(createDb(pool), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });

// Optional: provision the API's login role, so a container stack needs no manual psql step. The role gets the
// s360_app privileges (row-level security applies), and its password is kept in step with the environment.
const loginPassword = process.env.S360_API_DB_PASSWORD;
if (loginPassword) {
  const client = await pool.connect();
  try {
    const exists = await client.query("select 1 from pg_roles where rolname = 's360_api'");
    const verb = exists.rowCount ? 'alter' : 'create';
    await client.query(`${verb} role s360_api login password ${client.escapeLiteral(loginPassword)}`);
    await client.query('grant s360_app to s360_api');
    console.log(`login role s360_api ${verb === 'create' ? 'created' : 'updated'}`);
  } finally {
    client.release();
  }
}
await pool.end();
console.log('migrations applied');
