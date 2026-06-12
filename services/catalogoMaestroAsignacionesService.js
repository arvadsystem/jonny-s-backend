import pool from '../config/db-connection.js';

const ENTITY_CONFIG = Object.freeze({
  producto: {
    entityType: 'producto',
    entityTable: 'productos',
    assignmentTable: 'productos_almacenes',
    mappingTable: 'productos_mapeo_maestro',
    entityIdColumn: 'id_producto',
    legacyIdColumn: 'id_producto_legacy',
    masterIdColumn: 'id_producto_maestro',
    assignmentEntityIdColumn: 'id_producto',
    entityNameColumn: 'nombre_producto',
    masterSelectSql: `
      SELECT
        p.id_producto AS id_maestro,
        p.nombre_producto AS nombre,
        COALESCE(p.stock_minimo, 0) AS stock_minimo_default,
        p.costo_compra AS precio_local_default,
        p.fecha_caducidad AS fecha_caducidad_default,
        COALESCE(p.estado, true) AS estado_global
      FROM public.productos p
      WHERE p.id_producto = $1
      LIMIT 1
    `,
    assignmentPriceColumn: 'costo_compra'
  },
  insumo: {
    entityType: 'insumo',
    entityTable: 'insumos',
    assignmentTable: 'insumos_almacenes',
    mappingTable: 'insumos_mapeo_maestro',
    entityIdColumn: 'id_insumo',
    legacyIdColumn: 'id_insumo_legacy',
    masterIdColumn: 'id_insumo_maestro',
    assignmentEntityIdColumn: 'id_insumo',
    entityNameColumn: 'nombre_insumo',
    masterSelectSql: `
      SELECT
        i.id_insumo AS id_maestro,
        i.nombre_insumo AS nombre,
        COALESCE(i.stock_minimo, 0) AS stock_minimo_default,
        i.precio AS precio_local_default,
        i.fecha_caducidad AS fecha_caducidad_default,
        COALESCE(i.estado, true) AS estado_global
      FROM public.insumos i
      WHERE i.id_insumo = $1
      LIMIT 1
    `,
    assignmentPriceColumn: 'precio_compra'
  }
});

const getEntityConfig = (entityType) => {
  const config = ENTITY_CONFIG[entityType];
  if (!config) {
    throw new Error(`Tipo de entidad no soportado: ${entityType}`);
  }
  return config;
};

const normalizeAssignmentRow = (row) => ({
  id_almacen: Number(row.id_almacen),
  almacen: String(row.almacen ?? ''),
  id_sucursal: Number(row.id_sucursal),
  sucursal: String(row.sucursal ?? ''),
  cantidad: Number(row.cantidad ?? 0),
  stock_minimo: Number(row.stock_minimo ?? 0),
  activo: row.activo === true || row.activo === 1 || row.activo === '1' || String(row.activo).trim().toLowerCase() === 'true'
});

const normalizeWarehouseRow = (row) => ({
  id_almacen: Number(row.id_almacen),
  almacen: String(row.almacen ?? ''),
  id_sucursal: Number(row.id_sucursal),
  sucursal: String(row.sucursal ?? '')
});

export const resolveCatalogoMaestroEntity = async (entityType, rawId, db = pool) => {
  const config = getEntityConfig(entityType);
  const entityId = Number.parseInt(String(rawId ?? '').trim(), 10);
  if (!Number.isSafeInteger(entityId) || entityId <= 0) {
    return { ok: false, status: 400, message: `ID de ${entityType} invalido.` };
  }

  const mappingResult = await db.query(
    `
      WITH candidatos AS (
        SELECT m.${config.masterIdColumn} AS id_maestro, 1 AS prioridad
        FROM public.${config.mappingTable} m
        WHERE m.${config.legacyIdColumn} = $1
        UNION ALL
        SELECT m.${config.masterIdColumn} AS id_maestro, 2 AS prioridad
        FROM public.${config.mappingTable} m
        WHERE m.${config.masterIdColumn} = $1
      )
      SELECT ARRAY_AGG(DISTINCT id_maestro ORDER BY id_maestro) AS ids_maestro
      FROM candidatos
    `,
    [entityId]
  );

  const mappedIds = Array.isArray(mappingResult.rows?.[0]?.ids_maestro)
    ? mappingResult.rows[0].ids_maestro
      .map((id) => Number.parseInt(String(id ?? ''), 10))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];

  if (mappedIds.length > 1) {
    return {
      ok: false,
      status: 409,
      message: `El ${entityType} indicado tiene mapeos maestros inconsistentes.`
    };
  }

  const masterId = mappedIds[0] ?? entityId;
  const masterResult = await db.query(config.masterSelectSql, [masterId]);
  const master = masterResult.rows?.[0] || null;
  if (!master) {
    return { ok: false, status: 404, message: `${entityType === 'producto' ? 'Producto' : 'Insumo'} maestro no encontrado.` };
  }

  return {
    ok: true,
    status: 200,
    entityId,
    masterId: Number(master.id_maestro),
    master: {
      id_maestro: Number(master.id_maestro),
      nombre: String(master.nombre ?? ''),
      stock_minimo_default: Number(master.stock_minimo_default ?? 0),
      precio_local_default:
        master.precio_local_default === null || master.precio_local_default === undefined
          ? null
          : Number(master.precio_local_default),
      fecha_caducidad_default: master.fecha_caducidad_default ?? null,
      estado_global:
        master.estado_global === true ||
        master.estado_global === 1 ||
        master.estado_global === '1' ||
        String(master.estado_global).trim().toLowerCase() === 'true'
    }
  };
};

