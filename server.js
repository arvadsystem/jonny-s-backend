import 'dotenv/config';
import app from './app.js';
import { checkDatabaseReady, closePool } from './config/db-connection.js';
import { getRuntimeConfig } from './config/runtime-config.js';
import {
  startCajaCloseEmailOutboxWorker,
  stopCajaCloseEmailOutboxWorker
} from './jobs/cajaCloseEmailOutboxWorker.js';

const config = getRuntimeConfig();
const PORT = config.port;

await checkDatabaseReady();
await startCajaCloseEmailOutboxWorker();

const server = app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});

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
    .then(() => stopCajaCloseEmailOutboxWorker({ timeoutMs: 5000 }))
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
