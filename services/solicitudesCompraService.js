import pool from '../config/db-connection.js';
import { readRequestAccess } from '../middleware/checkPermission.js';
import {
  getWarehouseAssignmentDetails,
  resolveCatalogoMaestroEntity
} from './catalogoMaestroAsignacionesService.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_LINES = 100;
const MAX_OBSERVATION_LENGTH = 1000;
const MAX_QUANTITY_SCALED = 9_999_999_999_999n;
const VALID_STATES = new Set(['PENDIENTE', 'APROBADA', 'RECHAZADA', 'RECIBIDA', 'CANCELADA']);
const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'ADMINISTRADOR']);
const OPERATIVE_ROLES = new Set(['CAJERO', 'COCINA', 'COCINERO', 'COCINERA', 'JEFA_COCINA', 'JEFE_COCINA']);
const TOP_LEVEL_FIELDS = new Set(['id_almacen', 'observacion', 'detalles']);
const DETAIL_FIELDS = new Set(['tipo_item', 'id_item', 'id_presentacion_insumo', 'cantidad']);

export class SolicitudesCompraError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SolicitudesCompraError';
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => {
  throw new SolicitudesCompraError(status, code, message);
};

const normalizeRole = (value) => String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase();

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';

export const parsePositiveIntStrict = (value) => {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const parseBoolean = (value) => {
  if (!hasValue(value)) return false;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'si', 'sí'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
};

const parseDate = (value) => {
  if (!hasValue(value)) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
};

const scaledToDecimal = (scaled) => {
  const integer = scaled / 10_000n;
  const fraction = String(scaled % 10_000n).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : String(integer);
};

export const parseQuantity = (value, { integerOnly = false } = {}) => {
  const text = String(value ?? '').trim();
  const pattern = integerOnly ? /^[1-9]\d*$/ : /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;
  if (!pattern.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const scaled = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0') || '0');
  if (scaled <= 0n || scaled > MAX_QUANTITY_SCALED) return null;
  if (integerOnly && scaled % 10_000n !== 0n) return null;
  return { scaled, decimal: scaledToDecimal(scaled) };
};

const parsePagination = (query) => {
  const page = hasValue(query?.page) ? parsePositiveIntStrict(query.page) : 1;
  const requestedLimit = hasValue(query?.limit) ? parsePositiveIntStrict(query.limit) : DEFAULT_LIMIT;
  if (!page || !requestedLimit) fail(400, 'VALIDATION_ERROR', 'page y limit deben ser enteros positivos.');
  return { page, limit: Math.min(requestedLimit, MAX_LIMIT), offset: (page - 1) * Math.min(requestedLimit, MAX_LIMIT) };
};

const ensurePlainObject = (value, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'VALIDATION_ERROR', message);
};

const rejectUnexpectedFields = (value, allowed, context) => {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail(400, 'VALIDATION_ERROR', `${context} contiene campos no permitidos: ${unexpected.join(', ')}.`);
  }
};

const normalizeObservation = (value) => {
  if (!hasValue(value)) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length > MAX_OBSERVATION_LENGTH) {
    fail(400, 'VALIDATION_ERROR', `observacion no puede exceder ${MAX_OBSERVATION_LENGTH} caracteres.`);
  }
  return normalized || null;
};

const validateRequestShape = (body) => {
  if (!Array.isArray(body.detalles) || body.detalles.length === 0) {
    fail(400, 'VALIDATION_ERROR', 'Debe incluir al menos una linea.');
  }
  if (body.detalles.length > MAX_LINES) {
    fail(400, 'VALIDATION_ERROR', `No se permiten mas de ${MAX_LINES} lineas.`);
  }
  for (const rawLine of body.detalles) {
    ensurePlainObject(rawLine, 'Cada detalle debe ser un objeto.');
    rejectUnexpectedFields(rawLine, DETAIL_FIELDS, 'El detalle');
  }
};

const stockStatusSql = (quantitySql, minimumSql) => `
  CASE
    WHEN ${quantitySql} <= 0 THEN 'SIN_STOCK'
    WHEN ${quantitySql} <= ${minimumSql} THEN 'STOCK_BAJO'
    ELSE 'DISPONIBLE'
  END
`;

const serializeCatalogRow = (row) => ({
  tipo_item: String(row.tipo_item).toLowerCase(),
  id_item: Number(row.id_item),
  nombre: row.nombre,
  descripcion: row.descripcion,
  categoria: row.categoria,
  id_almacen: Number(row.id_almacen),
  nombre_almacen: row.nombre_almacen,
  id_sucursal: Number(row.id_sucursal),
  nombre_sucursal: row.nombre_sucursal,
  cantidad: Number(row.cantidad ?? 0),
  stock_minimo: Number(row.stock_minimo ?? 0),
  estado_stock: row.estado_stock,
  unidad_base: row.unidad_base,
  presentaciones: Array.isArray(row.presentaciones) ? row.presentaciones : []
});

