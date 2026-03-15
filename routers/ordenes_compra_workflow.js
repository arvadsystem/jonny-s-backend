import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../middleware/checkPermission.js';

const router = express.Router();

// AM: permisos minimos del nuevo flujo de ordenes de compra.
const PERM_OC_CREATE = ['INVENTARIO_ORDENES_COMPRA_CREAR'];
const PERM_OC_VIEW = [
  'INVENTARIO_ORDENES_COMPRA_VER',
  'INVENTARIO_ORDENES_COMPRA_CREAR',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const PERM_OC_VIEW_ALL = ['INVENTARIO_ORDENES_COMPRA_VER_TODAS'];
const PERM_OC_REVIEW = ['INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
const PERM_OC_CONVERT = ['INVENTARIO_ORDENES_COMPRA_CONVERTIR'];
const PERM_OC_SUPPLY = ['INVENTARIO_ORDENES_COMPRA_ABASTECER'];
// AM: permiso para reportar recepcion/factura por parte de cocina/cajero y admin.
const PERM_OC_RECEIVE = ['INVENTARIO_ORDENES_COMPRA_RECEPCIONAR', 'INVENTARIO_ORDENES_COMPRA_CREAR'];
// AM: permisos de alta directa de catalogo para bloquear solicitudes_item en perfiles administrativos.
const PERM_ITEM_DIRECT_CREATE = ['INVENTARIO_PRODUCTOS_CREAR', 'INVENTARIO_INSUMOS_CREAR'];

const ESTADO_PENDIENTE = 'PENDIENTE';
const ESTADO_APROBADA = 'APROBADA';
const ESTADO_RECHAZADA = 'RECHAZADA';
const ESTADO_EN_COMPRA = 'EN_COMPRA';
const ESTADO_ABASTECIDA = 'ABASTECIDA';
const ESTADO_CANCELADA = 'CANCELADA';
const ESTADOS = new Set([
  ESTADO_PENDIENTE,
  ESTADO_APROBADA,
  ESTADO_RECHAZADA,
  ESTADO_EN_COMPRA,
  ESTADO_ABASTECIDA,
  ESTADO_CANCELADA
]);

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_TEXT_LEN = 1000;
const MAX_SHORT_TEXT_LEN = 250;
const DISCOUNT_MODE_MONTO = 'MONTO';
const DISCOUNT_MODE_PORCENTAJE = 'PORCENTAJE';
const DISCOUNT_MODES = new Set([DISCOUNT_MODE_MONTO, DISCOUNT_MODE_PORCENTAJE]);

const hasValue = (value) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '');

const parsePositiveInt = (value) => {
  // AM: parse estricto para evitar aceptar valores como "1abc" o "01.2".
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseOptionalPositiveInt = (value) => {
  if (!hasValue(value)) return null;
  return parsePositiveInt(value);
};

const parseNonNegativeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseDiscountMode = (value) => {
  const normalized = String(value ?? DISCOUNT_MODE_MONTO)
    .trim()
    .toUpperCase();
  return DISCOUNT_MODES.has(normalized) ? normalized : null;
};

const parseDateInput = (value) => {
  if (!hasValue(value)) return null;

  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
};

const normalizeText = (value, maxLen = MAX_TEXT_LEN) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;
  return text.slice(0, maxLen);
};

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

const getRequestUserId = (req) => parsePositiveInt(req?.user?.id_usuario);

const sendError = (res, status, code, message, extra = {}) =>
  res.status(status).json({
    ok: false,
    error: true,
    code,
    message,
    ...extra
  });

const isOcSchemaError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('estado_flujo') ||
    message.includes('id_producto') ||
    message.includes('chk_doc_item_xor') ||
    message.includes('chk_dc_item_xor') ||
    message.includes('orden_compra_solicitudes_item') ||
    message.includes('id_archivo_transferencia') ||
    message.includes('id_archivo_factura_recepcion') ||
    message.includes('descuento_tipo') ||
    message.includes('descuento_valor') ||
    message.includes('id_almacen_destino')
  );
};

const sendServerError = (res, context, error) => {
  console.error(`[ordenes_compra_workflow] ${context}:`, error);

  if (isOcSchemaError(error)) {
    return sendError(
      res,
      500,
      'OC_SCHEMA_MISSING',
      'La base de datos aun no tiene las migraciones del workflow de ordenes de compra. Aplica docs/sql/2026-03-11-ordenes-compra-workflow.sql, docs/sql/2026-03-12-ordenes-compra-evidencias-recepcion.sql, docs/sql/2026-03-14-ordenes-compra-por-almacen.sql y docs/sql/2026-03-14-items-multi-almacen-asignacion.sql.'
    );
  }

  // AM: normaliza errores de validacion/constraints de Postgres para no responder 500 en datos invalidos.
  if (error?.code === '23502' || error?.code === '23514' || error?.code === '22P02' || error?.code === '22003') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Los datos de la orden de compra no son validos.');
  }

  if (error?.code === '23503') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'La orden referencia datos que no existen o no son validos.');
  }

  if (error?.code === '23505') {
    return sendError(res, 409, 'CONFLICT', 'La operacion genero un conflicto con datos existentes.');
  }

  return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo completar la operacion solicitada.');
};

const withRollback = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // AM: no-op; se prioriza no ocultar el error original.
  }
};

const stateToLegacyBoolean = (estadoFlujo) => estadoFlujo === ESTADO_ABASTECIDA;

const assertStateTransition = (currentState, expectedState) => currentState === expectedState;

const resolveScope = (rawScope) => {
  const normalized = String(rawScope ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'mine' || normalized === 'propias') return 'mine';
  if (normalized === 'all' || normalized === 'todas') return 'all';
  return null;
};

const userHasAnyPermission = async (idUsuario, permissionNames, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT COALESCE(BOOL_OR(p.nombre_permiso = ANY($2::text[])), false) AS has_permission
      FROM public.roles_usuarios ru
      INNER JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
      INNER JOIN public.permisos p ON p.id_permiso = rp.id_permiso
      WHERE ru.id_usuario = $1
    `,
    [idUsuario, permissionNames]
  );

  return Boolean(result.rows?.[0]?.has_permission);
};

const canUserViewAllOrders = async (req, idUsuario, queryRunner = pool) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (isSuperAdmin) return true;
  return userHasAnyPermission(idUsuario, PERM_OC_VIEW_ALL, queryRunner);
};

// AM: obtiene la sucursal del usuario autenticado desde la relacion usuarios -> empleados.
const getUserSucursalId = async (idUsuario, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT e.id_sucursal
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      WHERE u.id_usuario = $1
      LIMIT 1
    `,
    [idUsuario]
  );
  return parsePositiveInt(result.rows?.[0]?.id_sucursal);
};

const warehouseBelongsToSucursal = async (idAlmacen, idSucursal, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT 1
      FROM public.almacenes a
      WHERE a.id_almacen = $1
        AND a.id_sucursal = $2
      LIMIT 1
    `,
    [idAlmacen, idSucursal]
  );
  return result.rowCount > 0;
};

const orderBelongsToSucursal = async (idOrdenCompra, idSucursal, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT 1
      FROM public.detalle_orden_compras doc
      INNER JOIN public.almacenes a ON a.id_almacen = doc.id_almacen_destino
      WHERE doc.id_orden_compra = $1
        AND a.id_sucursal = $2
      LIMIT 1
    `,
    [idOrdenCompra, idSucursal]
  );
  return result.rowCount > 0;
};

