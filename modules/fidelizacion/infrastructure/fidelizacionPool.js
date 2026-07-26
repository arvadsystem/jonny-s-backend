import pg from 'pg';

const { Pool } = pg;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Pool propio y aislado del pool financiero compartido (config/db-connection.js).
// Limitado a una sola conexion a proposito: la acumulacion de fidelizacion
// nunca debe competir por conexiones con ventas, caja, inventario o facturacion,
// ni al reves. Usa las mismas credenciales/host que el pool principal.
export const fidelizacionPool = new Pool({
  host: process.env.DB_HOST,
  port: parsePositiveInt(process.env.DB_PORT, 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
  application_name: 'jonnys-backend-fidelizacion',
  max: 1,
  idleTimeoutMillis: parsePositiveInt(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: parsePositiveInt(process.env.DB_CONNECTION_TIMEOUT_MS, 3000),
  ssl: {
    rejectUnauthorized: false
  }
});

fidelizacionPool.on('error', (err) => {
  console.error('[fidelizacion:pool] Unexpected idle client error', {
    code: err?.code || null,
    message: err?.message || 'Unexpected idle client error'
  });
});

let fidelizacionPoolEndPromise = null;

// Idempotente: llamadas concurrentes o repetidas comparten/reciben el mismo
// resultado, nunca intentan cerrar dos veces en paralelo. Si el cierre falla,
// se limpia el cache para permitir un reintento posterior (mismo patron que
// closePool en config/db-connection.js) y el error se reporta sin lanzar
// hacia quien orquesta el shutdown (Ventas nunca depende de este pool).
export const closeFidelizacionPool = async () => {
  if (!fidelizacionPoolEndPromise) {
    fidelizacionPoolEndPromise = fidelizacionPool.end().catch((err) => {
      fidelizacionPoolEndPromise = null;
      console.error('[fidelizacion:pool] error al cerrar el pool dedicado', {
        code: err?.code || err?.name || 'FIDELIZACION_POOL_CLOSE_ERROR'
      });
      throw err;
    });
  }
  return fidelizacionPoolEndPromise;
};
