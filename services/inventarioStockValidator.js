import { toPositiveInt } from './pedidoPayloadValidator.js';
import { isCatalogoMaestroReadsEnabled } from './catalogoMaestroReadService.js';

// Validador de stock + concurrencia (locks FOR UPDATE).
// -----------------------------------------------------
// QUE HACE:
// - Bloquea filas de productos e insumos antes de validar.
// - Revisa existencia, estado, almacen y suficiencia de stock.
// - Valida que los almacenes pertenezcan a la sucursal del pedido.
//
// PROBLEMA QUE RESUELVE:
// - Evita descuentos inconsistentes por llamadas simultaneas.
// - Evita descuentos en almacenes/sucursales incorrectas.

const mapById = (rows, fieldName) => {
  const map = new Map();
  for (const row of rows || []) {
    const id = Number(row?.[fieldName] || 0);
    if (id > 0) map.set(id, row);
  }
  return map;
};

const hasEnoughStock = (cantidadActual, stockMinimo, required) => {
  const actual = Number(cantidadActual || 0);
  const minimo = Number(stockMinimo || 0);
  const disponible = actual - minimo;
  return disponible >= Number(required || 0);
};

const buildShortage = ({
  tipo_recurso,
  id_recurso,
  nombre,
  cantidad_actual,
  stock_minimo,
  requerido,
  motivo
}) => {
  const actual = Number(cantidad_actual || 0);
  const minimo = Number(stock_minimo || 0);
  const req = Number(requerido || 0);
  const disponible = Math.max(actual - minimo, 0);

  return {
    tipo_recurso,
    id_recurso,
    ...(tipo_recurso === 'producto' ? { id_producto: id_recurso } : {}),
    ...(tipo_recurso === 'insumo' ? { id_insumo: id_recurso } : {}),
    nombre,
    motivo,
    requerido: req,
    disponible,
    faltante: Math.max(req - disponible, 0),
    cantidad_actual: actual,
    stock_minimo: minimo,
    mensaje: `Stock insuficiente para ${tipo_recurso} ${nombre || id_recurso}. Requerido: ${req}, disponible: ${disponible}.`
  };
};

const fetchProductosByIdsForUpdate = async (client, ids) => {
  if (!ids.length) return [];
  const rs = await client.query(
    `
      SELECT
        p.id_producto,
        p.nombre_producto,
        COALESCE(p.estado, true) AS estado,
        COALESCE(p.cantidad, 0)::numeric AS cantidad,
        COALESCE(p.stock_minimo, 0)::numeric AS stock_minimo,
        p.id_almacen
      FROM public.productos p
      WHERE p.id_producto = ANY($1::int[])
      ORDER BY p.id_producto
      FOR UPDATE
    `,
    [ids]
  );
  return rs.rows;
};

const fetchInsumosByIdsForUpdate = async (client, ids) => {
  if (!ids.length) return [];
  const rs = await client.query(
    `
      SELECT
        i.id_insumo,
        i.nombre_insumo,
        COALESCE(i.estado, true) AS estado,
        COALESCE(i.cantidad, 0)::numeric AS cantidad,
        COALESCE(i.stock_minimo, 0)::numeric AS stock_minimo,
        i.id_almacen
      FROM public.insumos i
      WHERE i.id_insumo = ANY($1::int[])
      ORDER BY i.id_insumo
      FOR UPDATE
    `,
    [ids]
  );
  return rs.rows;
};