const getOrderById = async (idOrdenCompra, queryRunner = pool) => {
  try {
    const result = await queryRunner.query(
      `
        SELECT
          oc.id_orden_compra,
          oc.id_usuario,
          oc.id_usuario_revisor,
          oc.id_usuario_abastecedor,
          oc.id_usuario_recepcion,
          oc.fecha,
          oc.estado,
          oc.estado_flujo,
          oc.observacion_solicitud,
          oc.comentario_revision,
          oc.fecha_revision,
          oc.fecha_abastecimiento,
          oc.id_archivo_factura_recepcion,
          oc.fecha_recepcion_reportada,
          oc.observacion_recepcion,
          u.nombre_usuario AS solicitante_nombre_usuario,
          ur.nombre_usuario AS revisor_nombre_usuario,
          ua.nombre_usuario AS abastecedor_nombre_usuario,
          ux.nombre_usuario AS recepcion_nombre_usuario,
          rol.roles AS solicitante_roles,
          ar.url_publica AS factura_recepcion_url_publica
        FROM public.orden_compras oc
        LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
        LEFT JOIN public.usuarios ur ON ur.id_usuario = oc.id_usuario_revisor
        LEFT JOIN public.usuarios ua ON ua.id_usuario = oc.id_usuario_abastecedor
        LEFT JOIN public.usuarios ux ON ux.id_usuario = oc.id_usuario_recepcion
        LEFT JOIN public.archivos ar ON ar.id_archivo = oc.id_archivo_factura_recepcion
        LEFT JOIN LATERAL (
          SELECT STRING_AGG(DISTINCT r.nombre, ', ' ORDER BY r.nombre) AS roles
          FROM public.roles_usuarios ru
          INNER JOIN public.roles r ON r.id_rol = ru.id_rol
          WHERE ru.id_usuario = oc.id_usuario
        ) rol ON true
        WHERE oc.id_orden_compra = $1
        LIMIT 1
      `,
      [idOrdenCompra]
    );

    return result.rows?.[0] || null;
  } catch (error) {
    if (!isOcSchemaError(error)) throw error;

    // AM: fallback compatible cuando aun no se aplica migracion opcional 2026-03-12.
    const fallbackResult = await queryRunner.query(
      `
        SELECT
          oc.id_orden_compra,
          oc.id_usuario,
          oc.id_usuario_revisor,
          oc.id_usuario_abastecedor,
          NULL::int AS id_usuario_recepcion,
          oc.fecha,
          oc.estado,
          oc.estado_flujo,
          oc.observacion_solicitud,
          oc.comentario_revision,
          oc.fecha_revision,
          oc.fecha_abastecimiento,
          NULL::int AS id_archivo_factura_recepcion,
          NULL::timestamp AS fecha_recepcion_reportada,
          NULL::text AS observacion_recepcion,
          u.nombre_usuario AS solicitante_nombre_usuario,
          ur.nombre_usuario AS revisor_nombre_usuario,
          ua.nombre_usuario AS abastecedor_nombre_usuario,
          NULL::varchar AS recepcion_nombre_usuario,
          rol.roles AS solicitante_roles,
          NULL::varchar AS factura_recepcion_url_publica
        FROM public.orden_compras oc
        LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
        LEFT JOIN public.usuarios ur ON ur.id_usuario = oc.id_usuario_revisor
        LEFT JOIN public.usuarios ua ON ua.id_usuario = oc.id_usuario_abastecedor
        LEFT JOIN LATERAL (
          SELECT STRING_AGG(DISTINCT r.nombre, ', ' ORDER BY r.nombre) AS roles
          FROM public.roles_usuarios ru
          INNER JOIN public.roles r ON r.id_rol = ru.id_rol
          WHERE ru.id_usuario = oc.id_usuario
        ) rol ON true
        WHERE oc.id_orden_compra = $1
        LIMIT 1
      `,
      [idOrdenCompra]
    );

    return fallbackResult.rows?.[0] || null;
  }
};

const getOrderByIdForUpdate = async (idOrdenCompra, queryRunner = pool) => {
  try {
    const result = await queryRunner.query(
      `
        SELECT
          id_orden_compra,
          id_usuario,
          estado,
          estado_flujo,
          id_archivo_factura_recepcion
        FROM public.orden_compras
        WHERE id_orden_compra = $1
        FOR UPDATE
      `,
      [idOrdenCompra]
    );

    return result.rows?.[0] || null;
  } catch (error) {
    if (!isOcSchemaError(error)) throw error;

    // AM: fallback para esquema previo sin columna de factura de recepcion.
    const fallbackResult = await queryRunner.query(
      `
        SELECT
          id_orden_compra,
          id_usuario,
          estado,
          estado_flujo,
          NULL::int AS id_archivo_factura_recepcion
        FROM public.orden_compras
        WHERE id_orden_compra = $1
        FOR UPDATE
      `,
      [idOrdenCompra]
    );

    return fallbackResult.rows?.[0] || null;
  }
};

const getLatestCompraByOrden = async (idOrdenCompra, queryRunner = pool) => {
  try {
    const result = await queryRunner.query(
      `
        SELECT
          c.id_compra,
          c.id_orden_compra,
          c.id_proveedor,
          c.fecha,
          c.total,
          c.estado,
          c.sub_total,
          c.descuento,
          c.isv,
          c.total_detalle,
          c.id_archivo_transferencia,
          c.referencia_transferencia,
          c.descuento_tipo,
          c.descuento_valor,
          a.url_publica AS transferencia_url_publica
        FROM public.compras c
        LEFT JOIN public.archivos a ON a.id_archivo = c.id_archivo_transferencia
        WHERE c.id_orden_compra = $1
        ORDER BY c.id_compra DESC
        LIMIT 1
      `,
      [idOrdenCompra]
    );

    return result.rows?.[0] || null;
  } catch (error) {
    if (!isOcSchemaError(error)) throw error;

    // AM: fallback para esquema previo sin columnas opcionales de transferencia/descuento dual.
    const fallbackResult = await queryRunner.query(
      `
        SELECT
          c.id_compra,
          c.id_orden_compra,
          c.id_proveedor,
          c.fecha,
          c.total,
          c.estado,
          c.sub_total,
          c.descuento,
          c.isv,
          c.total_detalle,
          NULL::int AS id_archivo_transferencia,
          NULL::text AS referencia_transferencia,
          NULL::varchar AS descuento_tipo,
          NULL::numeric AS descuento_valor,
          NULL::varchar AS transferencia_url_publica
        FROM public.compras c
        WHERE c.id_orden_compra = $1
        ORDER BY c.id_compra DESC
        LIMIT 1
      `,
      [idOrdenCompra]
    );

    return fallbackResult.rows?.[0] || null;
  }
};

