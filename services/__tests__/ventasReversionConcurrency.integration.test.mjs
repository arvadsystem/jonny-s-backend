import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 6
});

after(async () => {
  await pool.end();
});

const createOriginalMovement = async (client, overrides = {}) => {
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
    ORDER BY dp.id_detalle_pedido DESC, ia.id_insumo, ia.id_almacen
    LIMIT 1
  `);
  assert.equal(result.rowCount, 1, 'QA debe tener una linea de pedido y un insumo por almacen');
  const target = result.rows[0];
  const idPedido = Number(overrides.id_ref || target.id_pedido);
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
        id_pedido_trazabilidad,
        descripcion
      )
      VALUES ('SALIDA', 10.000000, $1, $2, $3, 'RECETA', 'PEDIDO', $4, $4, 'QA rollback salida original reversion')
      RETURNING id_movimiento, cantidad, id_almacen, id_producto, id_insumo, id_detalle_pedido, origen_consumo, id_ref, id_pedido_trazabilidad, saldo_antes, saldo_despues
    `,
    [target.id_almacen, overrides.id_insumo || target.id_insumo, overrides.id_detalle_pedido || target.id_detalle_pedido, idPedido]
  );
  const original = inserted.rows[0];
  assert.equal(Number(original.id_pedido_trazabilidad), Number(original.id_ref));
  return original;
};

const insertReturn = (client, original, cantidad, idReversion, overrides = {}) => client.query(
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
    RETURNING id_movimiento, cantidad, id_almacen, id_producto, id_insumo, id_detalle_pedido, origen_consumo, id_movimiento_origen, id_pedido_trazabilidad, saldo_antes, saldo_despues
  `,
  [
    cantidad,
    overrides.id_almacen || original.id_almacen,
    overrides.id_producto ?? original.id_producto ?? null,
    overrides.id_insumo ?? original.id_insumo ?? null,
    overrides.id_detalle_pedido || original.id_detalle_pedido,
    overrides.origen_consumo || original.origen_consumo,
    original.id_movimiento,
    idReversion,
    `QA rollback reversion ${idReversion}`
  ]
);

describe('reversiones de inventario con guard PostgreSQL QA', { concurrency: false }, () => {
  it('permite reversion parcial y final heredando trazabilidad fisica', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await createOriginalMovement(client);

      const partial = await insertReturn(client, original, 4, 910000001);
      assert.equal(Number(partial.rows[0].id_movimiento_origen), Number(original.id_movimiento));
      assert.equal(Number(partial.rows[0].id_almacen), Number(original.id_almacen));
      assert.equal(Number(partial.rows[0].id_insumo), Number(original.id_insumo));
      assert.equal(Number(partial.rows[0].id_detalle_pedido), Number(original.id_detalle_pedido));
      assert.equal(String(partial.rows[0].origen_consumo), String(original.origen_consumo));
      assert.equal(Number(partial.rows[0].id_pedido_trazabilidad), Number(original.id_pedido_trazabilidad));
      assert.equal(Number(partial.rows[0].saldo_despues) - Number(partial.rows[0].saldo_antes), 4);

      const final = await insertReturn(client, original, 6, 910000002);
      assert.equal(Number(final.rows[0].id_pedido_trazabilidad), Number(original.id_pedido_trazabilidad));

      const totals = await client.query(
        `
          SELECT COALESCE(SUM(cantidad), 0)::numeric AS returned
          FROM public.movimientos_inventario
          WHERE id_movimiento_origen = $1
            AND ref_origen = 'REVERSION_VENTA_INVENTARIO'
        `,
        [original.id_movimiento]
      );
      assert.equal(Number(totals.rows[0].returned), 10);
      assert.equal(Number(final.rows[0].saldo_despues), Number(original.saldo_antes));
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });

  it('bloquea sobredevolucion con REVERSION_OVER_RETURN', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await createOriginalMovement(client);

      await assert.rejects(
        () => insertReturn(client, original, 11, 910000003),
        (error) => error.code === '23514' && /REVERSION_OVER_RETURN/i.test(`${error.message} ${error.detail}`)
      );
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });

  it('bloquea devolucion adicional cuando ya fue devuelto completamente', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await createOriginalMovement(client);

      await insertReturn(client, original, 10, 910000004);
      await assert.rejects(
        () => insertReturn(client, original, 1, 910000005),
        (error) => /REVERSION_ALREADY_FULLY_RETURNED|REVERSION_OVER_RETURN/i.test(`${error.message} ${error.detail}`)
      );
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });

  it('bloquea recurso, almacen y detalle diferentes como traza invalida', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await createOriginalMovement(client);

      await client.query('SAVEPOINT invalid_resource');
      await assert.rejects(
        () => insertReturn(client, original, 1, 910000006, { id_insumo: Number(original.id_insumo) + 1000000 }),
        (error) => /REVERSION_TRACE_INVALID|TRACE_INVALID/i.test(`${error.message} ${error.detail}`)
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid_resource');

      await client.query('SAVEPOINT invalid_warehouse');
      await assert.rejects(
        () => insertReturn(client, original, 1, 910000007, { id_almacen: Number(original.id_almacen) + 1000000 }),
        (error) => /REVERSION_TRACE_INVALID|TRACE_INVALID/i.test(`${error.message} ${error.detail}`)
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid_warehouse');

      await client.query('SAVEPOINT invalid_detail');
      await assert.rejects(
        () => insertReturn(client, original, 1, 910000008, { id_detalle_pedido: Number(original.id_detalle_pedido) + 1000000 }),
        (error) => /REVERSION_TRACE_INVALID|TRACE_INVALID/i.test(`${error.message} ${error.detail}`)
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid_detail');
    } finally {
      try { await client.query('ROLLBACK'); } catch {}
      client.release();
    }
  });
});
