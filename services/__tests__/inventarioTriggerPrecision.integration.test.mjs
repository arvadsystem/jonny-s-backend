import assert from 'node:assert/strict';
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
  max: 1
};

const hasDbConfig = Boolean(dbConfig.host && dbConfig.user && dbConfig.password && dbConfig.database);
const pool = hasDbConfig ? new Pool(dbConfig) : null;

after(async () => {
  if (pool) await pool.end();
});

describe('fn_mov_inv_apply_stock precision PostgreSQL QA', { concurrency: false }, () => {
  it('preserva seis decimales en saldos y stock dentro de una transaccion revertida', { skip: !hasDbConfig }, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const targetResult = await client.query(`
        SELECT ia.id_insumo, ia.id_almacen
        FROM public.insumos_almacenes ia
        WHERE ia.id_insumo IS NOT NULL
          AND ia.id_almacen IS NOT NULL
        ORDER BY ia.id_insumo, ia.id_almacen
        LIMIT 1
        FOR UPDATE OF ia
      `);

      assert.equal(targetResult.rowCount, 1, 'QA debe tener al menos un insumo por almacen para probar el trigger');
      const target = targetResult.rows[0];

      await client.query(
        `UPDATE public.insumos_almacenes SET cantidad = 1.000000 WHERE id_insumo = $1 AND id_almacen = $2`,
        [target.id_insumo, target.id_almacen]
      );

      const salida = await client.query(`
        INSERT INTO public.movimientos_inventario (
          tipo,
          cantidad,
          id_almacen,
          id_insumo,
          ref_origen,
          id_ref,
          descripcion
        )
        VALUES ('SALIDA', 0.002500, $1, $2, 'QA_PRECISION_TEST', 900000001, 'QA precision trigger salida rollback')
        RETURNING id_movimiento, saldo_antes, saldo_despues
      `, [target.id_almacen, target.id_insumo]);

      const entrada = await client.query(`
        INSERT INTO public.movimientos_inventario (
          tipo,
          cantidad,
          id_almacen,
          id_insumo,
          id_movimiento_origen,
          ref_origen,
          id_ref,
          descripcion
        )
        VALUES ('ENTRADA', 0.000833, $1, $2, $3, 'QA_PRECISION_TEST', 900000002, 'QA precision trigger entrada rollback')
        RETURNING id_movimiento, saldo_antes, saldo_despues
      `, [target.id_almacen, target.id_insumo, salida.rows[0].id_movimiento]);

      const stockResult = await client.query(
        `SELECT cantidad FROM public.insumos_almacenes WHERE id_insumo = $1 AND id_almacen = $2`,
        [target.id_insumo, target.id_almacen]
      );

      assert.equal(String(salida.rows[0].saldo_antes), '1.000000');
      assert.equal(String(salida.rows[0].saldo_despues), '0.997500');
      assert.equal(String(entrada.rows[0].saldo_antes), '0.997500');
      assert.equal(String(entrada.rows[0].saldo_despues), '0.998333');
      assert.equal(String(stockResult.rows[0].cantidad), '0.998333');
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });
});