const getOrderDetails = async (idOrdenCompra, idCompra, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT
        doc.id_detalle_orden,
        doc.cantidad_orden,
        doc.id_insumo,
        doc.id_producto,
        doc.id_almacen_destino,
        CASE
          WHEN doc.id_producto IS NOT NULL THEN 'producto'
          ELSE 'insumo'
        END AS item_tipo,
        COALESCE(p.nombre_producto, i.nombre_insumo) AS item_nombre,
        COALESCE(p.precio, i.precio, 0)::numeric AS precio_referencia,
        COALESCE(p.id_almacen, i.id_almacen) AS id_almacen_item,
        ad.nombre AS almacen_destino_nombre,
        COALESCE(p.cantidad, i.cantidad, 0)::int AS stock_actual,
        COALESCE(p.stock_minimo, i.stock_minimo, 0)::int AS stock_minimo,
        dc.id_detalle_compra,
        dc.id_compra,
        dc.id_almacen_destino AS id_almacen_destino_compra,
        dc.cantidad AS cantidad_compra,
        dc.sub_total AS sub_total_compra,
        dc.descuento AS descuento_compra,
        dc.total_detalle_compra
      FROM public.detalle_orden_compras doc
      LEFT JOIN public.productos p ON p.id_producto = doc.id_producto
      LEFT JOIN public.insumos i ON i.id_insumo = doc.id_insumo
      LEFT JOIN public.almacenes ad ON ad.id_almacen = doc.id_almacen_destino
      LEFT JOIN LATERAL (
        SELECT
          dc1.id_detalle_compra,
          dc1.id_compra,
          dc1.id_almacen_destino,
          dc1.cantidad,
          dc1.sub_total,
          dc1.descuento,
          dc1.total_detalle_compra
        FROM public.detalle_compras dc1
        WHERE dc1.id_compra = $2
          AND (
            (doc.id_producto IS NOT NULL AND dc1.id_producto = doc.id_producto)
            OR (doc.id_insumo IS NOT NULL AND dc1.id_insumo = doc.id_insumo)
          )
          AND (
            doc.id_almacen_destino IS NULL
            OR dc1.id_almacen_destino = doc.id_almacen_destino
          )
        ORDER BY dc1.id_detalle_compra DESC
        LIMIT 1
      ) dc ON true
      WHERE doc.id_orden_compra = $1
      ORDER BY doc.id_detalle_orden ASC
    `,
    [idOrdenCompra, idCompra || null]
  );

  return result.rows || [];
};

const getOrderItemRequests = async (idOrdenCompra, queryRunner = pool) => {
  try {
    const result = await queryRunner.query(
      `
        SELECT
          si.id_solicitud_item,
          si.id_orden_compra,
          si.tipo_item,
          si.nombre_sugerido,
          si.descripcion,
          si.cantidad_sugerida,
          si.estado,
          si.id_usuario_creador,
          si.fecha_creacion,
          si.id_usuario_revisor,
          si.fecha_revision,
          si.comentario_revision,
          uc.nombre_usuario AS creador_nombre_usuario,
          ur.nombre_usuario AS revisor_nombre_usuario
        FROM public.orden_compra_solicitudes_item si
        LEFT JOIN public.usuarios uc ON uc.id_usuario = si.id_usuario_creador
        LEFT JOIN public.usuarios ur ON ur.id_usuario = si.id_usuario_revisor
        WHERE si.id_orden_compra = $1
        ORDER BY si.id_solicitud_item ASC
      `,
      [idOrdenCompra]
    );

    return result.rows || [];
  } catch (error) {
    if (!isOcSchemaError(error)) throw error;
    // AM: fallback para BD sin tabla de solicitudes de item (migracion 2026-03-12 pendiente).
    return [];
  }
};

const validateOrderVisibility = async (req, idUsuario, orderRow, queryRunner = pool) => {
  if (!orderRow) return false;

  const canViewAll = await canUserViewAllOrders(req, idUsuario, queryRunner);
  if (canViewAll) return true;

  const userSucursalId = await getUserSucursalId(idUsuario, queryRunner);
  if (!userSucursalId) return false;

  return orderBelongsToSucursal(orderRow.id_orden_compra, userSucursalId, queryRunner);
};

const parseCreateDetails = (rawDetails) => {
  if (!Array.isArray(rawDetails)) {
    return { ok: false, message: 'detalles debe ser un arreglo.' };
  }

  if (rawDetails.length === 0) {
    return { ok: true, details: [] };
  }

  const aggregatedMap = new Map();

  for (const detail of rawDetails) {
    const itemTipo = String(detail?.item_tipo ?? '')
      .trim()
      .toLowerCase();
    const idItem = parsePositiveInt(detail?.id_item);
    const cantidad = parsePositiveInt(detail?.cantidad);

    if (!['producto', 'insumo'].includes(itemTipo)) {
      return { ok: false, message: 'item_tipo debe ser "producto" o "insumo".' };
    }

    if (!idItem) {
      return { ok: false, message: 'id_item debe ser un entero mayor a 0.' };
    }

    if (!cantidad) {
      return { ok: false, message: 'cantidad debe ser un entero mayor a 0.' };
    }

    const rawAlmacenes = Array.isArray(detail?.id_almacenes)
      ? detail.id_almacenes
      : hasValue(detail?.id_almacen_destino)
      ? [detail.id_almacen_destino]
      : [];

    if (rawAlmacenes.length === 0) {
      return {
        ok: false,
        message: 'Cada detalle debe incluir al menos un id_almacen_destino.'
      };
    }

    const almacenesSet = new Set();
    for (const rawAlmacenId of rawAlmacenes) {
      const idAlmacen = parsePositiveInt(rawAlmacenId);
      if (!idAlmacen) {
        return {
          ok: false,
          message: 'id_almacenes contiene un id_almacen_destino invalido.'
        };
      }
      almacenesSet.add(idAlmacen);
    }

    if (almacenesSet.size !== 1) {
      return {
        ok: false,
        message: 'Cada detalle debe incluir exactamente 1 id_almacen_destino.'
      };
    }

    const idAlmacenDestino = Array.from(almacenesSet)[0];
    const key = `${itemTipo}:${idItem}:${idAlmacenDestino}`;
    const previous = aggregatedMap.get(key);
    if (!previous) {
      aggregatedMap.set(key, {
        item_tipo: itemTipo,
        id_item: idItem,
        id_almacen_destino: idAlmacenDestino,
        cantidad
      });
      continue;
    }

    previous.cantidad += cantidad;
  }

  return { ok: true, details: Array.from(aggregatedMap.values()) };
};

const parseItemCreationRequests = (rawRequests) => {
  if (!hasValue(rawRequests)) {
    return { ok: true, requests: [] };
  }

  if (!Array.isArray(rawRequests)) {
    return { ok: false, message: 'solicitudes_item debe ser un arreglo.' };
  }

  const requests = [];
  for (const row of rawRequests) {
    const tipoItem = String(row?.tipo_item ?? '')
      .trim()
      .toLowerCase();
    const nombreSugerido = normalizeText(row?.nombre_sugerido || row?.nombre, 160);
    const descripcion = normalizeText(row?.descripcion, 500);
    const cantidadSugerida =
      hasValue(row?.cantidad_sugerida) || hasValue(row?.cantidad)
        ? parsePositiveInt(row?.cantidad_sugerida ?? row?.cantidad)
        : 1;

    if (!['producto', 'insumo'].includes(tipoItem)) {
      return { ok: false, message: 'tipo_item de solicitudes_item debe ser "producto" o "insumo".' };
    }

    if (!nombreSugerido) {
      return { ok: false, message: 'nombre_sugerido es obligatorio en solicitudes_item.' };
    }

    if (!cantidadSugerida) {
      return { ok: false, message: 'cantidad_sugerida debe ser un entero mayor a 0.' };
    }

    requests.push({
      tipo_item: tipoItem,
      nombre_sugerido: nombreSugerido,
      descripcion,
      cantidad_sugerida: cantidadSugerida
    });
  }

  return { ok: true, requests };
};

const validateCreateItemsExistence = async (details, queryRunner = pool) => {
  const productIds = details
    .filter((detail) => detail.item_tipo === 'producto')
    .map((detail) => detail.id_item);
  const insumoIds = details
    .filter((detail) => detail.item_tipo === 'insumo')
    .map((detail) => detail.id_item);
  const almacenIds = Array.from(
    new Set(
      details
        .map((detail) => parsePositiveInt(detail?.id_almacen_destino))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  if (productIds.length > 0) {
    const productRows = await queryRunner.query(
      `
        SELECT id_producto, COALESCE(estado, true) AS estado
        FROM public.productos
        WHERE id_producto = ANY($1::int[])
      `,
      [productIds]
    );

    const map = new Map(productRows.rows.map((row) => [Number(row.id_producto), Boolean(row.estado)]));
    for (const idProducto of productIds) {
      if (!map.has(idProducto)) {
        return { ok: false, message: `El producto ${idProducto} no existe.` };
      }
      if (!map.get(idProducto)) {
        return { ok: false, message: `El producto ${idProducto} esta inactivo.` };
      }
    }
  }

  if (insumoIds.length > 0) {
    const insumoRows = await queryRunner.query(
      `
        SELECT id_insumo, COALESCE(estado, true) AS estado
        FROM public.insumos
        WHERE id_insumo = ANY($1::int[])
      `,
      [insumoIds]
    );

    const map = new Map(insumoRows.rows.map((row) => [Number(row.id_insumo), Boolean(row.estado)]));
    for (const idInsumo of insumoIds) {
      if (!map.has(idInsumo)) {
        return { ok: false, message: `El insumo ${idInsumo} no existe.` };
      }
      if (!map.get(idInsumo)) {
        return { ok: false, message: `El insumo ${idInsumo} esta inactivo.` };
      }
    }
  }

  if (almacenIds.length > 0) {
    const almacenRows = await queryRunner.query(
      `
        SELECT a.id_almacen
        FROM public.almacenes a
        WHERE a.id_almacen = ANY($1::int[])
      `,
      [almacenIds]
    );

    const almacenSet = new Set(almacenRows.rows.map((row) => Number(row.id_almacen)));
    for (const idAlmacen of almacenIds) {
      if (!almacenSet.has(idAlmacen)) {
        return { ok: false, message: `El almacen destino ${idAlmacen} no existe.` };
      }
    }
  }

  // AM: valida que cada item este asignado al almacen destino seleccionado.
  // AM: fallback legacy cuando aun no existen tablas *_almacenes: se usa columna id_almacen del item.
  for (const detail of details) {
    const idAlmacenDestino = parsePositiveInt(detail?.id_almacen_destino);
    if (!idAlmacenDestino) {
      return { ok: false, message: 'Cada detalle requiere un id_almacen_destino valido.' };
    }

    try {
      if (detail.item_tipo === 'producto') {
        const assigned = await queryRunner.query(
          `
            SELECT 1
            FROM public.productos_almacenes pa
            WHERE pa.id_producto = $1
              AND pa.id_almacen = $2
            LIMIT 1
          `,
          [detail.id_item, idAlmacenDestino]
        );
        if (assigned.rowCount === 0) {
          return {
            ok: false,
            message: `El producto ${detail.id_item} no esta asignado al almacen destino ${idAlmacenDestino}.`
          };
        }
      } else {
        const assigned = await queryRunner.query(
          `
            SELECT 1
            FROM public.insumos_almacenes ia
            WHERE ia.id_insumo = $1
              AND ia.id_almacen = $2
            LIMIT 1
          `,
          [detail.id_item, idAlmacenDestino]
        );
        if (assigned.rowCount === 0) {
          return {
            ok: false,
            message: `El insumo ${detail.id_item} no esta asignado al almacen destino ${idAlmacenDestino}.`
          };
        }
      }
    } catch (error) {
      if (error?.code !== '42P01') throw error;

      if (detail.item_tipo === 'producto') {
        const legacyRow = await queryRunner.query(
          `
            SELECT 1
            FROM public.productos p
            WHERE p.id_producto = $1
              AND p.id_almacen = $2
            LIMIT 1
          `,
          [detail.id_item, idAlmacenDestino]
        );
        if (legacyRow.rowCount === 0) {
          return {
            ok: false,
            message: `El producto ${detail.id_item} no pertenece al almacen destino ${idAlmacenDestino}.`
          };
        }
      } else {
        const legacyRow = await queryRunner.query(
          `
            SELECT 1
            FROM public.insumos i
            WHERE i.id_insumo = $1
              AND i.id_almacen = $2
            LIMIT 1
          `,
          [detail.id_item, idAlmacenDestino]
        );
        if (legacyRow.rowCount === 0) {
          return {
            ok: false,
            message: `El insumo ${detail.id_item} no pertenece al almacen destino ${idAlmacenDestino}.`
          };
        }
      }
    }
  }

  return { ok: true };
};

const validateProveedor = async (idProveedor, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT 1
      FROM public.proveedores
      WHERE id_proveedor = $1
      LIMIT 1
    `,
    [idProveedor]
  );

  return result.rowCount > 0;
};

