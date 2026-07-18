import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createApiClient } from './apiClient.js';
import { createQzClient } from './qzClient.js';
import { createRunner } from './runner.js';
import { createPrintStateStore } from './stateStore.js';
import { acquireProcessLock } from './processLock.js';

const config = loadConfig();
const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(agentDirectory, '.print-agent.lock');
const log = (level, event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
const processLock = acquireProcessLock({
  lockPath,
  onStaleLockRemoved: (metadata) => log('warn', 'stale_lock_removed', { stale_pid: metadata?.pid ?? null })
});

let qz;
let runner;
let shutdownPromise;
let exitRequested = false;
const shutdown = async (signal) => {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    log('info', 'shutdown', { signal });
    runner?.stop();
    await qz?.disconnect().catch(() => undefined);
    processLock.release();
  })();
  return shutdownPromise;
};
const exitAfterShutdown = (signal) => {
  if (exitRequested) return;
  exitRequested = true;

  void shutdown(signal)
    .then(() => process.exit(0))
    .catch((error) => {
      log('error', 'shutdown_failed', { signal, code: error?.code || 'PRINT_AGENT_SHUTDOWN_FAILED' });
      process.exit(1);
    });
};
process.once('SIGINT', () => exitAfterShutdown('SIGINT'));
process.once('SIGTERM', () => exitAfterShutdown('SIGTERM'));

try {
  const api = createApiClient({ config });
  qz = createQzClient({ config, api });
  const stateStore = createPrintStateStore({ filePath: config.stateFile });
  await stateStore.init();
  runner = createRunner({ config, api, qz, stateStore, log });
  log('info', 'agent_started', { agent_id: config.agentId, branch_id: config.branchId });
  await runner.run();
} finally {
  processLock.release();
}