export const listCatalogoMaestroAssignments = async (entityType, masterId, options = {}, db = pool) => {
  const config = getEntityConfig(entityType);
  const allowedSucursalIds = Array.isArray(options.allowedSucursalIds) ? options.allowedSucursalIds : [];
  const hasScope = allowedSucursalIds.length > 0;
  const params = [masterId];
  let scopeSql = '';

  if (hasScope) {
    params.push(allowedSucursalIds);
    scopeSql = ` AND a.id_sucursal = ANY($${params.length}::int[])`;
  }

  const result = await db.query(
    `
      SELECT
        a.id_almacen,
        COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) AS almacen,
        a.id_sucursal,
        COALESCE(NULLIF(TRIM(COALESCE(s.nombre_sucursal, '')), ''), CONCAT('Sucursal #', a.id_sucursal::text)) AS sucursal,
        COALESCE(pa.cantidad, 0)::numeric AS cantidad,
        COALESCE(pa.stock_minimo, 0)::numeric AS stock_minimo,
        COALESCE(pa.estado, true) AS activo
      FROM public.${config.assignmentTable} pa
      INNER JOIN public.almacenes a
        ON a.id_almacen = pa.id_almacen
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
      WHERE pa.${config.assignmentEntityIdColumn} = $1
      ${scopeSql}
      ORDER BY a.id_sucursal ASC, a.id_almacen ASC
    `,
    params
  );

  return (result.rows || []).map(normalizeAssignmentRow);
};

export const listCatalogoMaestroAvailableWarehouses = async (entityType, masterId, options = {}, db = pool) => {
  const config = getEntityConfig(entityType);
  const allowedSucursalIds = Array.isArray(options.allowedSucursalIds) ? options.allowedSucursalIds : [];
  const hasScope = allowedSucursalIds.length > 0;
  const params = [masterId];
  let scopeSql = '';

  if (hasScope) {
    params.push(allowedSucursalIds);
    scopeSql = ` AND a.id_sucursal = ANY($${params.length}::int[])`;
  }

  const result = await db.query(
    `
      WITH sucursales_con_asignacion_activa AS (
        SELECT DISTINCT a.id_sucursal
        FROM public.${config.assignmentTable} pa
        INNER JOIN public.almacenes a
          ON a.id_almacen = pa.id_almacen
        WHERE pa.${config.assignmentEntityIdColumn} = $1
          AND COALESCE(pa.estado, true) = true
      )
      SELECT
        a.id_almacen,
        COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) AS almacen,
        a.id_sucursal,
        COALESCE(NULLIF(TRIM(COALESCE(s.nombre_sucursal, '')), ''), CONCAT('Sucursal #', a.id_sucursal::text)) AS sucursal
      FROM public.almacenes a
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
      LEFT JOIN sucursales_con_asignacion_activa sa
        ON sa.id_sucursal = a.id_sucursal
      WHERE COALESCE(a.estado, true) = true
        AND sa.id_sucursal IS NULL
      ${scopeSql}
      ORDER BY a.id_sucursal ASC, a.id_almacen ASC
    `,
    params
  );

  return (result.rows || []).map(normalizeWarehouseRow);
};

