import { after, describe, it } from 'node:test';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const dbConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 4
};

const hasDbConfig = Boolean(dbConfig.host && dbConfig.user && dbConfig.password && dbConfig.database);
const hasConcurrencyFixtures = process.env.INVENTARIO_CONCURRENCY_QA_FIXTURES === 'true';
const pool = hasDbConfig ? new Pool(dbConfig) : null;

after(async () => {
  if (pool) await pool.end();
});

describe('validarYDescontarPedido concurrencia PostgreSQL QA', { concurrency: false }, () => {
  it('requiere fixtures QA reales para dos descuentos simultaneos del mismo pedido', {
    skip: !(hasDbConfig && hasConcurrencyFixtures)
  }, async () => {
    throw new Error('INVENTARIO_CONCURRENCY_QA_FIXTURES=true debe proveer fixtures reales antes de ejecutar esta suite.');
  });
});