const validateArchivo = async (idArchivo, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT 1
      FROM public.archivos
      WHERE id_archivo = $1
        AND COALESCE(estado, true) = true
      LIMIT 1
    `,
    [idArchivo]
  );

  return result.rowCount > 0;
};

const parseConvertDetailOverrides = (rawDetails) => {
  if (!hasValue(rawDetails)) {
    return { ok: true, map: new Map() };
  }

  if (!Array.isArray(rawDetails)) {
    return { ok: false, message: 'detalles debe ser un arreglo.' };
  }

  const map = new Map();
  for (const row of rawDetails) {
    const idDetalleOrden = parsePositiveInt(row?.id_detalle_orden);
    if (!idDetalleOrden) {
      return { ok: false, message: 'id_detalle_orden invalido en detalles de conversion.' };
    }

    const precioUnitario = parseNonNegativeNumber(row?.precio_unitario);
    if (precioUnitario === null) {
      return { ok: false, message: `precio_unitario invalido para id_detalle_orden=${idDetalleOrden}.` };
    }

    const descuento = hasValue(row?.descuento) ? parseNonNegativeNumber(row?.descuento) : 0;
    if (descuento === null) {
      return { ok: false, message: `descuento invalido para id_detalle_orden=${idDetalleOrden}.` };
    }

    map.set(idDetalleOrden, {
      precio_unitario: precioUnitario,
      descuento
    });
  }

  return { ok: true, map };
};

const parseGlobalDiscount = (rawTipo, rawValor) => {
  const descuentoTipo = hasValue(rawTipo) ? parseDiscountMode(rawTipo) : DISCOUNT_MODE_MONTO;
  if (!descuentoTipo) {
    return { ok: false, message: 'descuento_tipo debe ser MONTO o PORCENTAJE.' };
  }

  const descuentoValor = hasValue(rawValor) ? parseNonNegativeNumber(rawValor) : 0;
  if (descuentoValor === null) {
    return { ok: false, message: 'descuento_valor debe ser un numero mayor o igual a 0.' };
  }

  if (descuentoTipo === DISCOUNT_MODE_PORCENTAJE && descuentoValor > 100) {
    return { ok: false, message: 'descuento_valor no puede exceder 100 cuando descuento_tipo es PORCENTAJE.' };
  }

  return { ok: true, descuento_tipo: descuentoTipo, descuento_valor: round2(descuentoValor) };
};

router.get('/orden_compras/workflow', checkPermission(PERM_OC_VIEW), async (req, res) => {
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const scope = resolveScope(req.query?.scope);
    if (!scope) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'scope invalido. Use mine o all.');
    }

    const estadoFiltroRaw = String(req.query?.estado ?? '')
      .trim()
      .toUpperCase();
    const estadoFiltro = estadoFiltroRaw ? estadoFiltroRaw : null;
    if (estadoFiltro && !ESTADOS.has(estadoFiltro)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'estado invalido.');
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal);
    if (hasValue(req.query?.id_sucursal) && !idSucursalFilter) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_sucursal invalido.');
    }

    const rawAlmacenFilter = hasValue(req.query?.id_almacen_destino)
      ? req.query?.id_almacen_destino
      : req.query?.id_almacen;
    const idAlmacenFilter = parseOptionalPositiveInt(rawAlmacenFilter);
    if (hasValue(rawAlmacenFilter) && !idAlmacenFilter) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_almacen invalido.');
    }

    const page = parsePositiveInt(req.query?.page) || 1;
    const limit = Math.min(parsePositiveInt(req.query?.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const search = normalizeText(req.query?.q, 120);

    const canViewAll = await canUserViewAllOrders(req, idUsuario);
    if (scope === 'all' && !canViewAll) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'No tienes permiso para ver todas las ordenes. Usa scope=mine.'
      );
    }

    let effectiveSucursalFilter = idSucursalFilter;
    if (!canViewAll) {
      const userSucursalId = await getUserSucursalId(idUsuario);
      if (!userSucursalId) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Tu usuario no tiene sucursal asignada. Contacta al administrador.'
        );
      }

      if (idSucursalFilter && idSucursalFilter !== userSucursalId) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'No tienes permiso para consultar ordenes de otra sucursal.'
        );
      }

      effectiveSucursalFilter = userSucursalId;
    }

    const whereParts = [];
    const params = [];

    if (scope === 'mine' && canViewAll) {
      params.push(idUsuario);
      whereParts.push(`oc.id_usuario = $${params.length}`);
    }

    if (effectiveSucursalFilter) {
      params.push(effectiveSucursalFilter);
      whereParts.push(`
        EXISTS (
          SELECT 1
          FROM public.detalle_orden_compras doc_scope
          INNER JOIN public.almacenes a_scope ON a_scope.id_almacen = doc_scope.id_almacen_destino
          WHERE doc_scope.id_orden_compra = oc.id_orden_compra
            AND a_scope.id_sucursal = $${params.length}
        )
      `);
    }

    if (idAlmacenFilter) {
      params.push(idAlmacenFilter);
      whereParts.push(`
        EXISTS (
          SELECT 1
          FROM public.detalle_orden_compras doc_al
          WHERE doc_al.id_orden_compra = oc.id_orden_compra
            AND doc_al.id_almacen_destino = $${params.length}
        )
      `);
    }

    if (estadoFiltro) {
      params.push(estadoFiltro);
      whereParts.push(`oc.estado_flujo = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      whereParts.push(`
        (
          CAST(oc.id_orden_compra AS text) ILIKE $${params.length}
          OR COALESCE(oc.observacion_solicitud, '') ILIKE $${params.length}
          OR COALESCE(oc.comentario_revision, '') ILIKE $${params.length}
          OR COALESCE(u.nombre_usuario, '') ILIKE $${params.length}
        )
      `);
    }

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countResult = await pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM public.orden_compras oc
        LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
        ${whereSql}
      `,
      params
    );
    const total = Number(countResult.rows?.[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    params.push(limit);
    const limitRef = `$${params.length}`;
    params.push(offset);
    const offsetRef = `$${params.length}`;

    let rowsResult;
    try {
      rowsResult = await pool.query(
        `
          SELECT
            oc.id_orden_compra,
            oc.id_usuario,
            oc.id_usuario_revisor,
            oc.id_usuario_abastecedor,
            oc.id_usuario_recepcion,
            oc.fecha,
            oc.estado,
            oc.estado_flujo,
            oc.observacion_solicitud,
            oc.comentario_revision,
            oc.fecha_revision,
            oc.fecha_abastecimiento,
            oc.id_archivo_factura_recepcion,
            oc.fecha_recepcion_reportada,
            oc.observacion_recepcion,
            u.nombre_usuario AS solicitante_nombre_usuario,
            rol.roles AS solicitante_roles,
            ur.nombre_usuario AS revisor_nombre_usuario,
            ua.nombre_usuario AS abastecedor_nombre_usuario,
            ux.nombre_usuario AS recepcion_nombre_usuario,
            ar.url_publica AS factura_recepcion_url_publica,
            COALESCE(det.total_items, 0)::int AS total_items,
            COALESCE(det.total_cantidad, 0)::int AS total_cantidad,
            COALESCE(sit.total_solicitudes_item, 0)::int AS total_solicitudes_item,
            compra.id_compra AS id_compra_actual,
            compra.total AS total_compra_actual,
            compra.fecha AS fecha_compra_actual,
            compra.id_archivo_transferencia AS id_archivo_transferencia_actual,
            compra.transferencia_url_publica AS transferencia_url_publica_actual
          FROM public.orden_compras oc
          LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
          LEFT JOIN public.usuarios ur ON ur.id_usuario = oc.id_usuario_revisor
          LEFT JOIN public.usuarios ua ON ua.id_usuario = oc.id_usuario_abastecedor
          LEFT JOIN public.usuarios ux ON ux.id_usuario = oc.id_usuario_recepcion
          LEFT JOIN public.archivos ar ON ar.id_archivo = oc.id_archivo_factura_recepcion
          LEFT JOIN LATERAL (
            SELECT STRING_AGG(DISTINCT r.nombre, ', ' ORDER BY r.nombre) AS roles
            FROM public.roles_usuarios ru
            INNER JOIN public.roles r ON r.id_rol = ru.id_rol
            WHERE ru.id_usuario = oc.id_usuario
          ) rol ON true
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS total_items,
              COALESCE(SUM(doc.cantidad_orden), 0)::int AS total_cantidad
            FROM public.detalle_orden_compras doc
            WHERE doc.id_orden_compra = oc.id_orden_compra
          ) det ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS total_solicitudes_item
            FROM public.orden_compra_solicitudes_item si
            WHERE si.id_orden_compra = oc.id_orden_compra
          ) sit ON true
          LEFT JOIN LATERAL (
            SELECT c.id_compra, c.total, c.fecha, c.id_archivo_transferencia, a.url_publica AS transferencia_url_publica
            FROM public.compras c
            LEFT JOIN public.archivos a ON a.id_archivo = c.id_archivo_transferencia
            WHERE c.id_orden_compra = oc.id_orden_compra
            ORDER BY c.id_compra DESC
            LIMIT 1
          ) compra ON true
          ${whereSql}
          ORDER BY oc.id_orden_compra DESC
          LIMIT ${limitRef}
          OFFSET ${offsetRef}
        `,
        params
      );
    } catch (error) {
      if (!isOcSchemaError(error)) throw error;

      // AM: fallback para esquemas sin migracion 2026-03-12 (sin solicitudes/evidencias en OC).
      rowsResult = await pool.query(
        `
          SELECT
            oc.id_orden_compra,
            oc.id_usuario,
            oc.id_usuario_revisor,
            oc.id_usuario_abastecedor,
            NULL::int AS id_usuario_recepcion,
            oc.fecha,
            oc.estado,
            oc.estado_flujo,
            oc.observacion_solicitud,
            oc.comentario_revision,
            oc.fecha_revision,
            oc.fecha_abastecimiento,
            NULL::int AS id_archivo_factura_recepcion,
            NULL::timestamp AS fecha_recepcion_reportada,
            NULL::text AS observacion_recepcion,
            u.nombre_usuario AS solicitante_nombre_usuario,
            rol.roles AS solicitante_roles,
            ur.nombre_usuario AS revisor_nombre_usuario,
            ua.nombre_usuario AS abastecedor_nombre_usuario,
            NULL::varchar AS recepcion_nombre_usuario,
            NULL::varchar AS factura_recepcion_url_publica,
            COALESCE(det.total_items, 0)::int AS total_items,
            COALESCE(det.total_cantidad, 0)::int AS total_cantidad,
            0::int AS total_solicitudes_item,
            compra.id_compra AS id_compra_actual,
            compra.total AS total_compra_actual,
            compra.fecha AS fecha_compra_actual,
            NULL::int AS id_archivo_transferencia_actual,
            NULL::varchar AS transferencia_url_publica_actual
          FROM public.orden_compras oc
          LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
          LEFT JOIN public.usuarios ur ON ur.id_usuario = oc.id_usuario_revisor
          LEFT JOIN public.usuarios ua ON ua.id_usuario = oc.id_usuario_abastecedor
          LEFT JOIN LATERAL (
            SELECT STRING_AGG(DISTINCT r.nombre, ', ' ORDER BY r.nombre) AS roles
            FROM public.roles_usuarios ru
            INNER JOIN public.roles r ON r.id_rol = ru.id_rol
            WHERE ru.id_usuario = oc.id_usuario
          ) rol ON true
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS total_items,
              COALESCE(SUM(doc.cantidad_orden), 0)::int AS total_cantidad
            FROM public.detalle_orden_compras doc
            WHERE doc.id_orden_compra = oc.id_orden_compra
          ) det ON true
          LEFT JOIN LATERAL (
            SELECT c.id_compra, c.total, c.fecha
            FROM public.compras c
            WHERE c.id_orden_compra = oc.id_orden_compra
            ORDER BY c.id_compra DESC
            LIMIT 1
          ) compra ON true
          ${whereSql}
          ORDER BY oc.id_orden_compra DESC
          LIMIT ${limitRef}
          OFFSET ${offsetRef}
        `,
        params
      );
    }

    return res.status(200).json({
      ok: true,
      data: rowsResult.rows || [],
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    return sendServerError(res, 'GET /orden_compras/workflow', error);
  }
});

router.get('/orden_compras/workflow/:id_orden_compra', checkPermission(PERM_OC_VIEW), async (req, res) => {
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const orderRow = await getOrderById(idOrdenCompra);
    if (!orderRow) {
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    const canView = await validateOrderVisibility(req, idUsuario, orderRow);
    if (!canView) {
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para ver esta orden.');
    }

    const compraActual = await getLatestCompraByOrden(idOrdenCompra);
    const detalles = await getOrderDetails(idOrdenCompra, compraActual?.id_compra || null);
    const solicitudesItem = await getOrderItemRequests(idOrdenCompra);

    return res.status(200).json({
      ok: true,
      data: {
        orden: orderRow,
        compra_actual: compraActual || null,
        detalles,
        solicitudes_item: solicitudesItem
      }
    });
  } catch (error) {
    return sendServerError(res, 'GET /orden_compras/workflow/:id_orden_compra', error);
  }
});

router.post('/orden_compras/workflow', checkPermission(PERM_OC_CREATE), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const parsedDetails = parseCreateDetails(req.body?.detalles || []);
    if (!parsedDetails.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', parsedDetails.message);
    }

    const parsedItemRequests = parseItemCreationRequests(req.body?.solicitudes_item);
    if (!parsedItemRequests.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', parsedItemRequests.message);
    }

    if (parsedItemRequests.requests.length > 0) {
      // AM: perfiles con alta directa deben crear productos/insumos en sus submodulos, no por solicitud_item.
      const hasDirectCatalogCreate = await userHasAnyPermission(idUsuario, PERM_ITEM_DIRECT_CREATE, client);
      if (hasDirectCatalogCreate) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Tu perfil puede crear productos/insumos directamente. Usa el submodulo correspondiente.'
        );
      }
    }

    if (parsedDetails.details.length === 0 && parsedItemRequests.requests.length === 0) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Debes agregar al menos un detalle de item existente o una solicitud de item nuevo.'
      );
    }

    if (parsedDetails.details.length > 0) {
      const existencia = await validateCreateItemsExistence(parsedDetails.details, client);
      if (!existencia.ok) {
        return sendError(res, 400, 'VALIDATION_ERROR', existencia.message);
      }
    }

    const canViewAll = await canUserViewAllOrders(req, idUsuario, client);
    if (!canViewAll && parsedDetails.details.length > 0) {
      const userSucursalId = await getUserSucursalId(idUsuario, client);
      if (!userSucursalId) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Tu usuario no tiene sucursal asignada para crear solicitudes.'
        );
      }

      const requestedWarehouseIds = Array.from(
        new Set(
          parsedDetails.details
            .map((detail) => parsePositiveInt(detail?.id_almacen_destino))
            .filter((id) => Number.isInteger(id) && id > 0)
        )
      );

      if (requestedWarehouseIds.length > 0) {
        const allowedResult = await client.query(
          `
            SELECT a.id_almacen
            FROM public.almacenes a
            WHERE a.id_almacen = ANY($1::int[])
              AND a.id_sucursal = $2
          `,
          [requestedWarehouseIds, userSucursalId]
        );
        const allowedSet = new Set(allowedResult.rows.map((row) => Number(row.id_almacen)));
        for (const idAlmacen of requestedWarehouseIds) {
          if (!allowedSet.has(idAlmacen)) {
            return sendError(
              res,
              403,
              'FORBIDDEN',
              `No puedes crear solicitudes para el almacen ${idAlmacen} porque pertenece a otra sucursal.`
            );
          }
        }
      }
    }

    const observacionSolicitud = normalizeText(req.body?.observacion, MAX_TEXT_LEN);

    await client.query('BEGIN');

    // AM: crea la orden en estado pendiente con trazabilidad del solicitante.
    const ordenResult = await client.query(
      `
        INSERT INTO public.orden_compras (
          id_usuario,
          fecha,
          estado,
          estado_flujo,
          observacion_solicitud
        )
        VALUES ($1, CURRENT_DATE, false, $2, $3)
        RETURNING id_orden_compra
      `,
      [idUsuario, ESTADO_PENDIENTE, observacionSolicitud]
    );
    const idOrdenCompra = Number(ordenResult.rows?.[0]?.id_orden_compra);

    for (const detail of parsedDetails.details) {
      const idProducto = detail.item_tipo === 'producto' ? detail.id_item : null;
      const idInsumo = detail.item_tipo === 'insumo' ? detail.id_item : null;

      // AM: inserta detalle con XOR de item (producto/insumo) alineado al constraint DB.
      await client.query(
        `
          INSERT INTO public.detalle_orden_compras (
            cantidad_orden,
            id_orden_compra,
            id_insumo,
            id_producto,
            id_almacen_destino
          )
          VALUES ($1, $2, $3, $4, $5)
        `,
        [detail.cantidad, idOrdenCompra, idInsumo, idProducto, detail.id_almacen_destino]
      );
    }

    for (const requestItem of parsedItemRequests.requests) {
      // AM: registra solicitudes de alta para items que aun no existen en catalogo.
      await client.query(
        `
          INSERT INTO public.orden_compra_solicitudes_item (
            id_orden_compra,
            tipo_item,
            nombre_sugerido,
            descripcion,
            cantidad_sugerida,
            estado,
            id_usuario_creador
          )
          VALUES ($1, $2, $3, $4, $5, 'PENDIENTE', $6)
        `,
        [
          idOrdenCompra,
          requestItem.tipo_item,
          requestItem.nombre_sugerido,
          requestItem.descripcion,
          requestItem.cantidad_sugerida,
          idUsuario
        ]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      message: 'Solicitud de orden de compra creada correctamente.',
      id_orden_compra: idOrdenCompra
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow', error);
  } finally {
    client.release();
  }
});

router.put('/orden_compras/workflow/:id_orden_compra/detalles', checkPermission(PERM_OC_REVIEW), async (req, res) => {
  const client = await pool.connect();
  try {
    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const payloadUpdates = Array.isArray(req.body?.actualizar) ? req.body.actualizar : [];
    const payloadDeletes = Array.isArray(req.body?.eliminar) ? req.body.eliminar : [];
    if (payloadUpdates.length === 0 && payloadDeletes.length === 0) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Debes enviar actualizar o eliminar para modificar detalles.'
      );
    }

    const updates = [];
    for (const row of payloadUpdates) {
      const idDetalleOrden = parsePositiveInt(row?.id_detalle_orden);
      const cantidad = parsePositiveInt(row?.cantidad);
      if (!idDetalleOrden || !cantidad) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'actualizar requiere id_detalle_orden y cantidad validos.');
      }
      updates.push({ id_detalle_orden: idDetalleOrden, cantidad });
    }

    const deleteSet = new Set();
    for (const rawId of payloadDeletes) {
      const idDetalleOrden = parsePositiveInt(rawId);
      if (!idDetalleOrden) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'eliminar contiene id_detalle_orden invalido.');
      }
      deleteSet.add(idDetalleOrden);
    }
    const deleteIds = Array.from(deleteSet);

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    if (!assertStateTransition(orderRow.estado_flujo, ESTADO_PENDIENTE)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Solo se pueden editar detalles de ordenes en estado ${ESTADO_PENDIENTE}.`
      );
    }

    const detalleRows = await client.query(
      `
        SELECT id_detalle_orden
        FROM public.detalle_orden_compras
        WHERE id_orden_compra = $1
      `,
      [idOrdenCompra]
    );
    const currentDetailIds = new Set(detalleRows.rows.map((row) => Number(row.id_detalle_orden)));

    for (const row of updates) {
      if (!currentDetailIds.has(row.id_detalle_orden)) {
        await withRollback(client);
        return sendError(
          res,
          404,
          'NOT_FOUND',
          `No existe el detalle ${row.id_detalle_orden} dentro de la orden #${idOrdenCompra}.`
        );
      }
      if (deleteSet.has(row.id_detalle_orden)) {
        await withRollback(client);
        return sendError(
          res,
          400,
          'VALIDATION_ERROR',
          `No puedes actualizar y eliminar el mismo detalle (${row.id_detalle_orden}).`
        );
      }
    }

    for (const idDetalleOrden of deleteIds) {
      if (!currentDetailIds.has(idDetalleOrden)) {
        await withRollback(client);
        return sendError(
          res,
          404,
          'NOT_FOUND',
          `No existe el detalle ${idDetalleOrden} dentro de la orden #${idOrdenCompra}.`
        );
      }
    }

    for (const row of updates) {
      // AM: actualiza cantidad por linea antes de aprobar/rechazar la orden.
      await client.query(
        `
          UPDATE public.detalle_orden_compras
          SET cantidad_orden = $1
          WHERE id_detalle_orden = $2
            AND id_orden_compra = $3
        `,
        [row.cantidad, row.id_detalle_orden, idOrdenCompra]
      );
    }

    if (deleteIds.length > 0) {
      // AM: elimina lineas innecesarias antes de la aprobacion.
      await client.query(
        `
          DELETE FROM public.detalle_orden_compras
          WHERE id_orden_compra = $1
            AND id_detalle_orden = ANY($2::int[])
        `,
        [idOrdenCompra, deleteIds]
      );
    }

    const remainingRows = await client.query(
      `
        SELECT COUNT(*)::int AS total
        FROM public.detalle_orden_compras
        WHERE id_orden_compra = $1
      `,
      [idOrdenCompra]
    );
    const remaining = Number(remainingRows.rows?.[0]?.total || 0);
    if (remaining <= 0) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'La orden no puede quedar sin detalles. Agrega al menos una linea antes de guardar.'
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Detalle de la orden actualizado correctamente.',
      data: {
        id_orden_compra: idOrdenCompra,
        detalles_actualizados: updates.length,
        detalles_eliminados: deleteIds.length,
        detalles_restantes: remaining
      }
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'PUT /orden_compras/workflow/:id_orden_compra/detalles', error);
  } finally {
    client.release();
  }
});

