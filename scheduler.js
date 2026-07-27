import 'dotenv/config';
import process from 'node:process';
import { checkDatabaseReady, closePool } from './config/db-connection.js';
import { getRuntimeConfig } from './config/runtime-config.js';
import {
  startEmailCampaignScheduler,
  stopEmailCampaignScheduler
} from './jobs/emailCampaignScheduler.js';
import {
  startFidelizacionReconciliationScheduler,
  stopFidelizacionReconciliationScheduler
} from './jobs/fidelizacionReconciliationScheduler.js';
import { closeFidelizacionPool } from './modules/fidelizacion/infrastructure/fidelizacionPool.js';
import { waitForFidelizacionQueueIdle } from './modules/fidelizacion/infrastructure/fidelizacionQueue.js';

const config = getRuntimeConfig();

export const createSchedulerRuntime = ({
  runtimeConfig = config,
  dbReady = checkDatabaseReady,
  startScheduler = startEmailCampaignScheduler,
  stopScheduler = stopEmailCampaignScheduler,
  startFidelizacionScheduler = startFidelizacionReconciliationScheduler,
  stopFidelizacionScheduler = stopFidelizacionReconciliationScheduler,
  waitForFidelizacionQueue = waitForFidelizacionQueueIdle,
  closeDatabasePool = closePool,
  closeFidelizacionDatabasePool = closeFidelizacionPool,
  runtimeProcess = process
} = {}) => {
  let shutdownPromise = null;

  // El scheduler de fidelizacion arranca de forma independiente del de
  // correo: su propio guard de PROCESS_ROLE/FIDELIZACION_RECONCILE_SCHEDULER_ENABLED
  // decide si arranca o no, y ni un "DISABLED" ni un fallo aqui deben impedir
  // que el scheduler de correo (critico) siga su curso normal.
  const startFidelizacionSchedulerSafely = async () => {
    try {
      return await startFidelizacionScheduler();
    } catch (err) {
      console.error('[scheduler] fallo al iniciar el scheduler de fidelizacion (no afecta al de correo):', {
        code: err?.code || err?.name || 'FIDELIZACION_SCHEDULER_START_ERROR'
      });
      return { started: false, reason: 'START_ERROR' };
    }
  };

  const stopFidelizacionSchedulerSafely = async () => {
    try {
      return await stopFidelizacionScheduler();
    } catch (err) {
      console.error('[scheduler_shutdown] fallo al detener el scheduler de fidelizacion (continua el cierre):', {
        code: err?.code || err?.name || 'FIDELIZACION_SCHEDULER_STOP_ERROR'
      });
      return { stopped: false, reason: 'STOP_ERROR' };
    }
  };

  // closeFidelizacionDatabasePool ya reporta el error internamente; aqui solo
  // se evita que una falla de cierre de ESTE pool interrumpa el shutdown.
  const closeFidelizacionPoolSafely = () => closeFidelizacionDatabasePool().catch(() => undefined);

  const start = async () => {
    await dbReady();
    if (shutdownPromise) {
      return { started: false, reason: 'SHUTTING_DOWN' };
    }

    const schedulerStart = await startScheduler();
    const fidelizacionSchedulerStart = await startFidelizacionSchedulerSafely();

    if (shutdownPromise) {
      return { ...schedulerStart, fidelizacion: fidelizacionSchedulerStart };
    }

    if (!schedulerStart.started) {
      throw new Error(`EMAIL_SCHEDULER_START_FAILED:${schedulerStart.reason}`);
    }

    return { ...schedulerStart, fidelizacion: fidelizacionSchedulerStart };
  };

  const shutdown = async (signal) => {
    if (shutdownPromise) return shutdownPromise;

    console.warn(`[scheduler_shutdown] Senal recibida: ${signal}. Cerrando schedulers y pools PostgreSQL.`);
    shutdownPromise = Promise.resolve()
      .then(() => Promise.all([
        stopScheduler({ timeoutMs: runtimeConfig.gracefulShutdownTimeoutMs }),
        stopFidelizacionSchedulerSafely()
      ]))
      .then(async ([stopResult]) => {
        if (!stopResult?.stopped) {
          const error = new Error(`EMAIL_SCHEDULER_STOP_FAILED:${stopResult?.reason || 'UNKNOWN'}`);
          error.code = stopResult?.reason || 'EMAIL_SCHEDULER_STOP_FAILED';
          throw error;
        }

        // Esperar trabajos de fidelizacion en curso (cola interna) antes de
        // cerrar su pool dedicado, para no cortar una acumulacion a mitad de
        // camino.
        await waitForFidelizacionQueue().catch(() => undefined);

        await closeDatabasePool();
        await closeFidelizacionPoolSafely();
      })
      .then(() => {
        console.log('[scheduler_shutdown] Schedulers y pools PostgreSQL cerrados.');
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
  process.once('SIGTERM', () => {
    void schedulerRuntime.shutdown('SIGTERM');
  });

  process.once('SIGINT', () => {
    void schedulerRuntime.shutdown('SIGINT');
  });

  await schedulerRuntime.start();
}
