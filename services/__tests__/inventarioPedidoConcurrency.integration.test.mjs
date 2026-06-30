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

const findTraceTarget = async (client) => {
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
  assert.equal(result.rowCount, 1, 'QA debe tener una linea de pedido y un insumo por almacen');
  return result.rows[0];
};

const insertPedidoSalida = (client, target, idRefOffset = 0) => client.query(
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
    VALUES ('SALIDA', 0.000001, $1, $2, $3, 'RECETA', 'PEDIDO', $4, $5)
    RETURNING id_movimiento, id_ref, id_pedido_trazabilidad
  `,
  [
    target.id_almacen,
    target.id_insumo,
    target.id_detalle_pedido,
    Number(target.id_pedido) + idRefOffset,
    `QA rollback concurrencia descuento ${Date.now()}`
  ]
);

describe('descuento de pedido con trazabilidad PostgreSQL QA', { concurrency: false }, () => {
  it('bloquea doble salida identica por constraint trazada sin dejar residuos', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await findTraceTarget(client);

      await insertPedidoSalida(client, target);
      await assert.rejects(
        () => insertPedidoSalida(client, target),
        (error) => error.code === '23505' && [
          'ux_mov_inv_linea_salida_insumo',
          'ux_mov_inv_linea_salida_producto'
        ].includes(error.constraint)
      );
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });

  it('genera id_pedido_trazabilidad desde id_ref para salidas trazadas', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await findTraceTarget(client);
      const inserted = await insertPedidoSalida(client, target);
      assert.equal(Number(inserted.rows[0].id_pedido_trazabilidad), Number(inserted.rows[0].id_ref));
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });
});