const normalizeAccess = async (req, queryRunner, dependencies) => {
  const access = await dependencies.readAccess(req, queryRunner);
  const scope = await dependencies.resolveScope(req, queryRunner);
  const roles = new Set(Array.from(access.roles || []).map(normalizeRole));
  const isAdmin = Boolean(access.isSuperAdmin) || Array.from(roles).some((role) => ADMIN_ROLES.has(role));
  const isOperative = !isAdmin && Array.from(roles).some((role) => OPERATIVE_ROLES.has(role));

  if (!access.idUsuario) fail(401, 'UNAUTHORIZED', 'No autorizado.');
  if (!isAdmin && !isOperative) fail(403, 'FORBIDDEN', 'El rol del usuario no puede operar solicitudes de compra.');
  if (isOperative && !scope.userSucursalId) fail(403, 'FORBIDDEN', 'El usuario no tiene una sucursal operativa asignada.');

  return {
    idUsuario: access.idUsuario,
    isAdmin,
    isOperative,
    userSucursalId: scope.userSucursalId || null,
    allowedSucursalIds: isOperative ? [scope.userSucursalId] : null
  };
};

const getWarehouse = async (warehouseId, access, queryRunner) => {
  const result = await queryRunner.query(
    `
      SELECT a.id_almacen, a.id_sucursal, a.nombre AS nombre_almacen,
             s.nombre_sucursal, COALESCE(a.estado, true) AS estado
      FROM public.almacenes a
      INNER JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
      WHERE a.id_almacen = $1
      LIMIT 1
    `,
    [warehouseId]
  );
  const warehouse = result.rows?.[0];
  if (!warehouse) fail(404, 'NOT_FOUND', 'Almacen no encontrado.');
  if (!warehouse.estado) fail(409, 'CONFLICT', 'El almacen esta inactivo.');
  if (access.isOperative && Number(warehouse.id_sucursal) !== access.userSucursalId) {
    fail(403, 'FORBIDDEN', 'No tiene acceso al almacen solicitado.');
  }
  return {
    id_almacen: Number(warehouse.id_almacen),
    id_sucursal: Number(warehouse.id_sucursal),
    nombre_almacen: warehouse.nombre_almacen,
    nombre_sucursal: warehouse.nombre_sucursal
  };
};

const resolveCatalogWarehouse = async (rawWarehouseId, access, queryRunner) => {
  const explicitId = parsePositiveIntStrict(rawWarehouseId);
  if (hasValue(rawWarehouseId) && !explicitId) fail(400, 'VALIDATION_ERROR', 'id_almacen debe ser un entero positivo.');
  if (explicitId) return getWarehouse(explicitId, access, queryRunner);

  const params = [];
  let scopeSql = '';
  if (access.isOperative) {
    params.push(access.userSucursalId);
    scopeSql = ` AND a.id_sucursal = $${params.length}`;
  }
  const result = await queryRunner.query(
    `
      SELECT a.id_almacen, a.id_sucursal, a.nombre AS nombre_almacen, s.nombre_sucursal
      FROM public.almacenes a
      INNER JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
      WHERE COALESCE(a.estado, true) = true
        ${scopeSql}
      ORDER BY a.id_almacen
      LIMIT 2
    `,
    params
  );
  if (result.rowCount !== 1) {
    fail(400, 'VALIDATION_ERROR', 'id_almacen es obligatorio cuando el alcance tiene cero o varios almacenes activos.');
  }
  return {
    id_almacen: Number(result.rows[0].id_almacen),
    id_sucursal: Number(result.rows[0].id_sucursal),
    nombre_almacen: result.rows[0].nombre_almacen,
    nombre_sucursal: result.rows[0].nombre_sucursal
  };
};

