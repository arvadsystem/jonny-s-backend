import 'dotenv/config';
import process from 'node:process';
import { checkDatabaseReady, closePool } from './config/db-connection.js';
import { getRuntimeConfig } from './config/runtime-config.js';
import {
  startEmailCampaignScheduler,
  stopEmailCampaignScheduler
} from './jobs/emailCampaignScheduler.js';

const config = getRuntimeConfig();

export const createSchedulerRuntime = ({
  runtimeConfig = config,
  dbReady = checkDatabaseReady,
  startScheduler = startEmailCampaignScheduler,
  stopScheduler = stopEmailCampaignScheduler,
  closeDatabasePool = closePool,
  runtimeProcess = process
} = {}) => {
  let shutdownPromise = null;

  const start = async () => {
    await dbReady();
    const schedulerStart = await startScheduler();

    if (!schedulerStart.started) {
      throw new Error(`EMAIL_SCHEDULER_START_FAILED:${schedulerStart.reason}`);
    }

    return schedulerStart;
  };

  const shutdown = async (signal) => {
    if (shutdownPromise) return shutdownPromise;

    console.warn(`[scheduler_shutdown] Senal recibida: ${signal}. Cerrando scheduler y pool PostgreSQL.`);
    shutdownPromise = Promise.resolve()
      .then(() => stopScheduler({ timeoutMs: runtimeConfig.gracefulShutdownTimeoutMs }))
      .then((stopResult) => {
        if (!stopResult?.stopped) {
          const error = new Error(`EMAIL_SCHEDULER_STOP_FAILED:${stopResult?.reason || 'UNKNOWN'}`);
          error.code = stopResult?.reason || 'EMAIL_SCHEDULER_STOP_FAILED';
          throw error;
        }
        return closeDatabasePool();
      })
      .then(() => {
        console.log('[scheduler_shutdown] Scheduler y pool PostgreSQL cerrados.');
        runtimeProcess.exit(0);
      })
      .catch((err) => {
        console.error('[scheduler_shutdown] Error durante cierre limpio:', {
          code: err?.code || null,
          message: err?.message || 'Error de cierre'
        });
        runtimeProcess.exit(1);
      });

    return shutdownPromise;
  };

  return { start, shutdown };
};

export const schedulerRuntime = createSchedulerRuntime();

if (process.env.SCHEDULER_RUNTIME_AUTOSTART_DISABLED !== 'true') {
  await schedulerRuntime.start();

  process.once('SIGTERM', () => {
    void schedulerRuntime.shutdown('SIGTERM');
  });

  process.once('SIGINT', () => {
    void schedulerRuntime.shutdown('SIGINT');
  });
}