router.post('/orden_compras/workflow/:id_orden_compra/aprobar', checkPermission(PERM_OC_REVIEW), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    if (!assertStateTransition(orderRow.estado_flujo, ESTADO_PENDIENTE)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `No se puede aprobar una orden en estado ${orderRow.estado_flujo}.`
      );
    }

    const comentarioRevision = normalizeText(req.body?.comentario, MAX_TEXT_LEN);

    // AM: transicion controlada de estado pendiente a aprobada.
    await client.query(
      `
        UPDATE public.orden_compras
        SET
          estado_flujo = $1,
          estado = $2,
          comentario_revision = $3,
          id_usuario_revisor = $4,
          fecha_revision = NOW()
        WHERE id_orden_compra = $5
      `,
      [ESTADO_APROBADA, stateToLegacyBoolean(ESTADO_APROBADA), comentarioRevision, idUsuario, idOrdenCompra]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Orden aprobada correctamente.'
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow/:id_orden_compra/aprobar', error);
  } finally {
    client.release();
  }
});

router.post('/orden_compras/workflow/:id_orden_compra/rechazar', checkPermission(PERM_OC_REVIEW), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const comentarioRevision = normalizeText(req.body?.comentario, MAX_TEXT_LEN);
    if (!comentarioRevision) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Debe enviar un comentario al rechazar la orden.'
      );
    }

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    if (!assertStateTransition(orderRow.estado_flujo, ESTADO_PENDIENTE)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `No se puede rechazar una orden en estado ${orderRow.estado_flujo}.`
      );
    }

    // AM: transicion controlada de estado pendiente a rechazada con comentario obligatorio.
    await client.query(
      `
        UPDATE public.orden_compras
        SET
          estado_flujo = $1,
          estado = $2,
          comentario_revision = $3,
          id_usuario_revisor = $4,
          fecha_revision = NOW()
        WHERE id_orden_compra = $5
      `,
      [ESTADO_RECHAZADA, stateToLegacyBoolean(ESTADO_RECHAZADA), comentarioRevision, idUsuario, idOrdenCompra]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Orden rechazada correctamente.'
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow/:id_orden_compra/rechazar', error);
  } finally {
    client.release();
  }
});