const buildCatalogUnion = (type) => {
  const productSql = `
    SELECT 'PRODUCTO'::text AS tipo_item, p.id_producto AS id_item,
           p.nombre_producto AS nombre, p.descripcion_producto AS descripcion,
           cp.nombre_categoria AS categoria, pa.id_almacen, a.nombre AS nombre_almacen,
           a.id_sucursal, s.nombre_sucursal,
           COALESCE(pa.cantidad, 0)::numeric AS cantidad,
           COALESCE(pa.stock_minimo, 0)::numeric AS stock_minimo,
           ${stockStatusSql('COALESCE(pa.cantidad, 0)', 'COALESCE(pa.stock_minimo, 0)')} AS estado_stock,
           'Unidad'::text AS unidad_base, '[]'::jsonb AS presentaciones
    FROM public.productos p
    INNER JOIN public.productos_almacenes pa ON pa.id_producto = p.id_producto
    INNER JOIN public.almacenes a ON a.id_almacen = pa.id_almacen
    INNER JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
    LEFT JOIN public.categorias_productos cp ON cp.id_categoria_producto = p.id_categoria_producto
    WHERE pa.id_almacen = $1 AND p.estado = true AND pa.estado = true AND a.estado = true
  `;
  const supplySql = `
    SELECT 'INSUMO'::text AS tipo_item, i.id_insumo AS id_item,
           i.nombre_insumo AS nombre, i.descripcion AS descripcion,
           ci.nombre_categoria AS categoria, ia.id_almacen, a.nombre AS nombre_almacen,
           a.id_sucursal, s.nombre_sucursal,
           COALESCE(ia.cantidad, 0)::numeric AS cantidad,
           COALESCE(ia.stock_minimo, 0)::numeric AS stock_minimo,
           ${stockStatusSql('COALESCE(ia.cantidad, 0)', 'COALESCE(ia.stock_minimo, 0)')} AS estado_stock,
           COALESCE(NULLIF(TRIM(CONCAT(ub.nombre, CASE WHEN NULLIF(TRIM(ub.simbolo), '') IS NULL THEN '' ELSE CONCAT(' (', TRIM(ub.simbolo), ')') END)), ''), 'Sin unidad') AS unidad_base,
           COALESCE(pres.presentaciones, '[]'::jsonb) AS presentaciones
    FROM public.insumos i
    INNER JOIN public.insumos_almacenes ia ON ia.id_insumo = i.id_insumo
    INNER JOIN public.almacenes a ON a.id_almacen = ia.id_almacen
    INNER JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
    LEFT JOIN public.categorias_insumos ci ON ci.id_categoria_insumo = i.id_categoria_insumo
    LEFT JOIN public.unidades_medida ub ON ub.id_unidad_medida = i.id_unidad_medida
    LEFT JOIN LATERAL (
      SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'id_presentacion', ip.id_presentacion,
        'nombre_presentacion', ip.nombre_presentacion,
        'cantidad_presentacion', ip.cantidad_presentacion,
        'unidad_presentacion', up.nombre,
        'cantidad_base', ip.cantidad_base,
        'unidad_base', ubp.nombre,
        'factor_conversion', ip.cantidad_base / NULLIF(ip.cantidad_presentacion, 0),
        'es_predeterminada_compra', ip.es_predeterminada_compra
      ) ORDER BY ip.es_predeterminada_compra DESC, ip.id_presentacion) AS presentaciones
      FROM public.insumo_presentaciones ip
      INNER JOIN public.unidades_medida up ON up.id_unidad_medida = ip.id_unidad_presentacion
      INNER JOIN public.unidades_medida ubp ON ubp.id_unidad_medida = ip.id_unidad_base
      WHERE ip.id_insumo = i.id_insumo AND ip.estado = true AND ip.uso_compra = true
        AND ip.cantidad_presentacion > 0 AND ip.cantidad_base > 0
    ) pres ON true
    WHERE ia.id_almacen = $1 AND i.estado = true AND ia.estado = true AND a.estado = true
  `;
  if (type === 'producto') return productSql;
  if (type === 'insumo') return supplySql;
  return `${productSql} UNION ALL ${supplySql}`;
};

