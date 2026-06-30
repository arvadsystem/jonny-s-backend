import {
  buildSalsaConsumptionItemsFromPedidoDetails,
  loadLegacySalsaConsumptionByStockKey
} from './salsasPedidoSnapshotService.js';

const schemaColumnCache = new Map();

const parsePositiveInt = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  const normalized = String(value ?? '').trim();
  if (!/^0*[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const hasColumn = async (client, tableName, columnName) => {
  const key = `${String(tableName || '').trim().toLowerCase()}.${String(columnName || '').trim().toLowerCase()}`;
  if (schemaColumnCache.has(key)) return schemaColumnCache.get(key);

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );
  const exists = result.rowCount > 0;
  schemaColumnCache.set(key, exists);
  return exists;
};

const hasTable = async (client, tableName) => {
  const key = `table.${String(tableName || '').trim().toLowerCase()}`;
  if (schemaColumnCache.has(key)) return schemaColumnCache.get(key);

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  const exists = result.rowCount > 0;
  schemaColumnCache.set(key, exists);
  return exists;
};

export const buildPedidoConsumoPayload = async (client, idPedido, idSucursal) => {
  const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
  const detailsResult = await client.query(
    `
      SELECT
        dp.id_detalle_pedido,
        dp.id_producto,
        dp.id_receta,
        dp.cantidad,
        ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu' : 'NULL::jsonb AS configuracion_menu'}
      FROM public.detalle_pedido dp
      WHERE dp.id_pedido = $1
        AND COALESCE(dp.estado, true) = true
      ORDER BY dp.id_detalle_pedido
    `,
    [idPedido]
  );

  if (detailsResult.rowCount === 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: 'PEDIDO_SIN_DETALLE',
        message: 'No se pudo descontar inventario porque el pedido no tiene detalle valido.'
      }
    };
  }

  const items = detailsResult.rows
    .map((row) => {
      const idProducto = parsePositiveInt(row.id_producto);
      const idReceta = parsePositiveInt(row.id_receta);
      const quantity = parsePositiveInt(row.cantidad);
      const idDetallePedido = parsePositiveInt(row.id_detalle_pedido);

      if (idProducto) {
        return {
          tipo_item: 'PRODUCTO',
          id_item: idProducto,
          id_producto: idProducto,
          id_detalle_pedido: idDetallePedido,
          cantidad: quantity
        };
      }
      if (idReceta) {
        return {
          tipo_item: 'RECETA',
          id_item: idReceta,
          id_receta: idReceta,
          id_detalle_pedido: idDetallePedido,
          cantidad: quantity
        };
      }
      return null;
    })
    .filter(Boolean);

  const invalidQuantityRow = items.find((item) => !parsePositiveInt(item.cantidad));
  if (invalidQuantityRow) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: 'PEDIDO_CANTIDAD_INVALIDA',
        message: `La linea ${invalidQuantityRow.id_detalle_pedido || 'del pedido'} tiene cantidad invalida para descontar inventario.`
      }
    };
  }

  const extrasByDetalle = new Map();
  if (await hasTable(client, 'detalle_pedido_extras')) {
    const extraRowsResult = await client.query(
      `
        SELECT
          dpe.id_detalle_pedido,
          dpe.id_extra,
          dpe.codigo_extra_snapshot,
          dpe.nombre_extra_snapshot,
          COALESCE(dpe.cantidad, 0)::numeric AS cantidad,
          dpe.id_insumo,
          dpe.cant,
          dpe.id_unidad_medida,
          dpe.origen_snapshot
        FROM public.detalle_pedido_extras dpe
        INNER JOIN public.detalle_pedido dp
          ON dp.id_detalle_pedido = dpe.id_detalle_pedido
         AND dp.id_pedido = $1
         AND COALESCE(dp.estado, true) = true
        WHERE COALESCE(dpe.estado, true) = true
      `,
      [idPedido]
    );
    for (const row of extraRowsResult.rows) {
      const idDetallePedido = parsePositiveInt(row.id_detalle_pedido);
      const idExtra = parsePositiveInt(row.id_extra);
      const cantidad = Number(row.cantidad || 0);
      if (!idDetallePedido || !idExtra || cantidad <= 0) continue;
      const key = `${idDetallePedido}:${idExtra}`;
      extrasByDetalle.set(key, {
        id_detalle_pedido: idDetallePedido,
        id_extra: idExtra,
        codigo: row.codigo_extra_snapshot || row.origen_snapshot?.codigo || null,
        nombre: row.nombre_extra_snapshot || row.origen_snapshot?.nombre || null,
        cantidad,
        id_insumo: parsePositiveInt(row.id_insumo),
        cant: Number(row.cant || 0) || null,
        id_unidad_medida: parsePositiveInt(row.id_unidad_medida)
      });
    }
  }

  for (const row of detailsResult.rows) {
    const idDetallePedido = parsePositiveInt(row.id_detalle_pedido);
    if (!idDetallePedido) continue;
    const config = row.configuracion_menu && typeof row.configuracion_menu === 'object'
      ? row.configuracion_menu
      : null;
    const extras = Array.isArray(config?.extras) ? config.extras : [];
    for (const extra of extras) {
      const idExtra = parsePositiveInt(extra?.id_extra);
      const cantidad = Number(extra?.cantidad || 0);
      if (!idExtra || cantidad <= 0) continue;
      const key = `${idDetallePedido}:${idExtra}`;
      if (extrasByDetalle.has(key)) continue;
      extrasByDetalle.set(key, {
        id_detalle_pedido: idDetallePedido,
        id_extra: idExtra,
        codigo: String(extra?.codigo || '').trim() || null,
        nombre: String(extra?.nombre || '').trim() || null,
        cantidad,
        id_insumo: parsePositiveInt(extra?.id_insumo),
        cant: Number(extra?.cant ?? extra?.cantidad_insumo ?? 0) || null,
        id_unidad_medida: parsePositiveInt(extra?.id_unidad_medida)
      });
    }
  }

  for (const extra of extrasByDetalle.values()) {
    items.push({
      tipo_item: 'EXTRA',
      id_item: extra.id_extra,
      id_extra: extra.id_extra,
      id_detalle_pedido: extra.id_detalle_pedido,
      codigo: extra.codigo,
      nombre: extra.nombre,
      id_insumo: extra.id_insumo,
      cant: extra.cant,
      id_unidad_medida: extra.id_unidad_medida,
      cantidad: extra.cantidad
    });
  }

  const legacySalsaConsumption = await loadLegacySalsaConsumptionByStockKey(client, idPedido);
  const salsaConsumption = buildSalsaConsumptionItemsFromPedidoDetails(detailsResult.rows, {
    legacyConsumedByStockKey: legacySalsaConsumption
  });
  if (salsaConsumption.errors.length > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: salsaConsumption.errors[0].code || 'SALSA_SNAPSHOT_INVALIDO',
        message: salsaConsumption.errors[0].message || 'No se pudo validar el snapshot de inventario de salsas.',
        details: salsaConsumption.errors
      }
    };
  }
  items.push(...salsaConsumption.items);

  if (!items.length) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: 'PEDIDO_SIN_ITEMS_VALIDOS',
        message: 'No se pudo descontar inventario porque el pedido no tiene items validos para consumo.'
      }
    };
  }

  return {
    ok: true,
    payload: {
      id_sucursal: idSucursal,
      id_pedido: idPedido,
      items
    }
  };
};