router.post('/orden_compras/workflow/:id_orden_compra/convertir', checkPermission(PERM_OC_CONVERT), async (req, res) => {
  const client = await pool.connect();
  try {
    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const idProveedor = parsePositiveInt(req.body?.id_proveedor);
    if (!idProveedor) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_proveedor es obligatorio.');
    }

    const idArchivoTransferencia = parsePositiveInt(req.body?.id_archivo_transferencia);
    if (!idArchivoTransferencia) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'id_archivo_transferencia es obligatorio para convertir la orden a compra.'
      );
    }

    const referenciaTransferencia = normalizeText(
      req.body?.referencia_transferencia || req.body?.observacion_transferencia,
      MAX_SHORT_TEXT_LEN
    );

    const compraFecha = parseDateInput(req.body?.fecha_compra) || parseDateInput(req.body?.fecha) || null;
    const isvPctInput = hasValue(req.body?.isv_porcentaje) ? parseNonNegativeNumber(req.body?.isv_porcentaje) : 0;
    if (isvPctInput === null || isvPctInput > 100) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'isv_porcentaje debe ser un numero entre 0 y 100.');
    }

    const globalDiscount = parseGlobalDiscount(req.body?.descuento_tipo, req.body?.descuento_valor);
    if (!globalDiscount.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', globalDiscount.message);
    }

    const overrideDetails = parseConvertDetailOverrides(req.body?.detalles);
    if (!overrideDetails.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', overrideDetails.message);
    }

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    if (!assertStateTransition(orderRow.estado_flujo, ESTADO_APROBADA)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Solo se puede convertir una orden en estado ${ESTADO_APROBADA}. Estado actual: ${orderRow.estado_flujo}.`
      );
    }

    const proveedorExiste = await validateProveedor(idProveedor, client);
    if (!proveedorExiste) {
      await withRollback(client);
      return sendError(res, 400, 'VALIDATION_ERROR', 'El proveedor seleccionado no existe.');
    }

    const transferenciaExiste = await validateArchivo(idArchivoTransferencia, client);
    if (!transferenciaExiste) {
      await withRollback(client);
      return sendError(res, 400, 'VALIDATION_ERROR', 'El comprobante de transferencia no existe en archivos.');
    }

    const compraExistente = await client.query(
      `
        SELECT id_compra
        FROM public.compras
        WHERE id_orden_compra = $1
        LIMIT 1
      `,
      [idOrdenCompra]
    );
    if (compraExistente.rowCount > 0) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'La orden ya fue convertida a compra. Solo se permite una conversion por orden.'
      );
    }

    const detailsResult = await client.query(
      `
        SELECT
          doc.id_detalle_orden,
          doc.cantidad_orden,
          doc.id_insumo,
          doc.id_producto,
          doc.id_almacen_destino,
          p.id_producto AS producto_existente,
          i.id_insumo AS insumo_existente,
          COALESCE(p.precio, i.precio, 0)::numeric AS precio_referencia
        FROM public.detalle_orden_compras doc
        LEFT JOIN public.productos p ON p.id_producto = doc.id_producto
        LEFT JOIN public.insumos i ON i.id_insumo = doc.id_insumo
        WHERE doc.id_orden_compra = $1
        ORDER BY doc.id_detalle_orden ASC
      `,
      [idOrdenCompra]
    );
    const details = detailsResult.rows || [];
    if (details.length === 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden no tiene detalles para convertir.');
    }

    let subTotal = 0;
    let descuentoTotal = 0;
    const computedDetails = [];

    for (const detail of details) {
      const idDetalleOrden = Number(detail.id_detalle_orden);
      const cantidad = Number(detail.cantidad_orden);

      if (!Number.isInteger(cantidad) || cantidad <= 0) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El detalle ${idDetalleOrden} tiene una cantidad invalida para convertir.`
        );
      }

      if (detail.id_producto && !detail.producto_existente) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El producto asociado al detalle ${idDetalleOrden} ya no existe.`
        );
      }

      if (detail.id_insumo && !detail.insumo_existente) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El insumo asociado al detalle ${idDetalleOrden} ya no existe.`
        );
      }

      const idAlmacenDestino = parsePositiveInt(detail.id_almacen_destino);
      if (!idAlmacenDestino) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El detalle ${idDetalleOrden} no tiene almacen destino valido.`
        );
      }

      const override = overrideDetails.map.get(idDetalleOrden);
      const precioUnitario = override
        ? override.precio_unitario
        : parseNonNegativeNumber(detail.precio_referencia) ?? 0;
      const descuento = override ? override.descuento : 0;

      const itemSubTotal = round2(cantidad * precioUnitario);
      if (descuento > itemSubTotal) {
        await withRollback(client);
        return sendError(
          res,
          400,
          'VALIDATION_ERROR',
          `El descuento supera el subtotal en el detalle ${idDetalleOrden}.`
        );
      }

      const itemTotal = round2(itemSubTotal - descuento);
      subTotal = round2(subTotal + itemSubTotal);
      descuentoTotal = round2(descuentoTotal + descuento);

      computedDetails.push({
        id_detalle_orden: idDetalleOrden,
        id_producto: detail.id_producto ? Number(detail.id_producto) : null,
        id_insumo: detail.id_insumo ? Number(detail.id_insumo) : null,
        id_almacen_destino: idAlmacenDestino,
        cantidad,
        sub_total: itemSubTotal,
        descuento,
        total_detalle_compra: itemTotal
      });
    }

    const subtotalDespuesLineas = round2(subTotal - descuentoTotal);
    const descuentoGlobal =
      globalDiscount.descuento_tipo === DISCOUNT_MODE_PORCENTAJE
        ? round2(subtotalDespuesLineas * (globalDiscount.descuento_valor / 100))
        : round2(globalDiscount.descuento_valor);
    if (descuentoGlobal > subtotalDespuesLineas) {
      await withRollback(client);
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'El descuento global supera el subtotal disponible de la compra.'
      );
    }

    descuentoTotal = round2(descuentoTotal + descuentoGlobal);
    const baseTotal = round2(subTotal - descuentoTotal);
    const isv = round2(baseTotal * (isvPctInput / 100));
    const totalCompra = round2(baseTotal + isv);

    const compraResult = await client.query(
      `
        INSERT INTO public.compras (
          id_orden_compra,
          id_proveedor,
          fecha,
          total,
          estado,
          sub_total,
          descuento,
          isv,
          total_detalle,
          id_archivo_transferencia,
          referencia_transferencia,
          descuento_tipo,
          descuento_valor
        )
        VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, true, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id_compra
      `,
      [
        idOrdenCompra,
        idProveedor,
        compraFecha,
        totalCompra,
        subTotal,
        descuentoTotal,
        isv,
        baseTotal,
        idArchivoTransferencia,
        referenciaTransferencia,
        globalDiscount.descuento_tipo,
        globalDiscount.descuento_valor
      ]
    );
    const idCompra = Number(compraResult.rows?.[0]?.id_compra);

    for (const detail of computedDetails) {
      // AM: crea el detalle de compra conservando XOR producto/insumo.
      await client.query(
        `
          INSERT INTO public.detalle_compras (
            id_insumo,
            id_producto,
            id_almacen_destino,
            id_compra,
            cantidad,
            sub_total,
            descuento,
            total_detalle_compra
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          detail.id_insumo,
          detail.id_producto,
          detail.id_almacen_destino,
          idCompra,
          detail.cantidad,
          detail.sub_total,
          detail.descuento,
          detail.total_detalle_compra
        ]
      );
    }

    // AM: transicion controlada APROBADA -> EN_COMPRA.
    await client.query(
      `
        UPDATE public.orden_compras
        SET
          estado_flujo = $1,
          estado = $2
        WHERE id_orden_compra = $3
      `,
      [ESTADO_EN_COMPRA, stateToLegacyBoolean(ESTADO_EN_COMPRA), idOrdenCompra]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Orden convertida a compra correctamente.',
      data: {
        id_compra: idCompra,
        id_orden_compra: idOrdenCompra,
        sub_total: subTotal,
        descuento: descuentoTotal,
        descuento_global: descuentoGlobal,
        descuento_tipo: globalDiscount.descuento_tipo,
        descuento_valor: globalDiscount.descuento_valor,
        isv,
        total: totalCompra
      }
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow/:id_orden_compra/convertir', error);
  } finally {
    client.release();
  }
});

