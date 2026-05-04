import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool, types } = pg;

types.setTypeParser(1114, (val) => val);
types.setTypeParser(1082, (val) => val);

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',

  // Supabase session pooler en QA está limitando a pool_size 15.
  // Debe quedar por debajo del límite porque hay consultas paralelas y scheduler.
  max: parsePositiveInt(process.env.DB_POOL_MAX, 8),
  idleTimeoutMillis: parsePositiveInt(process.env.DB_IDLE_TIMEOUT_MS, 10000),
  connectionTimeoutMillis: parsePositiveInt(process.env.DB_CONNECTION_TIMEOUT_MS, 5000),

  ssl: {
    rejectUnauthorized: false,
  },
});

// Capturar errores inesperados del pool (conexiones idle que mueren)
// para que no crasheen el proceso.
pool.on('error', (err) => {
  console.error('❌ [pool] Error inesperado en conexión idle:', err.message);
});

// Promesa de "readiness": permite que app.js espere la conexión
// antes de aceptar requests.
export const dbReady = pool.connect()
  .then((client) => {
    console.log('✅ ¡Conexión exitosa a Supabase!');
    client.release();
    return true;
  })
  .catch((err) => {
    console.error('❌ Error al conectar con la base de datos:', err.message);
    return false;
  });

export default pool;