const loadInsumoSnapshot = async (masterId, presentationId, queryRunner) => {
  if (!presentationId) {
    const result = await queryRunner.query(
      `
        SELECT i.id_unidad_medida AS id_unidad_base,
               COALESCE(NULLIF(TRIM(um.nombre), ''), CONCAT('Unidad #', i.id_unidad_medida::text)) AS nombre_unidad_base
        FROM public.insumos i
        LEFT JOIN public.unidades_medida um ON um.id_unidad_medida = i.id_unidad_medida
        WHERE i.id_insumo = $1
        LIMIT 1
      `,
      [masterId]
    );
    const row = result.rows?.[0];
    if (!parsePositiveIntStrict(row?.id_unidad_base)) {
      fail(409, 'CONFLICT', 'El insumo no tiene una unidad base valida.');
    }
    return {
      id_presentacion_insumo: null,
      id_unidad_base: Number(row.id_unidad_base),
      nombre_presentacion_snapshot: row.nombre_unidad_base,
      factor_conversion_snapshot: '1'
    };
  }

  const result = await queryRunner.query(
    `
      SELECT ip.id_presentacion, ip.id_insumo, ip.id_unidad_base,
             ip.nombre_presentacion, ip.cantidad_presentacion::text,
             ip.cantidad_base::text,
             (ip.cantidad_base / NULLIF(ip.cantidad_presentacion, 0))::text AS factor_conversion,
             i.id_unidad_medida AS id_unidad_base_insumo
      FROM public.insumo_presentaciones ip
      INNER JOIN public.insumos i ON i.id_insumo = ip.id_insumo
      WHERE ip.id_presentacion = $1 AND ip.estado = true AND ip.uso_compra = true
        AND ip.cantidad_presentacion > 0 AND ip.cantidad_base > 0
      LIMIT 1
    `,
    [presentationId]
  );
  const row = result.rows?.[0];
  if (!row) fail(400, 'VALIDATION_ERROR', 'La presentacion de insumo no existe o no esta disponible para compra.');
  if (Number(row.id_insumo) !== masterId) fail(400, 'VALIDATION_ERROR', 'La presentacion no pertenece al insumo indicado.');
  if (Number(row.id_unidad_base) !== Number(row.id_unidad_base_insumo)) {
    fail(409, 'CONFLICT', 'La unidad base de la presentacion no coincide con la unidad base del insumo.');
  }
  return {
    id_presentacion_insumo: Number(row.id_presentacion),
    id_unidad_base: Number(row.id_unidad_base),
    nombre_presentacion_snapshot: row.nombre_presentacion,
    factor_conversion_snapshot: row.factor_conversion
  };
};

const normalizeRequestLines = async (rawLines, warehouse, queryRunner, dependencies) => {
  if (!Array.isArray(rawLines) || rawLines.length === 0) fail(400, 'VALIDATION_ERROR', 'Debe incluir al menos una linea.');
  if (rawLines.length > MAX_LINES) fail(400, 'VALIDATION_ERROR', `No se permiten mas de ${MAX_LINES} lineas.`);
  const grouped = new Map();

  for (const rawLine of rawLines) {
    ensurePlainObject(rawLine, 'Cada detalle debe ser un objeto.');
    rejectUnexpectedFields(rawLine, DETAIL_FIELDS, 'El detalle');
    const type = String(rawLine.tipo_item ?? '').trim().toLowerCase();
    if (!['producto', 'insumo'].includes(type)) fail(400, 'VALIDATION_ERROR', 'tipo_item debe ser producto o insumo.');
    const rawItemId = parsePositiveIntStrict(rawLine.id_item);
    if (!rawItemId) fail(400, 'VALIDATION_ERROR', 'id_item debe ser un entero positivo.');
    const presentationId = hasValue(rawLine.id_presentacion_insumo)
      ? parsePositiveIntStrict(rawLine.id_presentacion_insumo)
      : null;
    if (hasValue(rawLine.id_presentacion_insumo) && !presentationId) {
      fail(400, 'VALIDATION_ERROR', 'id_presentacion_insumo debe ser un entero positivo.');
    }
    if (type === 'producto' && presentationId) {
      fail(400, 'VALIDATION_ERROR', 'Los productos no aceptan presentacion de insumo.');
    }
    const quantity = parseQuantity(rawLine.cantidad, { integerOnly: type === 'producto' });
    if (!quantity) {
      fail(400, 'VALIDATION_ERROR', type === 'producto'
        ? 'La cantidad de producto debe ser un entero positivo.'
        : 'La cantidad de insumo debe ser positiva y tener hasta 4 decimales.');
    }

    const resolved = await dependencies.resolveMaster(type, rawItemId, queryRunner);
    if (!resolved.ok) fail(resolved.status || 400, resolved.status === 404 ? 'NOT_FOUND' : 'CONFLICT', resolved.message);
    if (!resolved.master.estado_global) fail(409, 'CONFLICT', `El ${type} maestro esta inactivo.`);
    const masterId = Number(resolved.masterId);
    const assignment = await dependencies.getAssignment(type, masterId, warehouse.id_almacen, queryRunner);
    if (!assignment || !assignment.activo) {
      fail(409, 'CONFLICT', `El ${type} no tiene una asignacion activa en el almacen solicitado.`);
    }
    if (Number(assignment.id_sucursal) !== warehouse.id_sucursal) {
      fail(409, 'CONFLICT', `La asignacion del ${type} no coincide con la sucursal del almacen.`);
    }

    const snapshot = type === 'producto'
      ? {
          id_presentacion_insumo: null,
          id_unidad_base: null,
          nombre_presentacion_snapshot: 'Unidad',
          factor_conversion_snapshot: '1'
        }
      : await loadInsumoSnapshot(masterId, presentationId, queryRunner);
    const key = `${type}:${masterId}:${snapshot.id_presentacion_insumo ?? 'base'}`;
    const existing = grouped.get(key);
    const nextScaled = (existing?.quantityScaled || 0n) + quantity.scaled;
    if (nextScaled > MAX_QUANTITY_SCALED) fail(400, 'VALIDATION_ERROR', 'La cantidad agrupada excede el maximo permitido.');
    grouped.set(key, {
      tipo_item: type.toUpperCase(),
      id_producto: type === 'producto' ? masterId : null,
      id_insumo: type === 'insumo' ? masterId : null,
      ...snapshot,
      quantityScaled: nextScaled
    });
  }

  return Array.from(grouped.values()).map(({ quantityScaled, ...line }) => ({
    ...line,
    cantidad_solicitada: scaledToDecimal(quantityScaled)
  }));
};

