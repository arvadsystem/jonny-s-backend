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

const parseNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const DB_POOL_MAX_LIMIT = 24;

const poolMax = parsePositiveInt(process.env.DB_POOL_MAX, 8);
if (poolMax > DB_POOL_MAX_LIMIT) {
  throw new Error(`DB_POOL_MAX no puede ser mayor que ${DB_POOL_MAX_LIMIT}.`);
}

const idleTimeoutMillis = parsePositiveInt(process.env.DB_IDLE_TIMEOUT_MS, 30000);
const connectionTimeoutMillis = parsePositiveInt(process.env.DB_CONNECTION_TIMEOUT_MS, 3000);
const keepAlive = parseBoolean(process.env.DB_KEEP_ALIVE, true);
const keepAliveInitialDelayMillis = parseNonNegativeInt(
  process.env.DB_KEEP_ALIVE_INITIAL_DELAY_MS,
  10000
);
const applicationName = String(process.env.DB_APPLICATION_NAME || 'jonnys-backend').trim() || 'jonnys-backend';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
  application_name: applicationName,

  // Keep the per-process pool conservative because every replica creates one.
  max: poolMax,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  keepAlive,
  keepAliveInitialDelayMillis,

  ssl: {
    rejectUnauthorized: false,
  },
});

const getPoolState = () => ({
  totalCount: pool.totalCount,
  idleCount: pool.idleCount,
  waitingCount: pool.waitingCount
});

console.info('[pool] Configuracion efectiva', {
  DB_POOL_MAX: poolMax,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  keepAlive,
  ...getPoolState()
});

if (poolMax > 12) {
  console.warn('[pool] DB_POOL_MAX alto: este valor se multiplica por cada replica del backend.', {
    DB_POOL_MAX: poolMax
  });
}

pool.on('error', (err) => {
  const payload = {
    code: err?.code || null,
    message: err?.message || 'Unexpected idle client error',
    pool: getPoolState()
  };

  if (err?.code === 'ECONNRESET') {
    console.warn('[pool] Idle PostgreSQL connection reset', payload);
    return;
  }

  console.error('[pool] Unexpected idle client error', payload);
});

export const dbReady = pool.connect()
  .then((client) => {
    console.log('[db] PostgreSQL connection ready');
    client.release();
    return true;
  })
  .catch((err) => {
    console.error('[db] PostgreSQL connection failed:', {
      code: err?.code || null,
      message: err?.message || 'Connection error'
    });
    return false;
  });

let poolEndPromise = null;

export const closePool = async () => {
  if (!poolEndPromise) {
    poolEndPromise = pool.end().catch((err) => {
      poolEndPromise = null;
      throw err;
    });
  }
  return poolEndPromise;
};

export default pool;