export const getWarehouseAssignmentDetails = async (entityType, masterId, warehouseId, db = pool) => {
  const config = getEntityConfig(entityType);
  const result = await db.query(
    `
      SELECT
        pa.${config.assignmentEntityIdColumn} AS id_maestro,
        pa.id_almacen,
        COALESCE(pa.cantidad, 0)::numeric AS cantidad,
        COALESCE(pa.stock_minimo, 0)::numeric AS stock_minimo,
        COALESCE(pa.estado, true) AS activo,
        a.id_sucursal
      FROM public.${config.assignmentTable} pa
      INNER JOIN public.almacenes a
        ON a.id_almacen = pa.id_almacen
      WHERE pa.${config.assignmentEntityIdColumn} = $1
        AND pa.id_almacen = $2
      LIMIT 1
    `,
    [masterId, warehouseId]
  );

  const row = result.rows?.[0];
  if (!row) return null;
  return {
    id_maestro: Number(row.id_maestro),
    id_almacen: Number(row.id_almacen),
    id_sucursal: Number(row.id_sucursal),
    cantidad: Number(row.cantidad ?? 0),
    stock_minimo: Number(row.stock_minimo ?? 0),
    activo: row.activo === true || row.activo === 1 || row.activo === '1' || String(row.activo).trim().toLowerCase() === 'true'
  };
};

export const findActiveSucursalAssignmentConflict = async (entityType, masterId, warehouseId, db = pool) => {
  const config = getEntityConfig(entityType);
  const result = await db.query(
    `
      SELECT
        pa.id_almacen,
        a.id_sucursal,
        COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) AS almacen,
        COALESCE(NULLIF(TRIM(COALESCE(s.nombre_sucursal, '')), ''), CONCAT('Sucursal #', a.id_sucursal::text)) AS sucursal
      FROM public.${config.assignmentTable} pa
      INNER JOIN public.almacenes a
        ON a.id_almacen = pa.id_almacen
      INNER JOIN public.almacenes objetivo
        ON objetivo.id_almacen = $2
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
      WHERE pa.${config.assignmentEntityIdColumn} = $1
        AND COALESCE(pa.estado, true) = true
        AND a.id_sucursal = objetivo.id_sucursal
        AND pa.id_almacen <> $2
      ORDER BY pa.id_almacen ASC
      LIMIT 1
    `,
    [masterId, warehouseId]
  );

  const row = result.rows?.[0];
  if (!row) return null;

  return {
    id_almacen: Number(row.id_almacen),
    id_sucursal: Number(row.id_sucursal),
    almacen: String(row.almacen ?? ''),
    sucursal: String(row.sucursal ?? '')
  };
};

export const createCatalogoMaestroAssignment = async (
  entityType,
  { masterId, warehouseId, stockMinimo, precioLocal, fechaCaducidad, activo = true },
  db = pool
) => {
  const config = getEntityConfig(entityType);
  const result = await db.query(
    `
      INSERT INTO public.${config.assignmentTable} (
        ${config.assignmentEntityIdColumn},
        id_almacen,
        cantidad,
        stock_minimo,
        ${config.assignmentPriceColumn},
        fecha_caducidad,
        estado,
        fecha_actualizacion
      ) VALUES ($1, $2, 0, $3, $4, $5, $6, now())
      RETURNING ${config.assignmentEntityIdColumn} AS id_maestro, id_almacen
    `,
    [
      masterId,
      warehouseId,
      stockMinimo,
      precioLocal,
      fechaCaducidad,
      activo
    ]
  );

  return result.rows?.[0] || null;
};

export const reactivateCatalogoMaestroAssignment = async (
  entityType,
  { masterId, warehouseId, stockMinimo = undefined },
  db = pool
) => {
  const config = getEntityConfig(entityType);
  const params = [masterId, warehouseId];
  const stockSql =
    stockMinimo === undefined
      ? ''
      : (() => {
          params.push(stockMinimo);
          return `, stock_minimo = $${params.length}`;
        })();

  const result = await db.query(
    `
      UPDATE public.${config.assignmentTable}
      SET estado = true,
          fecha_actualizacion = now()
          ${stockSql}
      WHERE ${config.assignmentEntityIdColumn} = $1
        AND id_almacen = $2
      RETURNING ${config.assignmentEntityIdColumn} AS id_maestro, id_almacen
    `,
    params
  );

  return result.rows?.[0] || null;
};

export const deactivateCatalogoMaestroAssignment = async (entityType, { masterId, warehouseId }, db = pool) => {
  const config = getEntityConfig(entityType);
  const result = await db.query(
    `
      UPDATE public.${config.assignmentTable}
      SET estado = false,
          fecha_actualizacion = now()
      WHERE ${config.assignmentEntityIdColumn} = $1
        AND id_almacen = $2
      RETURNING ${config.assignmentEntityIdColumn} AS id_maestro, id_almacen
    `,
    [masterId, warehouseId]
  );

  return result.rows?.[0] || null;
};