const fetchInsumosMaestrosByIdsForUpdate = async (client, ids, idSucursal) => {
  if (!ids.length) {
    return {
      rows: [],
      missingIds: new Set(),
      inactiveIds: new Set(),
      unassignedIds: new Set(),
      ambiguousIds: new Set(),
      mastersById: new Map()
    };
  }

  const mastersResult = await client.query(
    `
      SELECT
        i.id_insumo,
        i.nombre_insumo,
        COALESCE(i.estado, true) AS estado
      FROM public.insumos i
      WHERE i.id_insumo = ANY($1::int[])
      ORDER BY i.id_insumo
    `,
    [ids]
  );
  const mastersById = mapById(mastersResult.rows, 'id_insumo');
  const missingIds = new Set();
  const inactiveIds = new Set();
  const activeMasterIds = [];

  for (const id of ids) {
    const master = mastersById.get(id);
    if (!master) {
      missingIds.add(id);
      continue;
    }
    if (!Boolean(master.estado)) {
      inactiveIds.add(id);
      continue;
    }
    activeMasterIds.push(id);
  }

  if (!activeMasterIds.length) {
    return {
      rows: [],
      missingIds,
      inactiveIds,
      unassignedIds: new Set(),
      ambiguousIds: new Set(),
      mastersById
    };
  }

  const assignmentsResult = await client.query(
    `
      SELECT
        mm.id_insumo_maestro,
        COUNT(*)::int AS total_asignaciones
      FROM public.insumos_mapeo_maestro mm
      INNER JOIN public.almacenes a
        ON a.id_almacen = mm.id_almacen_origen
       AND a.id_sucursal = $2
       AND COALESCE(a.estado, true) = true
      INNER JOIN public.insumos_almacenes ia
        ON ia.id_insumo = mm.id_insumo_maestro
       AND ia.id_almacen = mm.id_almacen_origen
       AND COALESCE(ia.estado, true) = true
      WHERE mm.id_insumo_maestro = ANY($1::int[])
      GROUP BY mm.id_insumo_maestro
    `,
    [activeMasterIds, idSucursal]
  );
  const assignmentCountsById = new Map(
    (assignmentsResult.rows || []).map((row) => [
      Number(row.id_insumo_maestro),
      Number(row.total_asignaciones || 0)
    ])
  );
  const unassignedIds = new Set();
  const ambiguousIds = new Set();
  const uniqueMasterIds = [];

  for (const id of activeMasterIds) {
    const count = assignmentCountsById.get(id) || 0;
    if (count === 0) {
      unassignedIds.add(id);
      continue;
    }
    if (count > 1) {
      ambiguousIds.add(id);
      continue;
    }
    uniqueMasterIds.push(id);
  }

  if (!uniqueMasterIds.length) {
    return {
      rows: [],
      missingIds,
      inactiveIds,
      unassignedIds,
      ambiguousIds,
      mastersById
    };
  }

  const localRowsResult = await client.query(
    `
      SELECT
        mm.id_insumo_maestro AS id_insumo,
        mm.id_insumo_maestro,
        mm.id_insumo_legacy AS id_insumo_legacy_local,
        i.nombre_insumo,
        COALESCE(ia.cantidad, 0)::numeric AS cantidad,
        COALESCE(ia.stock_minimo, 0)::numeric AS stock_minimo,
        ia.id_almacen,
        a.id_sucursal,
        COALESCE(ia.estado, true) AS estado
      FROM public.insumos_mapeo_maestro mm
      INNER JOIN public.almacenes a
        ON a.id_almacen = mm.id_almacen_origen
       AND a.id_sucursal = $2
       AND COALESCE(a.estado, true) = true
      INNER JOIN public.insumos_almacenes ia
        ON ia.id_insumo = mm.id_insumo_maestro
       AND ia.id_almacen = mm.id_almacen_origen
       AND COALESCE(ia.estado, true) = true
      INNER JOIN public.insumos i
        ON i.id_insumo = mm.id_insumo_maestro
      WHERE mm.id_insumo_maestro = ANY($1::int[])
      ORDER BY mm.id_insumo_maestro
      FOR UPDATE OF ia
    `,
    [uniqueMasterIds, idSucursal]
  );
  const lockedMasterIds = new Set(
    (localRowsResult.rows || []).map((row) => Number(row.id_insumo_maestro || 0)).filter((id) => id > 0)
  );
  for (const id of uniqueMasterIds) {
    if (!lockedMasterIds.has(id)) unassignedIds.add(id);
  }

  return {
    rows: localRowsResult.rows || [],
    missingIds,
    inactiveIds,
    unassignedIds,
    ambiguousIds,
    mastersById
  };
};

