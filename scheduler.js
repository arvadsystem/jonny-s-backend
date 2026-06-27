import 'dotenv/config';
import { checkDatabaseReady, closePool } from './config/db-connection.js';
import { getRuntimeConfig } from './config/runtime-config.js';
import {
  startEmailCampaignScheduler,
  stopEmailCampaignScheduler
} from './jobs/emailCampaignScheduler.js';

const config = getRuntimeConfig();

await checkDatabaseReady();
const schedulerStart = await startEmailCampaignScheduler();

if (!schedulerStart.started) {
  throw new Error(`EMAIL_SCHEDULER_START_FAILED:${schedulerStart.reason}`);
}

let shutdownPromise = null;

const shutdown = async (signal) => {
  if (shutdownPromise) return shutdownPromise;

  console.warn(`[scheduler_shutdown] Senal recibida: ${signal}. Cerrando scheduler y pool PostgreSQL.`);
  shutdownPromise = Promise.resolve()
    .then(() => stopEmailCampaignScheduler({ timeoutMs: config.gracefulShutdownTimeoutMs }))
    .then(() => closePool())
    .then(() => {
      console.log('[scheduler_shutdown] Scheduler y pool PostgreSQL cerrados.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[scheduler_shutdown] Error durante cierre limpio:', {
        code: err?.code || null,
        message: err?.message || 'Error de cierre'
      });
      process.exit(1);
    });

  return shutdownPromise;
};

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