router.post('/orden_compras/workflow/:id_orden_compra/recepcion', checkPermission(PERM_OC_RECEIVE), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const idArchivoFactura = parsePositiveInt(req.body?.id_archivo_factura_recepcion);
    if (!idArchivoFactura) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'id_archivo_factura_recepcion es obligatorio para reportar recepcion.'
      );
    }

    const observacionRecepcion = normalizeText(req.body?.observacion_recepcion || req.body?.observacion, MAX_TEXT_LEN);

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
    if (!canView) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para reportar recepcion en esta orden.');
    }

    if (!assertStateTransition(orderRow.estado_flujo, ESTADO_EN_COMPRA)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Solo se puede reportar recepcion en estado ${ESTADO_EN_COMPRA}. Estado actual: ${orderRow.estado_flujo}.`
      );
    }

    const archivoExiste = await validateArchivo(idArchivoFactura, client);
    if (!archivoExiste) {
      await withRollback(client);
      return sendError(res, 400, 'VALIDATION_ERROR', 'La factura de recepcion no existe en archivos.');
    }

    // AM: registra evidencia de factura de recepcion para bandeja de administracion.
    await client.query(
      `
        UPDATE public.orden_compras
        SET
          id_archivo_factura_recepcion = $1,
          fecha_recepcion_reportada = NOW(),
          id_usuario_recepcion = $2,
          observacion_recepcion = $3
        WHERE id_orden_compra = $4
      `,
      [idArchivoFactura, idUsuario, observacionRecepcion, idOrdenCompra]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Factura de recepcion registrada correctamente.',
      data: {
        id_orden_compra: idOrdenCompra,
        id_archivo_factura_recepcion: idArchivoFactura
      }
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow/:id_orden_compra/recepcion', error);
  } finally {
    client.release();
  }
});

router.post('/orden_compras/workflow/:id_orden_compra/abastecer', checkPermission(PERM_OC_SUPPLY), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const idCompraBody = hasValue(req.body?.id_compra) ? parsePositiveInt(req.body?.id_compra) : null;
    if (hasValue(req.body?.id_compra) && !idCompraBody) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_compra invalido.');
    }

    const descripcionExtra = normalizeText(req.body?.observacion || req.body?.descripcion, 200);

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    if (!assertStateTransition(orderRow.estado_flujo, ESTADO_EN_COMPRA)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Solo se puede abastecer una orden en estado ${ESTADO_EN_COMPRA}. Estado actual: ${orderRow.estado_flujo}.`
      );
    }

    if (!parsePositiveInt(orderRow.id_archivo_factura_recepcion)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'Debes registrar primero la factura de recepcion antes del abastecimiento oficial.'
      );
    }

    const duplicateMovements = await client.query(
      `
        SELECT 1
        FROM public.movimientos_inventario
        WHERE ref_origen = 'ORDEN_COMPRA'
          AND id_ref = $1
        LIMIT 1
      `,
      [idOrdenCompra]
    );
    if (duplicateMovements.rowCount > 0) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'La orden ya tiene movimientos de abastecimiento registrados.'
      );
    }

    let compraRow = null;
    if (idCompraBody) {
      const result = await client.query(
        `
          SELECT id_compra, id_orden_compra
          FROM public.compras
          WHERE id_compra = $1
            AND id_orden_compra = $2
          LIMIT 1
        `,
        [idCompraBody, idOrdenCompra]
      );
      compraRow = result.rows?.[0] || null;
    } else {
      compraRow = await getLatestCompraByOrden(idOrdenCompra, client);
    }

    if (!compraRow) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'No se encontro una compra asociada para abastecer esta orden.'
      );
    }

    const idCompra = Number(compraRow.id_compra);
    const detalleCompraResult = await client.query(
      `
        SELECT
          id_detalle_compra,
          id_compra,
          id_producto,
          id_insumo,
          id_almacen_destino,
          cantidad
        FROM public.detalle_compras
        WHERE id_compra = $1
        ORDER BY id_detalle_compra ASC
      `,
      [idCompra]
    );
    const detalleCompra = detalleCompraResult.rows || [];
    if (detalleCompra.length === 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La compra no tiene detalles para abastecer inventario.');
    }

    let totalMovimientos = 0;

    for (const row of detalleCompra) {
      const cantidad = parsePositiveInt(row.cantidad);
      if (!cantidad) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `Detalle de compra ${row.id_detalle_compra} tiene cantidad invalida para abastecer.`
        );
      }

      let idAlmacen = null;
      let idProducto = null;
      let idInsumo = null;

      const idAlmacenDestino = parsePositiveInt(row.id_almacen_destino);
      if (idAlmacenDestino) {
        idAlmacen = idAlmacenDestino;
      }

      if (row.id_producto) {
        if (!idAlmacen) {
          const productRow = await client.query(
            `
              SELECT id_almacen
              FROM public.productos
              WHERE id_producto = $1
              LIMIT 1
            `,
            [row.id_producto]
          );
          if (productRow.rowCount === 0) {
            await withRollback(client);
            return sendError(res, 409, 'CONFLICT', `Producto ${row.id_producto} no existe para abastecer.`);
          }
          idAlmacen = parsePositiveInt(productRow.rows?.[0]?.id_almacen);
        }
        idProducto = Number(row.id_producto);
      } else if (row.id_insumo) {
        if (!idAlmacen) {
          const insumoRow = await client.query(
            `
              SELECT id_almacen
              FROM public.insumos
              WHERE id_insumo = $1
              LIMIT 1
            `,
            [row.id_insumo]
          );
          if (insumoRow.rowCount === 0) {
            await withRollback(client);
            return sendError(res, 409, 'CONFLICT', `Insumo ${row.id_insumo} no existe para abastecer.`);
          }
          idAlmacen = parsePositiveInt(insumoRow.rows?.[0]?.id_almacen);
        }
        idInsumo = Number(row.id_insumo);
      } else {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', `Detalle de compra ${row.id_detalle_compra} no define item.`);
      }

      if (!idAlmacen) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `No se pudo determinar el almacen del item en detalle ${row.id_detalle_compra}.`
        );
      }

      const descripcion = normalizeText(
        `Abastecimiento OC #${idOrdenCompra} / Compra #${idCompra}${descripcionExtra ? ` - ${descripcionExtra}` : ''}`,
        250
      );

      // AM: abastece inventario respetando el flujo oficial por `movimientos_inventario`.
      await client.query(
        `
          INSERT INTO public.movimientos_inventario (
            tipo,
            cantidad,
            id_almacen,
            id_producto,
            id_insumo,
            ref_origen,
            id_ref,
            descripcion
          )
          VALUES ('ENTRADA', $1, $2, $3, $4, 'ORDEN_COMPRA', $5, $6)
        `,
        [cantidad, idAlmacen, idProducto, idInsumo, idOrdenCompra, descripcion]
      );

      totalMovimientos += 1;
    }

    // AM: transicion controlada EN_COMPRA -> ABASTECIDA tras registrar movimientos.
    await client.query(
      `
        UPDATE public.orden_compras
        SET
          estado_flujo = $1,
          estado = $2,
          fecha_abastecimiento = NOW(),
          id_usuario_abastecedor = $3
        WHERE id_orden_compra = $4
      `,
      [ESTADO_ABASTECIDA, stateToLegacyBoolean(ESTADO_ABASTECIDA), idUsuario, idOrdenCompra]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Abastecimiento registrado correctamente.',
      data: {
        id_orden_compra: idOrdenCompra,
        id_compra: idCompra,
        movimientos_creados: totalMovimientos
      }
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow/:id_orden_compra/abastecer', error);
  } finally {
    client.release();
  }
});

export default router;
