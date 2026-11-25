import { createApp } from './bootstrap.js';
import { loadEnv } from './config.js';

const env = loadEnv();
const app = await createApp(env);
await app.listen(env.PORT);
console.log(`Supply360 API on :${env.PORT}/api/v1`);
