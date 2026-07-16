import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createApiClient } from './apiClient.js';
import { createQzClient } from './qzClient.js';
import { createRunner } from './runner.js';

const config = loadConfig();
const lockPath = path.resolve('.print-agent.lock');
let lockHandle;
try { lockHandle = fs.openSync(lockPath, 'wx'); } catch { throw new Error('PRINT_AGENT_ALREADY_RUNNING'); }
const log = (level, event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
const api = createApiClient({ config });
const qz = createQzClient({ config, api });
const runner = createRunner({ config, api, qz, log });
const shutdown = async (signal) => {
  log('info', 'shutdown', { signal });
  runner.stop();
  await qz.disconnect().catch(() => undefined);
  try { fs.closeSync(lockHandle); fs.unlinkSync(lockPath); } catch { /* noop */ }
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
log('info', 'agent_started', { agent_id: config.agentId, branch_id: config.branchId });
await runner.run();
