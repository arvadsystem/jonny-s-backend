import 'dotenv/config';
import app from './app.js';
import { checkDatabaseReady, closePool } from './config/db-connection.js';
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

const config = getRuntimeConfig();
const PORT = config.port;

await checkDatabaseReady();

const server = app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
  // El puerto ya esta escuchando: ni el primer tick del outbox ni el del corte operativo
  // (o un timeout/degradacion de PostgreSQL durante cualquiera de los dos) deben retrasar
  // ni tumbar la apertura del servidor. Ver jobs/cajaCloseEmailOutboxWorker.js
  // (CAJA_CLOSE_EMAIL_OUTBOX_ENABLED, backoff) y jobs/operationalSessionCutoffWorker.js.
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
});

// Aditivo: notifica "job_available" por WebSocket a agentes de impresion ya autenticados.
// El polling del agente sigue siendo la via de reclamo; ver services/printAgentWebSocketService.js.
if (isPrintAgentWebSocketEnabled()) {
  attachPrintAgentWebSocketServer(server);
  console.log('[print-agent.ws] servidor WebSocket habilitado en /api/print-agent/ws');
}

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

const shutdown = async (signal) => {
  if (shutdownPromise) return shutdownPromise;

  console.warn(`[shutdown] Senal recibida: ${signal}. Cerrando servidor HTTP y pool PostgreSQL.`);
  const gracefulWork = closeHttpServer()
    .then(() => Promise.all([
      stopCajaCloseEmailOutboxWorker({ timeoutMs: 5000 }),
      stopOperationalSessionCutoffWorker({ timeoutMs: 5000 }),
      detachPrintAgentWebSocketServer()
    ]))
    .then(() => closePool());

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('GRACEFUL_SHUTDOWN_TIMEOUT')), config.gracefulShutdownTimeoutMs);
  });

  shutdownPromise = Promise.race([gracefulWork, timeout])
    .then(() => {
      console.log('[shutdown] Servidor y pool PostgreSQL cerrados.');
      process.exit(0);
    })
    .catch((err) => {
      console.warn('[shutdown] Cierre limpio incompleto, intentando cerrar pool antes de salir.', {
        code: err?.code || null,
        message: err?.message || 'Error de cierre'
      });
      closePool()
        .catch(() => {})
        .finally(() => process.exit(1));
    });

  return shutdownPromise;
};

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
