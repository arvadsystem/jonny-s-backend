import { toPositiveInt } from './pedidoPayloadValidator.js';

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
  insumoQtyMap
}) => {
  const faltantes = [];

  const productoIds = [...productoQtyMap.keys()].sort((a, b) => a - b);
  const insumoIds = [...insumoQtyMap.keys()].sort((a, b) => a - b);

  const [productosRows, insumosRows] = await Promise.all([
    fetchProductosByIdsForUpdate(client, productoIds),
    fetchInsumosByIdsForUpdate(client, insumoIds)
  ]);

  const productosById = mapById(productosRows, 'id_producto');
  const insumosById = mapById(insumosRows, 'id_insumo');

  for (const idProducto of productoIds) {
    const row = productosById.get(idProducto);
    if (!row) {
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
    const row = insumosById.get(idInsumo);
    if (!row) {
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

  for (const idAlmacen of almacenesEnUso) {
    const almacen = almacenesById.get(idAlmacen);
    if (!almacen) {
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
      faltantes.push({
        tipo_recurso: 'almacen',
        id_recurso: idAlmacen,
        id_almacen: idAlmacen,
        motivo: 'ALMACEN_INACTIVO',
        mensaje: `El almacen ${idAlmacen} esta inactivo.`
      });
    }
    if (Number(almacen.id_sucursal || 0) !== Number(idSucursal)) {
      faltantes.push({
        tipo_recurso: 'almacen',
        id_recurso: idAlmacen,
        id_almacen: idAlmacen,
        motivo: 'ALMACEN_DE_OTRA_SUCURSAL',
        mensaje: `El almacen ${idAlmacen} no pertenece a la sucursal del pedido.`
      });
    }
  }

  for (const idProducto of productoIds) {
    const row = productosById.get(idProducto);
    if (!row) continue;
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
    lockedRows: {
      productosById,
      insumosById
    }
  };
};

