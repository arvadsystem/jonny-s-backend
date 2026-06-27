import 'dotenv/config';
import app from './app.js';
import { checkDatabaseReady, closePool } from './config/db-connection.js';
import { drainCajaCloseNotificationQueue } from './services/cajaCloseNotificationQueue.js';

const PORT = process.env.PORT || 3001;

await checkDatabaseReady();

const server = app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});

let shutdownPromise = null;

const shutdown = async (signal) => {
  if (shutdownPromise) return shutdownPromise;

  console.warn(`[shutdown] Senal recibida: ${signal}. Cerrando servidor HTTP y pool PostgreSQL.`);
  shutdownPromise = new Promise((resolve) => {
    server.close((serverErr) => {
      if (serverErr) {
        console.error('[shutdown] Error cerrando servidor HTTP:', {
          code: serverErr?.code || null,
          message: serverErr?.message || 'Error de cierre'
        });
      }
      resolve();
    });
  })
    .then(() => drainCajaCloseNotificationQueue({ timeoutMs: 5000 }))
    .then(() => closePool())
    .then(() => {
      console.log('[shutdown] Servidor y pool PostgreSQL cerrados.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[shutdown] Error durante cierre limpio:', {
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