const fetchAlmacenesByIds = async (client, ids) => {
  if (!ids.length) return [];
  const rs = await client.query(
    `
      SELECT
        a.id_almacen,
        a.id_sucursal,
        COALESCE(a.estado, true) AS estado
      FROM public.almacenes a
      WHERE a.id_almacen = ANY($1::int[])
    `,
    [ids]
  );
  return rs.rows;
};

export const validarStockConBloqueo = async ({
  client,
  idSucursal,
  productoQtyMap,
  insumoQtyMap,
  allowCrossBranchWarehouse = false
}) => {
  const faltantes = [];
  const advertencias = [];
  const excludedProductIds = new Set();
  const excludedInsumoIds = new Set();

  const productoIds = [...productoQtyMap.keys()].sort((a, b) => a - b);
  const insumoIds = [...insumoQtyMap.keys()].sort((a, b) => a - b);
  const useCatalogoMaestroInsumos = isCatalogoMaestroReadsEnabled();

  const [productosRows, insumosFetchResult] = await Promise.all([
    fetchProductosByIdsForUpdate(client, productoIds),
    useCatalogoMaestroInsumos
      ? fetchInsumosMaestrosByIdsForUpdate(client, insumoIds, idSucursal)
      : fetchInsumosByIdsForUpdate(client, insumoIds)
  ]);
  const insumosRows = useCatalogoMaestroInsumos ? insumosFetchResult.rows : insumosFetchResult;

  const productosById = mapById(productosRows, 'id_producto');
  const insumosById = mapById(insumosRows, 'id_insumo');

  for (const idProducto of productoIds) {
    const row = productosById.get(idProducto);
    if (!row) {
      excludedProductIds.add(idProducto);
      faltantes.push({
        tipo_recurso: 'producto',
        id_recurso: idProducto,
        id_producto: idProducto,
        motivo: 'PRODUCTO_NO_ENCONTRADO',
        mensaje: `El producto ${idProducto} no existe o no esta disponible para inventario.`
      });
      continue;
    }
    if (!Boolean(row.estado)) {
      excludedProductIds.add(idProducto);
      faltantes.push({
        tipo_recurso: 'producto',
        id_recurso: idProducto,
        id_producto: idProducto,
        nombre: row.nombre_producto,
        motivo: 'PRODUCTO_INACTIVO',
        mensaje: `El producto ${row.nombre_producto || idProducto} esta inactivo.`
      });
    }
    if (!toPositiveInt(row.id_almacen)) {
      excludedProductIds.add(idProducto);
      faltantes.push({
        tipo_recurso: 'producto',
        id_recurso: idProducto,
        id_producto: idProducto,
        nombre: row.nombre_producto,
        motivo: 'PRODUCTO_SIN_ALMACEN',
        mensaje: `El producto ${row.nombre_producto || idProducto} no tiene almacen configurado.`
      });
    }
  }

  for (const idInsumo of insumoIds) {
    if (useCatalogoMaestroInsumos) {
      const master = insumosFetchResult.mastersById?.get(idInsumo);
      if (insumosFetchResult.missingIds?.has(idInsumo)) {
        excludedInsumoIds.add(idInsumo);
        faltantes.push({
          tipo_recurso: 'insumo',
          id_recurso: idInsumo,
          id_insumo: idInsumo,
          motivo: 'INSUMO_NO_ENCONTRADO',
          mensaje: `El insumo ${idInsumo} no existe o no esta disponible para inventario.`
        });
        continue;
      }
      if (insumosFetchResult.inactiveIds?.has(idInsumo)) {
        excludedInsumoIds.add(idInsumo);
        faltantes.push({
          tipo_recurso: 'insumo',
          id_recurso: idInsumo,
          id_insumo: idInsumo,
          nombre: master?.nombre_insumo,
          motivo: 'INSUMO_INACTIVO',
          mensaje: `El insumo ${master?.nombre_insumo || idInsumo} esta inactivo.`
        });
        continue;
      }
      if (insumosFetchResult.unassignedIds?.has(idInsumo)) {
        excludedInsumoIds.add(idInsumo);
        faltantes.push({
          tipo_recurso: 'insumo',
          id_recurso: idInsumo,
          id_insumo: idInsumo,
          nombre: master?.nombre_insumo,
          motivo: 'INSUMO_MAESTRO_SIN_ASIGNACION_SUCURSAL',
          mensaje: 'El insumo maestro no tiene una asignacion activa en la sucursal del pedido.'
        });
        continue;
      }
      if (insumosFetchResult.ambiguousIds?.has(idInsumo)) {
        excludedInsumoIds.add(idInsumo);
        faltantes.push({
          tipo_recurso: 'insumo',
          id_recurso: idInsumo,
          id_insumo: idInsumo,
          nombre: master?.nombre_insumo,
          motivo: 'INSUMO_MAESTRO_ASIGNACION_AMBIGUA',
          mensaje: 'El insumo maestro tiene mas de una asignacion activa en la sucursal.'
        });
        continue;
      }
    }

    const row = insumosById.get(idInsumo);
    if (!row) {
      excludedInsumoIds.add(idInsumo);
      faltantes.push({
        tipo_recurso: 'insumo',
        id_recurso: idInsumo,
        id_insumo: idInsumo,
        motivo: 'INSUMO_NO_ENCONTRADO',
        mensaje: `El insumo ${idInsumo} no existe o no esta disponible para inventario.`
      });
      continue;
    }
    if (!Boolean(row.estado)) {
      excludedInsumoIds.add(idInsumo);
      faltantes.push({
        tipo_recurso: 'insumo',
        id_recurso: idInsumo,
        id_insumo: idInsumo,
        nombre: row.nombre_insumo,
        motivo: 'INSUMO_INACTIVO',
        mensaje: `El insumo ${row.nombre_insumo || idInsumo} esta inactivo.`
      });
    }
    if (!toPositiveInt(row.id_almacen)) {
      excludedInsumoIds.add(idInsumo);
      faltantes.push({
        tipo_recurso: 'insumo',
        id_recurso: idInsumo,
        id_insumo: idInsumo,
        nombre: row.nombre_insumo,
        motivo: 'INSUMO_SIN_ALMACEN',
        mensaje: `El insumo ${row.nombre_insumo || idInsumo} no tiene almacen configurado.`
      });
    }
  }

  const almacenesEnUso = new Set();
  for (const row of productosRows) {
    const almacenId = toPositiveInt(row?.id_almacen);
    if (almacenId) almacenesEnUso.add(almacenId);
  }
  for (const row of insumosRows) {
    const almacenId = toPositiveInt(row?.id_almacen);
    if (almacenId) almacenesEnUso.add(almacenId);
  }

  const almacenesRows = await fetchAlmacenesByIds(client, [...almacenesEnUso].sort((a, b) => a - b));
  const almacenesById = mapById(almacenesRows, 'id_almacen');
  const productoIdsByAlmacen = new Map();
  const insumoIdsByAlmacen = new Map();

  for (const row of productosRows) {
    const almacenId = toPositiveInt(row?.id_almacen);
    const idProducto = toPositiveInt(row?.id_producto);
    if (!almacenId || !idProducto) continue;
    if (!productoIdsByAlmacen.has(almacenId)) productoIdsByAlmacen.set(almacenId, []);
    productoIdsByAlmacen.get(almacenId).push(idProducto);
  }
  for (const row of insumosRows) {
    const almacenId = toPositiveInt(row?.id_almacen);
    const idInsumo = toPositiveInt(row?.id_insumo);
    if (!almacenId || !idInsumo) continue;
    if (!insumoIdsByAlmacen.has(almacenId)) insumoIdsByAlmacen.set(almacenId, []);
    insumoIdsByAlmacen.get(almacenId).push(idInsumo);
  }

  const excludeResourcesByWarehouse = (idAlmacen) => {
    for (const idProducto of productoIdsByAlmacen.get(idAlmacen) || []) {
      excludedProductIds.add(idProducto);
    }
    for (const idInsumo of insumoIdsByAlmacen.get(idAlmacen) || []) {
      excludedInsumoIds.add(idInsumo);
    }
  };

  for (const idAlmacen of almacenesEnUso) {
    const almacen = almacenesById.get(idAlmacen);
    if (!almacen) {
      excludeResourcesByWarehouse(idAlmacen);
      faltantes.push({
        tipo_recurso: 'almacen',
        id_recurso: idAlmacen,
        id_almacen: idAlmacen,
        motivo: 'ALMACEN_NO_ENCONTRADO',
        mensaje: `El almacen ${idAlmacen} no existe.`
      });
      continue;
    }
    if (!Boolean(almacen.estado)) {
      excludeResourcesByWarehouse(idAlmacen);
      faltantes.push({
        tipo_recurso: 'almacen',
        id_recurso: idAlmacen,
        id_almacen: idAlmacen,
        motivo: 'ALMACEN_INACTIVO',
        mensaje: `El almacen ${idAlmacen} esta inactivo.`
      });
    }
    if (Number(almacen.id_sucursal || 0) !== Number(idSucursal)) {
      excludeResourcesByWarehouse(idAlmacen);
      const warning = {
        tipo_recurso: 'almacen',
        id_recurso: idAlmacen,
        id_almacen: idAlmacen,
        motivo: 'ALMACEN_DE_OTRA_SUCURSAL',
        mensaje: `El almacen ${idAlmacen} no pertenece a la sucursal del pedido; no se descuenta desde otra sucursal.`
      };
      if (allowCrossBranchWarehouse) {
        advertencias.push(warning);
      } else {
        faltantes.push(warning);
      }
    }
  }

  for (const idProducto of productoIds) {
    const row = productosById.get(idProducto);
    if (!row) continue;
    if (excludedProductIds.has(idProducto)) continue;
    const requerido = Number(productoQtyMap.get(idProducto) || 0);
    if (!hasEnoughStock(row.cantidad, row.stock_minimo, requerido)) {
      faltantes.push(
        buildShortage({
          tipo_recurso: 'producto',
          id_recurso: idProducto,
          nombre: row.nombre_producto,
          cantidad_actual: row.cantidad,
          stock_minimo: row.stock_minimo,
          requerido,
          motivo: 'STOCK_INSUFICIENTE'
        })
      );
    }
  }

  for (const idInsumo of insumoIds) {
    const row = insumosById.get(idInsumo);
    if (!row) continue;
    if (excludedInsumoIds.has(idInsumo)) continue;
    const requerido = Number(insumoQtyMap.get(idInsumo) || 0);
    if (!hasEnoughStock(row.cantidad, row.stock_minimo, requerido)) {
      faltantes.push(
        buildShortage({
          tipo_recurso: 'insumo',
          id_recurso: idInsumo,
          nombre: row.nombre_insumo,
          cantidad_actual: row.cantidad,
          stock_minimo: row.stock_minimo,
          requerido,
          motivo: 'STOCK_INSUFICIENTE'
        })
      );
    }
  }

  return {
    faltantes,
    advertencias,
    lockedRows: {
      productosById,
      insumosById
    },
    excludedResources: {
      productoIds: excludedProductIds,
      insumoIds: excludedInsumoIds
    }
  };
};

