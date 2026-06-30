const APPLY = String(process.env.SALSAS_INVENTORY_QA_APPLY || '').trim() === '1';

if (!APPLY) {
  console.log('[qa:salsas-inventory] SKIP: define SALSAS_INVENTORY_QA_APPLY=1 para ejecutar la prueba transaccional.');
  console.log('[qa:salsas-inventory] El script no aplica migraciones y usa BEGIN/ROLLBACK cuando se habilita.');
  process.exit(0);
}

const assertEqual = (actual, expected, label) => {
  if (Number(actual) !== Number(expected)) {
    throw new Error(`${label}: esperado ${expected}, recibido ${actual}`);
  }
};

const main = async () => {
  const { default: pool, closePool } = await import('../config/db-connection.js');
  const {
    consumeSalsasInventoryFromSnapshots,
    restoreSalsasInventoryFromSnapshots
  } = await import('../routers/ventas/services/salsasInventoryService.js');

  const client = await pool.connect();
  const refId = Number(String(Date.now()).slice(-9));
  try {
    await client.query('BEGIN');

    const triggerResult = await client.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_trigger t
          INNER JOIN pg_class c ON c.oid = t.tgrelid
          INNER JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'movimientos_inventario'
            AND t.tgname = 'tr_mov_inv_apply_stock'
            AND NOT t.tgisinternal
            AND t.tgenabled <> 'D'
        ) AS exists
      `
    );
    if (triggerResult.rows?.[0]?.exists !== true) {
      throw new Error('No existe o no esta activo el trigger public.tr_mov_inv_apply_stock.');
    }

    const stockRowResult = await client.query(
      `
        SELECT ia.id_insumo, ia.id_almacen
        FROM public.insumos_almacenes ia
        INNER JOIN public.insumos i
          ON i.id_insumo = ia.id_insumo
         AND COALESCE(i.estado, true) = true
        INNER JOIN public.almacenes a
          ON a.id_almacen = ia.id_almacen
         AND COALESCE(a.estado, true) = true
        WHERE COALESCE(ia.estado, true) = true
        ORDER BY ia.id_almacen, ia.id_insumo
        LIMIT 1
        FOR UPDATE OF ia
      `
    );
    if (!stockRowResult.rowCount) {
      throw new Error('No hay una fila activa en public.insumos_almacenes para ejecutar QA.');
    }

    const stockRow = stockRowResult.rows[0];
    const idInsumo = Number(stockRow.id_insumo);
    const idAlmacen = Number(stockRow.id_almacen);
    const lines = [{
      salsas_inventario_snapshot: [{
        id_insumo: idInsumo,
        id_almacen: idAlmacen,
        cantidad_base_total: 2,
        nombre: 'QA salsa trigger'
      }]
    }];

    await client.query(
      `
        UPDATE public.insumos_almacenes
        SET cantidad = 100
        WHERE id_insumo = $1
          AND id_almacen = $2
      `,
      [idInsumo, idAlmacen]
    );

    await consumeSalsasInventoryFromSnapshots({
      client,
      lines,
      idReferencia: refId,
      refOrigen: 'QA_SALSA_TRIGGER',
      descripcion: 'QA salida salsa trigger'
    });

    const afterSale = await client.query(
      'SELECT cantidad FROM public.insumos_almacenes WHERE id_insumo = $1 AND id_almacen = $2',
      [idInsumo, idAlmacen]
    );
    assertEqual(afterSale.rows?.[0]?.cantidad, 98, 'stock despues de SALIDA');

    const salida = await client.query(
      `
        SELECT saldo_antes, saldo_despues
        FROM public.movimientos_inventario
        WHERE ref_origen = 'QA_SALSA_TRIGGER'
          AND id_ref = $1
          AND tipo = 'SALIDA'
          AND id_insumo = $2
          AND id_almacen = $3
        ORDER BY id_movimiento DESC
        LIMIT 1
      `,
      [refId, idInsumo, idAlmacen]
    );
    assertEqual(salida.rows?.[0]?.saldo_antes, 100, 'SALIDA saldo_antes');
    assertEqual(salida.rows?.[0]?.saldo_despues, 98, 'SALIDA saldo_despues');

    await restoreSalsasInventoryFromSnapshots({
      client,
      snapshots: lines[0].salsas_inventario_snapshot,
      idReversion: refId,
      codigoReversion: 'QA-SALSA',
      codigoVenta: `QA-${refId}`
    });

    const afterRestore = await client.query(
      'SELECT cantidad FROM public.insumos_almacenes WHERE id_insumo = $1 AND id_almacen = $2',
      [idInsumo, idAlmacen]
    );
    assertEqual(afterRestore.rows?.[0]?.cantidad, 100, 'stock despues de ENTRADA');

    const entrada = await client.query(
      `
        SELECT saldo_antes, saldo_despues
        FROM public.movimientos_inventario
        WHERE ref_origen = 'REVERSION_VENTA_SALSA'
          AND id_ref = $1
          AND tipo = 'ENTRADA'
          AND id_insumo = $2
          AND id_almacen = $3
        ORDER BY id_movimiento DESC
        LIMIT 1
      `,
      [refId, idInsumo, idAlmacen]
    );
    assertEqual(entrada.rows?.[0]?.saldo_antes, 98, 'ENTRADA saldo_antes');
    assertEqual(entrada.rows?.[0]?.saldo_despues, 100, 'ENTRADA saldo_despues');

    await client.query('SAVEPOINT salsa_stock_insuficiente');
    await client.query(
      'UPDATE public.insumos_almacenes SET cantidad = 1 WHERE id_insumo = $1 AND id_almacen = $2',
      [idInsumo, idAlmacen]
    );
    let insufficientFailed = false;
    try {
      await consumeSalsasInventoryFromSnapshots({
        client,
        lines,
        idReferencia: refId + 1,
        refOrigen: 'QA_SALSA_TRIGGER_INSUFICIENTE',
        descripcion: 'QA stock insuficiente salsa trigger'
      });
    } catch (error) {
      insufficientFailed = error?.code === 'VENTAS_SALSA_STOCK_INSUFICIENTE';
    }
    await client.query('ROLLBACK TO SAVEPOINT salsa_stock_insuficiente');
    if (!insufficientFailed) {
      throw new Error('Stock insuficiente no produjo VENTAS_SALSA_STOCK_INSUFICIENTE.');
    }
    const afterRollback = await client.query(
      'SELECT cantidad FROM public.insumos_almacenes WHERE id_insumo = $1 AND id_almacen = $2',
      [idInsumo, idAlmacen]
    );
    assertEqual(afterRollback.rows?.[0]?.cantidad, 100, 'stock despues de rollback por insuficiencia');

    const fixtureContext = await client.query(
      `
        SELECT
          (SELECT id_estado_pedido FROM public.estados_pedido ORDER BY id_estado_pedido LIMIT 1) AS id_estado_pedido,
          (SELECT id_sucursal FROM public.almacenes WHERE id_almacen = $1 LIMIT 1) AS id_sucursal,
          (SELECT id_usuario FROM public.usuarios ORDER BY id_usuario LIMIT 1) AS id_usuario
      `,
      [idAlmacen]
    );
    const fixture = fixtureContext.rows?.[0] || {};
    if (!fixture.id_estado_pedido || !fixture.id_sucursal || !fixture.id_usuario) {
      throw new Error('No se pudo resolver fixture minimo de pedido para probar PEDIDO/FALTANTE_COCINA.');
    }
    const pedidoFixture = await client.query(
      `
        INSERT INTO public.pedidos (
          descripcion_pedido,
          fecha_hora_pedido,
          sub_total,
          isv,
          total,
          id_estado_pedido,
          id_sucursal,
          id_usuario,
          origen_pedido
        )
        VALUES ($1, CURRENT_TIMESTAMP, 1, 0, 1, $2, $3, $4, 'QA_SALSA_INVENTORY')
        RETURNING id_pedido
      `,
      [`QA salsa inventory ${refId}`, fixture.id_estado_pedido, fixture.id_sucursal, fixture.id_usuario]
    );
    const idPedidoFixture = Number(pedidoFixture.rows?.[0]?.id_pedido || 0);
    const detalleFixture = await client.query(
      `
        INSERT INTO public.detalle_pedido (
          sub_total_pedido,
          total_pedido,
          id_pedido,
          estado,
          observacion
        )
        VALUES (1, 1, $1, true, $2)
        RETURNING id_detalle_pedido
      `,
      [idPedidoFixture, `QA salsa inventory ${refId}`]
    );
    const idDetallePedido = Number(detalleFixture.rows?.[0]?.id_detalle_pedido || 0);

    for (const refOrigen of ['PEDIDO', 'FALTANTE_COCINA']) {
      await client.query(`SAVEPOINT salsa_negative_${refOrigen.toLowerCase()}`);
      await client.query(
        'UPDATE public.insumos_almacenes SET cantidad = 1 WHERE id_insumo = $1 AND id_almacen = $2',
        [idInsumo, idAlmacen]
      );
      await client.query(
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
          VALUES ('SALIDA', 2, $1, $2, $3, 'SALSA', $4, $5, $5, $6)
        `,
        [idAlmacen, idInsumo, idDetallePedido, refOrigen, idPedidoFixture, `QA stock negativo salsa ${refOrigen}`]
      );
      const negativeStock = await client.query(
        'SELECT cantidad FROM public.insumos_almacenes WHERE id_insumo = $1 AND id_almacen = $2',
        [idInsumo, idAlmacen]
      );
      assertEqual(negativeStock.rows?.[0]?.cantidad, -1, `stock negativo permitido para ${refOrigen}`);
      const negativeMovement = await client.query(
        `
          SELECT saldo_antes, saldo_despues
          FROM public.movimientos_inventario
          WHERE ref_origen = $1
            AND id_ref = $2
            AND tipo = 'SALIDA'
            AND id_insumo = $3
            AND id_almacen = $4
          ORDER BY id_movimiento DESC
          LIMIT 1
        `,
        [refOrigen, idPedidoFixture, idInsumo, idAlmacen]
      );
      assertEqual(negativeMovement.rows?.[0]?.saldo_antes, 1, `${refOrigen} saldo_antes`);
      assertEqual(negativeMovement.rows?.[0]?.saldo_despues, -1, `${refOrigen} saldo_despues`);
      await client.query(`ROLLBACK TO SAVEPOINT salsa_negative_${refOrigen.toLowerCase()}`);
    }

    await client.query('ROLLBACK');
    console.log('[qa:salsas-inventory] OK: trigger aplica 100->98->100, bloquea origen arbitrario y permite negativos para PEDIDO/FALTANTE_COCINA.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await closePool();
  }
};

main().catch((error) => {
  console.error('[qa:salsas-inventory] FAIL:', error?.message || error);
  process.exitCode = 1;
});
