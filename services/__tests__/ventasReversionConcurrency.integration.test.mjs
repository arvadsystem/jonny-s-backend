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
  max: 4
};

const pool = new Pool(dbConfig);

after(async () => {
  await pool.end();
});

const createOriginalMovement = async (client) => {
  const result = await client.query(`
    SELECT
      dp.id_pedido,
      dp.id_detalle_pedido,
      ia.id_insumo,
      ia.id_almacen
    FROM public.detalle_pedido dp
    CROSS JOIN public.insumos_almacenes ia
    WHERE dp.id_pedido IS NOT NULL
      AND dp.id_detalle_pedido IS NOT NULL
      AND ia.id_insumo IS NOT NULL
      AND ia.id_almacen IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.movimientos_inventario mi
        WHERE mi.tipo = 'SALIDA'
          AND mi.ref_origen = 'PEDIDO'
          AND mi.id_ref = dp.id_pedido
          AND mi.id_detalle_pedido = dp.id_detalle_pedido
          AND mi.origen_consumo = 'RECETA'
          AND mi.id_insumo = ia.id_insumo
      )
    ORDER BY dp.id_detalle_pedido DESC, ia.id_insumo, ia.id_almacen
    LIMIT 1
  `);
  assert.equal(result.rowCount, 1, 'QA debe tener una linea de pedido libre y un insumo por almacen');
  const target = result.rows[0];
  const inserted = await client.query(
    `
      INSERT INTO public.movimientos_inventario (
        tipo,
        cantidad,
        id_almacen,
        id_insumo,
        id_detalle_pedido,
        origen_consumo,
        ref_origen,
        id_ref,
        descripcion
      )
      VALUES ('SALIDA', 10.000000, $1, $2, $3, 'RECETA', 'PEDIDO', $4, 'QA rollback salida original reversion')
      RETURNING id_movimiento, cantidad, id_almacen, id_producto, id_insumo, id_detalle_pedido, origen_consumo
    `,
    [target.id_almacen, target.id_insumo, target.id_detalle_pedido, target.id_pedido]
  );
  return inserted.rows[0];
};

const insertReturn = (client, original, cantidad, idReversion) => client.query(
  `
    INSERT INTO public.movimientos_inventario (
      tipo,
      cantidad,
      id_almacen,
      id_producto,
      id_insumo,
      id_detalle_pedido,
      origen_consumo,
      id_movimiento_origen,
      ref_origen,
      id_ref,
      descripcion
    )
    VALUES ('ENTRADA', $1, $2, $3, $4, $5, $6, $7, 'REVERSION_VENTA_INVENTARIO', $8, $9)
    RETURNING id_movimiento
  `,
  [
    cantidad,
    original.id_almacen,
    original.id_producto || null,
    original.id_insumo || null,
    original.id_detalle_pedido,
    original.origen_consumo,
    original.id_movimiento,
    idReversion,
    `QA rollback reversion concurrencia ${Date.now()}`
  ]
);

describe('reversiones de inventario con guard PostgreSQL QA', { concurrency: false }, () => {
  it('rechaza entrada trazada mientras id_pedido_trazabilidad sea generado solo para SALIDA', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await createOriginalMovement(client);
      const qty = Number(original.cantidad);
      const firstQty = Number((qty * 0.6).toFixed(6));
      const secondQty = Number((qty * 0.6).toFixed(6));

      await assert.rejects(
        () => insertReturn(client, original, firstQty, 910000001),
        (error) => error.code === '23514' && error.constraint === 'ck_mov_inv_reversion_trace_complete'
      );
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });

  it('mantiene bloqueada incluso una devolucion exacta hasta alinear la columna generada', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await createOriginalMovement(client);
      const qty = Number(original.cantidad);
      await assert.rejects(
        () => insertReturn(client, original, qty, 910000003),
        (error) => error.code === '23514' && error.constraint === 'ck_mov_inv_reversion_trace_complete'
      );
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });
});