const mapDatabaseError = (error) => {
  if (error instanceof SolicitudesCompraError) return error;
  if (['23502', '23503', '23514', '22P02', '22003'].includes(error?.code)) {
    return new SolicitudesCompraError(400, 'VALIDATION_ERROR', 'Los datos de la solicitud no son validos.');
  }
  if (error?.code === '23505') return new SolicitudesCompraError(409, 'CONFLICT', 'La solicitud entra en conflicto con datos existentes.');
  return new SolicitudesCompraError(500, 'INTERNAL_ERROR', 'No se pudo completar la operacion solicitada.');
};

export const createSolicitudesCompraService = (overrides = {}) => {
  const dependencies = {
    db: overrides.db || pool,
    readAccess: overrides.readAccess || readRequestAccess,
    resolveScope: overrides.resolveScope || resolveRequestUserSucursalScope,
    resolveMaster: overrides.resolveMaster || resolveCatalogoMaestroEntity,
    getAssignment: overrides.getAssignment || getWarehouseAssignmentDetails
  };

  const listCatalog = async (req) => {
    const access = await normalizeAccess(req, dependencies.db, dependencies);
    const warehouse = await resolveCatalogWarehouse(req.query?.id_almacen, access, dependencies.db);
    const type = hasValue(req.query?.tipo) ? String(req.query.tipo).trim().toLowerCase() : null;
    if (type && !['producto', 'insumo'].includes(type)) fail(400, 'VALIDATION_ERROR', 'tipo debe ser producto o insumo.');
    const lowStock = parseBoolean(req.query?.solo_stock_bajo);
    if (lowStock === null) fail(400, 'VALIDATION_ERROR', 'solo_stock_bajo debe ser booleano.');
    const search = hasValue(req.query?.buscar) ? String(req.query.buscar).trim().slice(0, 120) : null;
    const pagination = parsePagination(req.query);
    const result = await dependencies.db.query(
      `
        WITH catalogo AS (${buildCatalogUnion(type)})
        SELECT catalogo.*, COUNT(*) OVER()::integer AS total_count
        FROM catalogo
        WHERE ($2::text IS NULL OR catalogo.nombre ILIKE '%' || $2 || '%' OR COALESCE(catalogo.descripcion, '') ILIKE '%' || $2 || '%')
          AND ($3::boolean = false OR catalogo.estado_stock IN ('SIN_STOCK', 'STOCK_BAJO'))
        ORDER BY LOWER(catalogo.nombre), catalogo.tipo_item, catalogo.id_item
        LIMIT $4 OFFSET $5
      `,
      [warehouse.id_almacen, search, lowStock, pagination.limit, pagination.offset]
    );
    const total = Number(result.rows?.[0]?.total_count ?? 0);
    return {
      ok: true,
      id_almacen: warehouse.id_almacen,
      items: (result.rows || []).map(serializeCatalogRow),
      pagination: { page: pagination.page, limit: pagination.limit, total, total_pages: Math.ceil(total / pagination.limit) }
    };
  };

  const create = async (req) => {
    ensurePlainObject(req.body, 'El payload debe ser un objeto.');
    rejectUnexpectedFields(req.body, TOP_LEVEL_FIELDS, 'El payload');
    validateRequestShape(req.body);
    const warehouseId = parsePositiveIntStrict(req.body.id_almacen);
    if (!warehouseId) fail(400, 'VALIDATION_ERROR', 'id_almacen es obligatorio y debe ser un entero positivo.');
    const observation = normalizeObservation(req.body.observacion);
    const client = await dependencies.db.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const access = await normalizeAccess(req, client, dependencies);
      const warehouse = await getWarehouse(warehouseId, access, client);
      const lines = await normalizeRequestLines(req.body.detalles, warehouse, client, dependencies);
      const headerResult = await client.query(
        `
          INSERT INTO public.solicitudes_compra (
            id_sucursal, id_almacen, id_usuario_solicitante, estado,
            observacion_solicitud, inventario_aplicado
          ) VALUES ($1, $2, $3, 'PENDIENTE', $4, false)
          RETURNING id_solicitud_compra, estado, fecha_creacion
        `,
        [warehouse.id_sucursal, warehouse.id_almacen, access.idUsuario, observation]
      );
      const header = headerResult.rows[0];
      for (const line of lines) {
        await client.query(
          `
            INSERT INTO public.solicitudes_compra_detalle (
              id_solicitud_compra, tipo_item, id_producto, id_insumo,
              id_presentacion_insumo, id_unidad_base, nombre_presentacion_snapshot,
              factor_conversion_snapshot, cantidad_solicitada, cantidad_base_solicitada
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $9::numeric * $8::numeric)
          `,
          [
            header.id_solicitud_compra,
            line.tipo_item,
            line.id_producto,
            line.id_insumo,
            line.id_presentacion_insumo,
            line.id_unidad_base,
            line.nombre_presentacion_snapshot,
            line.factor_conversion_snapshot,
            line.cantidad_solicitada
          ]
        );
      }
      await client.query('COMMIT');
      transactionStarted = false;
      return {
        ok: true,
        mensaje: 'Solicitud de compra creada correctamente.',
        id_solicitud_compra: Number(header.id_solicitud_compra),
        estado: header.estado,
        fecha_creacion: header.fecha_creacion,
        total_lineas: lines.length
      };
    } catch (error) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); } catch { /* AM: conserva el error original. */ }
      }
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  };

  const list = async (req) => {
    const access = await normalizeAccess(req, dependencies.db, dependencies);
    const pagination = parsePagination(req.query);
    const state = hasValue(req.query?.estado) ? String(req.query.estado).trim().toUpperCase() : null;
    if (state && !VALID_STATES.has(state)) fail(400, 'VALIDATION_ERROR', 'estado no es valido.');
    const branchId = hasValue(req.query?.id_sucursal) ? parsePositiveIntStrict(req.query.id_sucursal) : null;
    if (hasValue(req.query?.id_sucursal) && !branchId) fail(400, 'VALIDATION_ERROR', 'id_sucursal debe ser un entero positivo.');
    if (branchId && access.isOperative && branchId !== access.userSucursalId) fail(403, 'FORBIDDEN', 'No puede consultar otra sucursal.');
    const warehouseId = hasValue(req.query?.id_almacen) ? parsePositiveIntStrict(req.query.id_almacen) : null;
    if (hasValue(req.query?.id_almacen) && !warehouseId) fail(400, 'VALIDATION_ERROR', 'id_almacen debe ser un entero positivo.');
    const from = hasValue(req.query?.fecha_desde) ? parseDate(req.query.fecha_desde) : null;
    const to = hasValue(req.query?.fecha_hasta) ? parseDate(req.query.fecha_hasta) : null;
    if (hasValue(req.query?.fecha_desde) && !from) fail(400, 'VALIDATION_ERROR', 'fecha_desde debe usar formato YYYY-MM-DD.');
    if (hasValue(req.query?.fecha_hasta) && !to) fail(400, 'VALIDATION_ERROR', 'fecha_hasta debe usar formato YYYY-MM-DD.');
    if (from && to && from > to) fail(400, 'VALIDATION_ERROR', 'fecha_desde no puede ser posterior a fecha_hasta.');

    const params = [];
    const where = [];
    const add = (clause, value) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
    if (access.isOperative) add('sc.id_sucursal = ?', access.userSucursalId);
    else if (branchId) add('sc.id_sucursal = ?', branchId);
    if (state) add('sc.estado = ?', state);
    if (warehouseId) add('sc.id_almacen = ?', warehouseId);
    if (from) add('sc.fecha_creacion >= ?::date', from);
    if (to) add("sc.fecha_creacion < (?::date + INTERVAL '1 day')", to);
    params.push(pagination.limit, pagination.offset);
    const limitRef = `$${params.length - 1}`;
    const offsetRef = `$${params.length}`;
    const result = await dependencies.db.query(
      `
        WITH detail_counts AS (
          SELECT d.id_solicitud_compra, COUNT(*)::integer AS total_lineas,
                 COUNT(*) FILTER (WHERE d.tipo_item = 'PRODUCTO')::integer AS total_productos,
                 COUNT(*) FILTER (WHERE d.tipo_item = 'INSUMO')::integer AS total_insumos
          FROM public.solicitudes_compra_detalle d
          GROUP BY d.id_solicitud_compra
        )
        SELECT sc.id_solicitud_compra, sc.estado,
               JSON_BUILD_OBJECT('id_sucursal', s.id_sucursal, 'nombre', s.nombre_sucursal) AS sucursal,
               JSON_BUILD_OBJECT('id_almacen', a.id_almacen, 'nombre', a.nombre) AS almacen,
               JSON_BUILD_OBJECT('id_usuario', u.id_usuario, 'nombre', COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)), ''), u.nombre_usuario)) AS solicitante,
               sc.fecha_creacion, sc.fecha_revision, sc.fecha_recepcion,
               COALESCE(dc.total_lineas, 0) AS total_lineas,
               COALESCE(dc.total_productos, 0) AS total_productos,
               COALESCE(dc.total_insumos, 0) AS total_insumos,
               sc.observacion_solicitud, sc.comentario_revision,
               EXISTS (
                 SELECT 1 FROM public.solicitudes_compra_evidencias sce
                 WHERE sce.id_solicitud_compra = sc.id_solicitud_compra
               ) AS tiene_evidencia,
               COUNT(*) OVER()::integer AS total_count
        FROM public.solicitudes_compra sc
        INNER JOIN public.sucursales s ON s.id_sucursal = sc.id_sucursal
        INNER JOIN public.almacenes a ON a.id_almacen = sc.id_almacen
        INNER JOIN public.usuarios u ON u.id_usuario = sc.id_usuario_solicitante
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas p ON p.id_persona = e.id_persona
        LEFT JOIN detail_counts dc ON dc.id_solicitud_compra = sc.id_solicitud_compra
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY sc.fecha_creacion DESC, sc.id_solicitud_compra DESC
        LIMIT ${limitRef} OFFSET ${offsetRef}
      `,
      params
    );
    const total = Number(result.rows?.[0]?.total_count ?? 0);
    return {
      ok: true,
      solicitudes: (result.rows || []).map(({ total_count, ...row }) => row),
      pagination: { page: pagination.page, limit: pagination.limit, total, total_pages: Math.ceil(total / pagination.limit) }
    };
  };

  const getById = async (req) => {
    const id = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    const access = await normalizeAccess(req, dependencies.db, dependencies);
    const headerResult = await dependencies.db.query(
      `
        SELECT sc.*, s.nombre_sucursal, a.nombre AS nombre_almacen,
               u.nombre_usuario AS solicitante_usuario,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)), ''), u.nombre_usuario) AS solicitante_nombre,
               ur.nombre_usuario AS revisor_usuario,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', pr.nombre, pr.apellido)), ''), ur.nombre_usuario) AS revisor_nombre,
               urec.nombre_usuario AS receptor_usuario,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', prec.nombre, prec.apellido)), ''), urec.nombre_usuario) AS receptor_nombre,
               EXISTS (
                 SELECT 1 FROM public.solicitudes_compra_evidencias sce
                 WHERE sce.id_solicitud_compra = sc.id_solicitud_compra
               ) AS tiene_evidencia
        FROM public.solicitudes_compra sc
        INNER JOIN public.sucursales s ON s.id_sucursal = sc.id_sucursal
        INNER JOIN public.almacenes a ON a.id_almacen = sc.id_almacen
        INNER JOIN public.usuarios u ON u.id_usuario = sc.id_usuario_solicitante
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas p ON p.id_persona = e.id_persona
        LEFT JOIN public.usuarios ur ON ur.id_usuario = sc.id_usuario_revisor
        LEFT JOIN public.empleados er ON er.id_empleado = ur.id_empleado
        LEFT JOIN public.personas pr ON pr.id_persona = er.id_persona
        LEFT JOIN public.usuarios urec ON urec.id_usuario = sc.id_usuario_recepcion
        LEFT JOIN public.empleados erec ON erec.id_empleado = urec.id_empleado
        LEFT JOIN public.personas prec ON prec.id_persona = erec.id_persona
        WHERE sc.id_solicitud_compra = $1
        LIMIT 1
      `,
      [id]
    );
    const header = headerResult.rows?.[0];
    if (!header) fail(404, 'NOT_FOUND', 'Solicitud de compra no encontrada.');
    if (access.isOperative && Number(header.id_sucursal) !== access.userSucursalId) {
      fail(403, 'FORBIDDEN', 'No tiene acceso a esta solicitud de compra.');
    }
    const detailsResult = await dependencies.db.query(
      `
        SELECT d.id_solicitud_detalle, d.tipo_item,
               COALESCE(d.id_producto, d.id_insumo) AS id_item,
               CASE WHEN d.tipo_item = 'PRODUCTO' THEN p.nombre_producto ELSE i.nombre_insumo END AS nombre,
               CASE WHEN d.tipo_item = 'PRODUCTO' THEN cp.nombre_categoria ELSE ci.nombre_categoria END AS categoria,
               d.cantidad_solicitada, d.nombre_presentacion_snapshot AS presentacion_snapshot,
               d.cantidad_base_solicitada, ub.nombre AS unidad_base,
               d.cantidad_aprobada, d.cantidad_base_aprobada,
               CASE WHEN prov.id_proveedor IS NULL THEN NULL ELSE JSON_BUILD_OBJECT(
                 'id_proveedor', prov.id_proveedor,
                 'nombre_proveedor', prov.nombre_proveedor
               ) END AS proveedor,
               d.cantidad_recibida, d.cantidad_base_recibida,
               COALESCE(pa.cantidad, ia.cantidad, 0)::numeric AS stock_actual,
               COALESCE(pa.stock_minimo, ia.stock_minimo, 0)::numeric AS stock_minimo,
               ${stockStatusSql('COALESCE(pa.cantidad, ia.cantidad, 0)', 'COALESCE(pa.stock_minimo, ia.stock_minimo, 0)')} AS estado_stock
        FROM public.solicitudes_compra_detalle d
        INNER JOIN public.solicitudes_compra sc ON sc.id_solicitud_compra = d.id_solicitud_compra
        LEFT JOIN public.productos p ON p.id_producto = d.id_producto
        LEFT JOIN public.categorias_productos cp ON cp.id_categoria_producto = p.id_categoria_producto
        LEFT JOIN public.productos_almacenes pa ON pa.id_producto = d.id_producto AND pa.id_almacen = sc.id_almacen
        LEFT JOIN public.insumos i ON i.id_insumo = d.id_insumo
        LEFT JOIN public.categorias_insumos ci ON ci.id_categoria_insumo = i.id_categoria_insumo
        LEFT JOIN public.insumos_almacenes ia ON ia.id_insumo = d.id_insumo AND ia.id_almacen = sc.id_almacen
        LEFT JOIN public.unidades_medida ub ON ub.id_unidad_medida = d.id_unidad_base
        LEFT JOIN public.proveedores prov ON prov.id_proveedor = d.id_proveedor
        WHERE d.id_solicitud_compra = $1
        ORDER BY d.id_solicitud_detalle
      `,
      [id]
    );
    return {
      ok: true,
      solicitud: {
        id_solicitud_compra: Number(header.id_solicitud_compra),
        sucursal: { id_sucursal: Number(header.id_sucursal), nombre: header.nombre_sucursal },
        almacen: { id_almacen: Number(header.id_almacen), nombre: header.nombre_almacen },
        solicitante: { id_usuario: Number(header.id_usuario_solicitante), nombre: header.solicitante_nombre },
        estado: header.estado,
        observacion_solicitud: header.observacion_solicitud,
        comentario_revision: header.comentario_revision,
        observacion_recepcion: header.observacion_recepcion,
        fecha_creacion: header.fecha_creacion,
        fecha_revision: header.fecha_revision,
        fecha_recepcion: header.fecha_recepcion,
        inventario_aplicado: Boolean(header.inventario_aplicado),
        fecha_inventario_aplicado: header.fecha_inventario_aplicado,
        tiene_evidencia: Boolean(header.tiene_evidencia),
        receptor: header.id_usuario_recepcion ? { id_usuario: Number(header.id_usuario_recepcion), nombre: header.receptor_nombre } : null,
        revisor: header.id_usuario_revisor ? { id_usuario: Number(header.id_usuario_revisor), nombre: header.revisor_nombre } : null
      },
      detalles: (detailsResult.rows || []).map((row) => ({
        ...row,
        id_solicitud_detalle: Number(row.id_solicitud_detalle),
        id_item: Number(row.id_item),
        cantidad_solicitada: Number(row.cantidad_solicitada),
        cantidad_base_solicitada: Number(row.cantidad_base_solicitada),
        cantidad_aprobada: row.cantidad_aprobada === null ? null : Number(row.cantidad_aprobada),
        cantidad_base_aprobada: row.cantidad_base_aprobada === null ? null : Number(row.cantidad_base_aprobada),
        cantidad_recibida: row.cantidad_recibida === null ? null : Number(row.cantidad_recibida),
        cantidad_base_recibida: row.cantidad_base_recibida === null ? null : Number(row.cantidad_base_recibida),
        stock_actual: Number(row.stock_actual ?? 0),
        stock_minimo: Number(row.stock_minimo ?? 0)
      }))
    };
  };

  return { listCatalog, create, list, getById };
};

export const solicitudesCompraService = createSolicitudesCompraService();
