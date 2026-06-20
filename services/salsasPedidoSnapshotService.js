const toPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toPositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getSelections = (config) => {
  if (Array.isArray(config?.complementos)) return config.complementos;
  if (Array.isArray(config?.componentes?.seleccion)) return config.componentes.seleccion;
  return [];
};

const stockKey = (idInsumo, idAlmacen) => `${idInsumo}:${idAlmacen}`;

export const loadLegacySalsaConsumptionByStockKey = async (client, idPedido) => {
  const pedidoId = toPositiveInt(idPedido);
  if (!pedidoId) return new Map();

  const result = await client.query(
    `
      SELECT
        mi.id_insumo,
        mi.id_almacen,
        COALESCE(SUM(mi.cantidad), 0)::numeric AS cantidad
      FROM public.movimientos_inventario mi
      WHERE mi.tipo = 'SALIDA'
        AND mi.id_insumo IS NOT NULL
        AND (
          (mi.ref_origen = 'PEDIDO_PENDIENTE_SALSA' AND mi.id_ref = $1)
          OR (
            mi.ref_origen = 'VENTA_SALSA'
            AND mi.id_ref IN (
              SELECT f.id_factura
              FROM public.facturas f
              WHERE f.id_pedido = $1
            )
          )
        )
      GROUP BY mi.id_insumo, mi.id_almacen
    `,
    [pedidoId]
  );

  return new Map((result.rows || []).map((row) => [
    stockKey(Number(row.id_insumo), Number(row.id_almacen)),
    Number(row.cantidad || 0)
  ]));
};

export const buildSalsaConsumptionItemsFromPedidoDetails = (
  detailRows,
  { legacyConsumedByStockKey = new Map() } = {}
) => {
  const snapshots = [];
  const errors = [];
  const requiredByStockKey = new Map();
  const aggregateSnapshotsSeen = new Set();

  for (const row of Array.isArray(detailRows) ? detailRows : []) {
    const idDetallePedido = toPositiveInt(row?.id_detalle_pedido);
    const config = row?.configuracion_menu && typeof row.configuracion_menu === 'object'
      ? row.configuracion_menu
      : null;

    for (const selection of getSelections(config)) {
      const idSalsa = toPositiveInt(selection?.id_salsa || selection?.id_complemento);
      const snapshot = selection?.inventario;
      if (!idSalsa || !snapshot) continue;

      const idInsumo = toPositiveInt(snapshot.id_insumo_maestro || snapshot.id_insumo);
      const idAlmacen = toPositiveInt(snapshot.id_almacen);
      const idUnidadBase = toPositiveInt(snapshot.id_unidad_base);
      const cantidadBaseTotal = toPositiveNumber(snapshot.cantidad_base_total);
      if (!idInsumo || !idAlmacen || !idUnidadBase || !cantidadBaseTotal) {
        errors.push({
          id_detalle_pedido: idDetallePedido,
          id_salsa: idSalsa,
          code: 'SALSA_SNAPSHOT_INCOMPLETO',
          message: `La salsa #${idSalsa} no tiene un snapshot de inventario completo.`
        });
        continue;
      }

      const aggregateKey = `${idDetallePedido}:${idSalsa}`;
      if (Number(snapshot.porciones || 0) > 1) {
        if (aggregateSnapshotsSeen.has(aggregateKey)) continue;
        aggregateSnapshotsSeen.add(aggregateKey);
      }

      const key = stockKey(idInsumo, idAlmacen);
      requiredByStockKey.set(key, Number(requiredByStockKey.get(key) || 0) + cantidadBaseTotal);
      snapshots.push({
        tipo_item: 'SALSA',
        id_item: idSalsa,
        id_salsa: idSalsa,
        id_detalle_pedido: idDetallePedido,
        id_insumo: idInsumo,
        id_almacen: idAlmacen,
        id_unidad_medida: idUnidadBase,
        nombre: String(snapshot.nombre || selection?.nombre || `Salsa #${idSalsa}`).trim(),
        cantidad: cantidadBaseTotal,
        snapshot
      });
    }
  }

  const skippedKeys = new Set();
  for (const [key, required] of requiredByStockKey.entries()) {
    const consumed = Number(legacyConsumedByStockKey.get(key) || 0);
    if (consumed <= 0) continue;
    if (consumed + 0.000001 >= required) {
      skippedKeys.add(key);
      continue;
    }
    errors.push({
      code: 'SALSA_CONSUMO_LEGACY_PARCIAL',
      message: `El consumo historico de salsa (${consumed}) no coincide con el snapshot requerido (${required}).`
    });
  }

  return {
    items: snapshots.filter((item) => !skippedKeys.has(stockKey(item.id_insumo, item.id_almacen))),
    errors,
    legacy_skipped_stock_keys: [...skippedKeys]
  };
};
