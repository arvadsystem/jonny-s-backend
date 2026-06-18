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

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',

  // Keep the per-process pool conservative because every replica creates one.
  max: parsePositiveInt(process.env.DB_POOL_MAX, 8),
  idleTimeoutMillis: parsePositiveInt(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: parsePositiveInt(process.env.DB_CONNECTION_TIMEOUT_MS, 3000),
  keepAlive: parseBoolean(process.env.DB_KEEP_ALIVE, true),
  keepAliveInitialDelayMillis: parseNonNegativeInt(
    process.env.DB_KEEP_ALIVE_INITIAL_DELAY_MS,
    10000
  ),

  ssl: {
    rejectUnauthorized: false,
  },
});

const getPoolState = () => ({
  totalCount: pool.totalCount,
  idleCount: pool.idleCount,
  waitingCount: pool.waitingCount
});

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
