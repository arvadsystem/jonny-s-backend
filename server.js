import 'dotenv/config';
import app from './app.js';
import { closePool } from './config/db-connection.js';
import {
  startDatabaseReadinessLoop,
  stopDatabaseReadinessLoop
} from './config/dbReadiness.js';
import { getRuntimeConfig } from './config/runtime-config.js';
import {
  startCajaCloseEmailOutboxWorker,
  stopCajaCloseEmailOutboxWorker
} from './jobs/cajaCloseEmailOutboxWorker.js';
import {
  startOperationalSessionCutoffWorker,
  stopOperationalSessionCutoffWorker
} from './jobs/operationalSessionCutoffWorker.js';
import {
  attachPrintAgentWebSocketServer,
  detachPrintAgentWebSocketServer,
  isPrintAgentWebSocketEnabled
} from './services/printAgentWebSocketService.js';
import { closeFidelizacionPool } from './modules/fidelizacion/infrastructure/fidelizacionPool.js';
import { waitForFidelizacionQueueIdle } from './modules/fidelizacion/infrastructure/fidelizacionQueue.js';

const config = getRuntimeConfig();
const PORT = config.port;

// Orquesta el shutdown del proceso web: servidor HTTP, readiness, workers
// web existentes, y AMBOS pools de Postgres (el principal y el dedicado de
// fidelizacion). Aislado en una factoria (mismo patron que
// createSchedulerRuntime en scheduler.js) para poder probarlo con
// dependencias inyectadas, sin abrir un puerto real ni tocar una base real.
export const createServerRuntime = ({
  server,
  runtimeConfig = config,
  stopReadiness = stopDatabaseReadinessLoop,
  stopCajaWorker = stopCajaCloseEmailOutboxWorker,
  stopSessionCutoffWorker = stopOperationalSessionCutoffWorker,
  detachPrintAgentWs = detachPrintAgentWebSocketServer,
  waitForFidelizacionQueue = waitForFidelizacionQueueIdle,
  closeFidelizacionDatabasePool = closeFidelizacionPool,
  closeDatabasePool = closePool,
  runtimeProcess = process
} = {}) => {
  let shutdownPromise = null;

  const closeHttpServer = () => new Promise((resolve) => {
    server.close((serverErr) => {
      if (serverErr) {
        console.error('[shutdown] Error cerrando servidor HTTP:', {
          code: serverErr?.code || null,
          message: serverErr?.message || 'Error de cierre'
        });
      }
      resolve();
    });
  });

  // closeFidelizacionPool ya reporta el error internamente (y es idempotente);
  // aqui solo se evita que una falla al cerrar ESTE pool impida intentar
  // cerrar el pool principal despues.
  const closeFidelizacionPoolSafely = () => closeFidelizacionDatabasePool().catch((err) => {
    console.error('[shutdown] Error cerrando fidelizacionPool:', {
      code: err?.code || err?.name || 'FIDELIZACION_POOL_CLOSE_ERROR'
    });
  });

  const shutdown = async (signal) => {
    if (shutdownPromise) return shutdownPromise;

    console.warn(`[shutdown] Senal recibida: ${signal}. Cerrando servidor HTTP y pools PostgreSQL.`);
    // El monitor de readiness se detiene primero y se espera (acotado) a que el chequeo en
    // vuelo termine, para no cerrar el pool a mitad de un SELECT 1 en curso.
    const gracefulWork = stopReadiness({ timeoutMs: 5000 })
      .then(() => closeHttpServer())
      .then(() => Promise.all([
        stopCajaWorker({ timeoutMs: 5000 }),
        stopSessionCutoffWorker({ timeoutMs: 5000 }),
        detachPrintAgentWs()
      ]))
      // Fidelizacion: esperar cualquier acumulacion en curso en la cola interna
      // (concurrencia 1) antes de cerrar su pool dedicado, para no cortarla a
      // mitad de camino. No depende de ni bloquea al pool financiero principal.
      .then(() => waitForFidelizacionQueue())
      .then(() => closeFidelizacionPoolSafely())
      .then(() => closeDatabasePool());

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('GRACEFUL_SHUTDOWN_TIMEOUT')), runtimeConfig.gracefulShutdownTimeoutMs);
    });

    shutdownPromise = Promise.race([gracefulWork, timeout])
      .then(() => {
        console.log('[shutdown] Servidor y pools PostgreSQL cerrados.');
        runtimeProcess.exit(0);
      })
      .catch((err) => {
        console.warn('[shutdown] Cierre limpio incompleto, intentando cerrar los pools antes de salir.', {
          code: err?.code || null,
          message: err?.message || 'Error de cierre'
        });
        return Promise.allSettled([closeFidelizacionPoolSafely(), closeDatabasePool()])
          .finally(() => runtimeProcess.exit(1));
      });

    return shutdownPromise;
  };

  return { shutdown };
};

if (process.env.SERVER_RUNTIME_AUTOSTART_DISABLED !== 'true') {
  const server = app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
    // El puerto abre de inmediato, sin esperar a PostgreSQL (liveness). La disponibilidad de
    // la DB (readiness) se rastrea en segundo plano -- ver config/dbReadiness.js: backoff con
    // jitter (2s..30s), nunca mas de un ciclo de reconexion activo. Los workers arrancan una
    // sola vez, recien cuando la DB confirma estar lista, para no competir con su propio
    // backoff interno en paralelo mientras la base sigue caida. Ver
    // jobs/cajaCloseEmailOutboxWorker.js y jobs/operationalSessionCutoffWorker.js.
    startDatabaseReadinessLoop({
      onReady: () => {
        startCajaCloseEmailOutboxWorker().catch((error) => {
          console.error('[caja_close_email_outbox_worker] fallo al iniciar en segundo plano', {
            code: error?.code || 'CAJA_CLOSE_EMAIL_OUTBOX_START_ERROR',
            message: error?.message || 'Error iniciando el worker de outbox de cierre de caja.'
          });
        });
        startOperationalSessionCutoffWorker().catch((error) => {
          console.error('[operational_session_cutoff_worker] fallo al iniciar en segundo plano', {
            code: error?.code || 'OPERATIONAL_SESSION_CUTOFF_START_ERROR',
            message: error?.message || 'Error iniciando el worker de corte operativo.'
          });
        });
      }
    });
  });

  // Aditivo: notifica "job_available" por WebSocket a agentes de impresion ya autenticados.
  // El polling del agente sigue siendo la via de reclamo; ver services/printAgentWebSocketService.js.
  if (isPrintAgentWebSocketEnabled()) {
    attachPrintAgentWebSocketServer(server);
    console.log('[print-agent.ws] servidor WebSocket habilitado en /api/print-agent/ws');
  }

  const serverRuntime = createServerRuntime({ server });

  process.once('SIGTERM', () => {
    void serverRuntime.shutdown('SIGTERM');
  });

  process.once('SIGINT', () => {
    void serverRuntime.shutdown('SIGINT');
  });
}
