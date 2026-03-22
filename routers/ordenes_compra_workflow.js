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
// AM: recepcion de sucursal solo para perfiles operativos con permiso explicito.
const PERM_OC_RECEIVE = ['INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'];
// AM: permisos que habilitan ver informacion administrativa completa de OC (compra/proveedor/transferencia).
const PERM_OC_ADMIN_DETAIL_VIEW = Array.from(
  new Set([...PERM_OC_REVIEW, ...PERM_OC_CONVERT, ...PERM_OC_SUPPLY, ...PERM_OC_VIEW_ALL])
);
// AM: actor administrativo del workflow (puede revisar/decidir solicitudes operativas de OC).
const PERM_OC_ADMIN_WORKFLOW = Array.from(new Set([...PERM_OC_REVIEW, ...PERM_OC_CONVERT, ...PERM_OC_SUPPLY]));

const ESTADO_PENDIENTE = 'PENDIENTE';
const ESTADO_APROBADA = 'APROBADA';
const ESTADO_RECHAZADA = 'RECHAZADA';
const ESTADO_EN_COMPRA = 'EN_COMPRA';
const ESTADO_ABASTECIDA = 'ABASTECIDA';
const ESTADO_CANCELADA = 'CANCELADA';
const ESTADO_SOLICITUD_ITEM_PENDIENTE = 'PENDIENTE';
const ESTADO_SOLICITUD_ITEM_EN_REVISION = 'EN_REVISION';
const ESTADO_SOLICITUD_ITEM_ATENDIDA = 'ATENDIDA';
const ESTADO_SOLICITUD_ITEM_RECHAZADA = 'RECHAZADA';
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
// AM: lock transaccional para asignar correlativo visible de OC sin carreras concurrentes.
const OC_VISIBLE_NUMBER_LOCK_KEY = 830051;
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
    message.includes('id_almacen_destino') ||
    message.includes('id_proveedor_sugerido') ||
    message.includes('fecha_creacion') ||
    message.includes('numero_oc_visible')
  );
};

const sendServerError = (res, context, error) => {
  console.error(`[ordenes_compra_workflow] ${context}:`, error);

  if (isOcSchemaError(error)) {
    return sendError(
      res,
      500,
      'OC_SCHEMA_MISSING',
      'La base de datos aun no tiene las migraciones del workflow de ordenes de compra. Aplica docs/sql/2026-03-11-ordenes-compra-workflow.sql, docs/sql/2026-03-12-ordenes-compra-evidencias-recepcion.sql, docs/sql/2026-03-14-ordenes-compra-por-almacen.sql, docs/sql/2026-03-14-items-multi-almacen-asignacion.sql, docs/sql/2026-03-15-ordenes-compra-fase1-minima.sql y docs/sql/2026-03-16-ordenes-compra-correlativo-visible.sql.'
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

const canUserManageOrderWorkflow = async (req, idUsuario, queryRunner = pool) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (isSuperAdmin) return true;
  return userHasAnyPermission(idUsuario, PERM_OC_ADMIN_WORKFLOW, queryRunner);
};

const canUserViewAdminOrderData = async (req, idUsuario, queryRunner = pool) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (isSuperAdmin) return true;
  return userHasAnyPermission(idUsuario, PERM_OC_ADMIN_DETAIL_VIEW, queryRunner);
};

const sanitizeOrderForOperativeDetail = (row) => {
  if (!row || typeof row !== 'object') return row;
  // AM: cocina/cajero no deben ver acciones/metadata administrativas internas.
  return {
    ...row,
    comentario_revision: null,
    id_usuario_revisor: null,
    revisor_nombre_usuario: null,
    fecha_revision: null,
    id_usuario_abastecedor: null,
    abastecedor_nombre_usuario: null,
    fecha_abastecimiento: null
  };
};

const sanitizeWorkflowListRowForOperative = (row) => {
  if (!row || typeof row !== 'object') return row;
  // AM: evita exponer datos administrativos de compra/transferencia al flujo operativo de sucursal.
  return {
    ...row,
    id_compra_actual: null,
    id_proveedor_actual: null,
    nombre_proveedor_actual: null,
    total_compra_actual: null,
    fecha_compra_actual: null,
    id_archivo_transferencia_actual: null,
    transferencia_url_publica_actual: null
  };
};

const sanitizeOrderDetailsForOperative = (details) => {
  const rows = Array.isArray(details) ? details : [];
  // AM: elimina montos administrativos de detalle para perfiles operativos.
  return rows.map((row) => ({
    ...row,
    id_detalle_compra: null,
    sub_total_compra: null,
    descuento_compra: null,
    total_detalle_compra: null
  }));
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

// AM: clausula reutilizable de scope por sucursal para cubrir OC legacy con id_almacen_destino nulo.
const buildOrderSucursalScopeClause = (orderAlias, sucursalParamRef) => `
  (
    EXISTS (
      SELECT 1
      FROM public.detalle_orden_compras doc_scope
      LEFT JOIN public.almacenes a_scope ON a_scope.id_almacen = doc_scope.id_almacen_destino
      LEFT JOIN public.productos p_scope ON p_scope.id_producto = doc_scope.id_producto
      LEFT JOIN public.insumos i_scope ON i_scope.id_insumo = doc_scope.id_insumo
      LEFT JOIN public.almacenes a_item_scope ON a_item_scope.id_almacen = COALESCE(p_scope.id_almacen, i_scope.id_almacen)
      WHERE doc_scope.id_orden_compra = ${orderAlias}.id_orden_compra
        AND COALESCE(a_scope.id_sucursal, a_item_scope.id_sucursal) = ${sucursalParamRef}
    )
    OR EXISTS (
      SELECT 1
      FROM public.usuarios u_scope
      LEFT JOIN public.empleados e_scope ON e_scope.id_empleado = u_scope.id_empleado
      WHERE u_scope.id_usuario = ${orderAlias}.id_usuario
        AND e_scope.id_sucursal = ${sucursalParamRef}
    )
  )
`;

const orderBelongsToSucursal = async (idOrdenCompra, idSucursal, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT 1
      FROM public.orden_compras oc
      WHERE oc.id_orden_compra = $1
        AND ${buildOrderSucursalScopeClause('oc', '$2')}
      LIMIT 1
    `,
    [idOrdenCompra, idSucursal]
  );
  return result.rowCount > 0;
};

// AM: serializa operaciones que asignan/liberan correlativo visible para evitar condiciones de carrera.
const acquireOcVisibleNumberLock = async (queryRunner = pool) => {
  await queryRunner.query('SELECT pg_advisory_xact_lock($1)', [OC_VISIBLE_NUMBER_LOCK_KEY]);
};

// AM: calcula el menor correlativo visible disponible considerando ocupados solo estados activos del flujo.
const getNextVisibleOrderNumber = async (queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      WITH usados AS (
        SELECT DISTINCT oc.numero_oc_visible AS n
        FROM public.orden_compras oc
        WHERE oc.numero_oc_visible IS NOT NULL
          AND UPPER(COALESCE(oc.estado_flujo, '')) NOT IN ($1, $2)
      ),
      candidatos AS (
        SELECT generate_series(
          1,
          COALESCE((SELECT MAX(u.n) FROM usados u), 0) + 1
        ) AS n
      )
      SELECT MIN(c.n)::int AS siguiente_numero
      FROM candidatos c
      LEFT JOIN usados u ON u.n = c.n
      WHERE u.n IS NULL
    `,
    [ESTADO_RECHAZADA, ESTADO_CANCELADA]
  );

  return parsePositiveInt(result.rows?.[0]?.siguiente_numero) || 1;
};

// AM: calcula solo para las OC solicitadas el numero visible compacto del flujo, sin renumerar PK ni escribir en BD.
const getVisibleFlowOrderNumberMap = async (orderIds, queryRunner = pool) => {
  const safeOrderIds = Array.from(
    new Set((Array.isArray(orderIds) ? orderIds : []).map((value) => parsePositiveInt(value)).filter(Boolean))
  );

  if (safeOrderIds.length === 0) return new Map();

  const result = await queryRunner.query(
    `
      WITH ranked AS (
        SELECT
          oc.id_orden_compra,
          ROW_NUMBER() OVER (
            ORDER BY
              COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp),
              oc.id_orden_compra
          )::int AS numero_oc_visible_flujo
        FROM public.orden_compras oc
        WHERE UPPER(COALESCE(oc.estado_flujo, '')) NOT IN ($1, $2)
      )
      SELECT ranked.id_orden_compra, ranked.numero_oc_visible_flujo
      FROM ranked
      WHERE ranked.id_orden_compra = ANY($3::int[])
    `,
    [ESTADO_RECHAZADA, ESTADO_CANCELADA, safeOrderIds]
  );

  return new Map(
    (result.rows || []).map((row) => [
      Number(row.id_orden_compra),
      parsePositiveInt(row.numero_oc_visible_flujo) || null
    ])
  );
};

const getOrderById = async (idOrdenCompra, queryRunner = pool) => {
  try {
    const result = await queryRunner.query(
      `
        SELECT
          oc.id_orden_compra,
          COALESCE(NULLIF(to_jsonb(oc)->>'numero_oc_visible', '')::int, NULL) AS numero_oc_visible,
          oc.id_usuario,
          oc.id_usuario_revisor,
          oc.id_usuario_abastecedor,
          oc.id_usuario_recepcion,
          oc.fecha,
          COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp) AS fecha_creacion,
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
          suc.id_sucursal,
          suc.nombre_sucursal,
          rol.roles AS solicitante_roles,
          ar.url_publica AS factura_recepcion_url_publica
        FROM public.orden_compras oc
        LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
        LEFT JOIN public.usuarios ur ON ur.id_usuario = oc.id_usuario_revisor
        LEFT JOIN public.usuarios ua ON ua.id_usuario = oc.id_usuario_abastecedor
        LEFT JOIN public.usuarios ux ON ux.id_usuario = oc.id_usuario_recepcion
        LEFT JOIN public.archivos ar ON ar.id_archivo = oc.id_archivo_factura_recepcion
        LEFT JOIN LATERAL (
          -- AM: deriva sucursal operativa de la OC para mostrar visibilidad clara entre admin y sucursal.
          SELECT
            COALESCE(a_scope.id_sucursal, a_item_scope.id_sucursal) AS id_sucursal,
            COALESCE(s_scope.nombre_sucursal, s_item_scope.nombre_sucursal) AS nombre_sucursal
          FROM public.detalle_orden_compras doc_scope
          LEFT JOIN public.almacenes a_scope ON a_scope.id_almacen = doc_scope.id_almacen_destino
          LEFT JOIN public.sucursales s_scope ON s_scope.id_sucursal = a_scope.id_sucursal
          LEFT JOIN public.productos p_scope ON p_scope.id_producto = doc_scope.id_producto
          LEFT JOIN public.insumos i_scope ON i_scope.id_insumo = doc_scope.id_insumo
          LEFT JOIN public.almacenes a_item_scope ON a_item_scope.id_almacen = COALESCE(p_scope.id_almacen, i_scope.id_almacen)
          LEFT JOIN public.sucursales s_item_scope ON s_item_scope.id_sucursal = a_item_scope.id_sucursal
          WHERE doc_scope.id_orden_compra = oc.id_orden_compra
          ORDER BY doc_scope.id_detalle_orden ASC
          LIMIT 1
        ) suc ON true
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
    // AM: conserva campos de recepcion usando to_jsonb(oc) para no perder etapa Cocina -> Admin.
    const fallbackResult = await queryRunner.query(
      `
        SELECT
          oc.id_orden_compra,
          COALESCE(NULLIF(to_jsonb(oc)->>'numero_oc_visible', '')::int, NULL) AS numero_oc_visible,
          oc.id_usuario,
          oc.id_usuario_revisor,
          oc.id_usuario_abastecedor,
          meta.id_usuario_recepcion,
          oc.fecha,
          meta.fecha_creacion,
          oc.estado,
          oc.estado_flujo,
          oc.observacion_solicitud,
          oc.comentario_revision,
          oc.fecha_revision,
          oc.fecha_abastecimiento,
          meta.id_archivo_factura_recepcion,
          meta.fecha_recepcion_reportada,
          meta.observacion_recepcion,
          u.nombre_usuario AS solicitante_nombre_usuario,
          ur.nombre_usuario AS revisor_nombre_usuario,
          ua.nombre_usuario AS abastecedor_nombre_usuario,
          ux.nombre_usuario AS recepcion_nombre_usuario,
          suc.id_sucursal,
          suc.nombre_sucursal,
          rol.roles AS solicitante_roles,
          ar.url_publica AS factura_recepcion_url_publica
        FROM public.orden_compras oc
        LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
        LEFT JOIN public.usuarios ur ON ur.id_usuario = oc.id_usuario_revisor
        LEFT JOIN public.usuarios ua ON ua.id_usuario = oc.id_usuario_abastecedor
        LEFT JOIN LATERAL (
          SELECT
            CASE
              WHEN COALESCE(to_jsonb(oc)->>'id_usuario_recepcion', '') ~ '^[0-9]+$'
              THEN (to_jsonb(oc)->>'id_usuario_recepcion')::int
              ELSE NULL
            END AS id_usuario_recepcion,
            CASE
              WHEN COALESCE(to_jsonb(oc)->>'id_archivo_factura_recepcion', '') ~ '^[0-9]+$'
              THEN (to_jsonb(oc)->>'id_archivo_factura_recepcion')::int
              ELSE NULL
            END AS id_archivo_factura_recepcion,
            NULLIF(to_jsonb(oc)->>'fecha_recepcion_reportada', '')::timestamp AS fecha_recepcion_reportada,
            NULLIF(to_jsonb(oc)->>'observacion_recepcion', '')::text AS observacion_recepcion,
            COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp) AS fecha_creacion
        ) meta ON true
        LEFT JOIN public.usuarios ux ON ux.id_usuario = meta.id_usuario_recepcion
        LEFT JOIN public.archivos ar ON ar.id_archivo = meta.id_archivo_factura_recepcion
        LEFT JOIN LATERAL (
          -- AM: fallback sin columnas nuevas, manteniendo sucursal derivada por detalle/item legacy.
          SELECT
            COALESCE(a_scope.id_sucursal, a_item_scope.id_sucursal) AS id_sucursal,
            COALESCE(s_scope.nombre_sucursal, s_item_scope.nombre_sucursal) AS nombre_sucursal
          FROM public.detalle_orden_compras doc_scope
          LEFT JOIN public.almacenes a_scope ON a_scope.id_almacen = doc_scope.id_almacen_destino
          LEFT JOIN public.sucursales s_scope ON s_scope.id_sucursal = a_scope.id_sucursal
          LEFT JOIN public.productos p_scope ON p_scope.id_producto = doc_scope.id_producto
          LEFT JOIN public.insumos i_scope ON i_scope.id_insumo = doc_scope.id_insumo
          LEFT JOIN public.almacenes a_item_scope ON a_item_scope.id_almacen = COALESCE(p_scope.id_almacen, i_scope.id_almacen)
          LEFT JOIN public.sucursales s_item_scope ON s_item_scope.id_sucursal = a_item_scope.id_sucursal
          WHERE doc_scope.id_orden_compra = oc.id_orden_compra
          ORDER BY doc_scope.id_detalle_orden ASC
          LIMIT 1
        ) suc ON true
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
          id_archivo_factura_recepcion,
          id_usuario_recepcion,
          fecha_recepcion_reportada,
          observacion_recepcion
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
          NULL::int AS id_archivo_factura_recepcion,
          NULL::int AS id_usuario_recepcion,
          NULL::timestamp AS fecha_recepcion_reportada,
          NULL::text AS observacion_recepcion
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
          c.observacion_pago,
          c.descuento_tipo,
          c.descuento_valor,
          prov.nombre_proveedor,
          a.url_publica AS transferencia_url_publica
        FROM public.compras c
        LEFT JOIN public.proveedores prov ON prov.id_proveedor = c.id_proveedor
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
          NULL::text AS observacion_pago,
          NULL::varchar AS descuento_tipo,
          NULL::numeric AS descuento_valor,
          NULL::varchar AS nombre_proveedor,
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
        doc.id_proveedor_sugerido,
        CASE
          WHEN doc.id_producto IS NOT NULL THEN 'producto'
          ELSE 'insumo'
        END AS item_tipo,
        COALESCE(p.nombre_producto, i.nombre_insumo) AS item_nombre,
        prov.nombre_proveedor AS proveedor_sugerido_nombre,
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
      LEFT JOIN public.proveedores prov ON prov.id_proveedor = doc.id_proveedor_sugerido
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

const getOrderItemRequestByIdForUpdate = async (idOrdenCompra, idSolicitudItem, queryRunner = pool) => {
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
          si.comentario_revision
        FROM public.orden_compra_solicitudes_item si
        WHERE si.id_orden_compra = $1
          AND si.id_solicitud_item = $2
        LIMIT 1
        FOR UPDATE
      `,
      [idOrdenCompra, idSolicitudItem]
    );
    return result.rows?.[0] || null;
  } catch (error) {
    if (!isOcSchemaError(error)) throw error;
    return null;
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
    const rawProveedorSugerido = hasValue(detail?.id_proveedor_sugerido)
      ? detail.id_proveedor_sugerido
      : detail?.id_proveedor;
    const idProveedorSugerido = parseOptionalPositiveInt(rawProveedorSugerido);

    if (!['producto', 'insumo'].includes(itemTipo)) {
      return { ok: false, message: 'item_tipo debe ser "producto" o "insumo".' };
    }

    if (!idItem) {
      return { ok: false, message: 'id_item debe ser un entero mayor a 0.' };
    }

    if (!cantidad) {
      return { ok: false, message: 'cantidad debe ser un entero mayor a 0.' };
    }

    if (hasValue(rawProveedorSugerido) && !idProveedorSugerido) {
      return { ok: false, message: 'id_proveedor_sugerido debe ser un entero mayor a 0.' };
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
    const key = `${itemTipo}:${idItem}:${idAlmacenDestino}:${idProveedorSugerido || 0}`;
    const previous = aggregatedMap.get(key);
    if (!previous) {
      aggregatedMap.set(key, {
        item_tipo: itemTipo,
        id_item: idItem,
        id_almacen_destino: idAlmacenDestino,
        id_proveedor_sugerido: idProveedorSugerido,
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
  const proveedorIds = Array.from(
    new Set(
      details
        .map((detail) => parsePositiveInt(detail?.id_proveedor_sugerido))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
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

  if (proveedorIds.length > 0) {
    const proveedorRows = await queryRunner.query(
      `
        SELECT id_proveedor, COALESCE(estado, true) AS estado
        FROM public.proveedores
        WHERE id_proveedor = ANY($1::int[])
      `,
      [proveedorIds]
    );

    const map = new Map(proveedorRows.rows.map((row) => [Number(row.id_proveedor), Boolean(row.estado)]));
    for (const idProveedor of proveedorIds) {
      if (!map.has(idProveedor)) {
        return { ok: false, message: `El proveedor sugerido ${idProveedor} no existe.` };
      }
      if (!map.get(idProveedor)) {
        return { ok: false, message: `El proveedor sugerido ${idProveedor} esta inactivo.` };
      }
    }
  }

  if (almacenIds.length > 0) {
    const almacenRows = await queryRunner.query(
      `
        SELECT a.id_almacen, COALESCE(a.estado, true) AS estado
        FROM public.almacenes a
        WHERE a.id_almacen = ANY($1::int[])
      `,
      [almacenIds]
    );

    const almacenMap = new Map(
      almacenRows.rows.map((row) => [Number(row.id_almacen), Boolean(row.estado)])
    );
    for (const idAlmacen of almacenIds) {
      if (!almacenMap.has(idAlmacen)) {
        return { ok: false, message: `El almacen destino ${idAlmacen} no existe.` };
      }
      if (!almacenMap.get(idAlmacen)) {
        return { ok: false, message: `El almacen destino ${idAlmacen} esta inactivo.` };
      }
    }
  }

  // AM: valida que cada item pertenezca al almacen principal real (`id_almacen`) seleccionado.
  // AM: evita depender de asignaciones multi-almacen en pivotes mientras el modelo temporal es 1 almacen por item.
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
            FROM public.productos p
            WHERE p.id_producto = $1
              AND p.id_almacen = $2
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
            FROM public.insumos i
            WHERE i.id_insumo = $1
              AND i.id_almacen = $2
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

const validateArchivo = async (idArchivo, queryRunner = pool, options = {}) => {
  const expectedMimePrefix = normalizeText(options?.expectedMimePrefix, 40)?.toLowerCase() || null;
  const result = await queryRunner.query(
    `
      SELECT tipo_archivo
      FROM public.archivos
      WHERE id_archivo = $1
        AND COALESCE(estado, true) = true
      LIMIT 1
    `,
    [idArchivo]
  );

  if (result.rowCount === 0) return false;
  if (!expectedMimePrefix) return true;

  const tipoArchivo = String(result.rows?.[0]?.tipo_archivo || '').trim().toLowerCase();
  if (!tipoArchivo) return true;
  return tipoArchivo.startsWith(expectedMimePrefix);
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

const parseItemRequestReviewAction = (value) => {
  const action = String(value ?? '')
    .trim()
    .toLowerCase();
  if (action === 'aprobar') return 'aprobar';
  if (action === 'rechazar') return 'rechazar';
  return null;
};

router.get('/orden_compras/workflow/contexto_creacion', checkPermission(PERM_OC_CREATE), async (req, res) => {
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const canViewAll = await canUserViewAllOrders(req, idUsuario);
    const userSucursalId = await getUserSucursalId(idUsuario);
    if (!canViewAll && !userSucursalId) {
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'Tu usuario no tiene sucursal asignada para crear solicitudes.'
      );
    }

    const params = [];
    let whereSql = 'WHERE COALESCE(a.estado, true) = true';
    if (!canViewAll && userSucursalId) {
      params.push(userSucursalId);
      whereSql += ` AND a.id_sucursal = $${params.length}`;
    }

    const warehousesResult = await pool.query(
      `
        SELECT
          a.id_almacen,
          a.id_sucursal,
          a.nombre,
          COALESCE(a.estado, true) AS estado,
          s.nombre_sucursal
        FROM public.almacenes a
        LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
        ${whereSql}
        ORDER BY a.id_almacen ASC
      `,
      params
    );

    return res.status(200).json({
      ok: true,
      data: {
        id_sucursal_usuario: userSucursalId || null,
        restringido_a_sucursal_usuario: !canViewAll,
        almacenes_permitidos: warehousesResult.rows || []
      }
    });
  } catch (error) {
    return sendServerError(res, 'GET /orden_compras/workflow/contexto_creacion', error);
  }
});

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
      // AM: aplica scope robusto por sucursal, incluyendo OC legacy sin almacen destino explicito.
      whereParts.push(buildOrderSucursalScopeClause('oc', `$${params.length}`));
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
            COALESCE(NULLIF(to_jsonb(oc)->>'numero_oc_visible', '')::int, NULL) AS numero_oc_visible,
            oc.id_usuario,
            oc.id_usuario_revisor,
            oc.id_usuario_abastecedor,
            oc.id_usuario_recepcion,
            oc.fecha,
            COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp) AS fecha_creacion,
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
            suc.id_sucursal,
            suc.nombre_sucursal,
            ar.url_publica AS factura_recepcion_url_publica,
            COALESCE(det.total_items, 0)::int AS total_items,
            COALESCE(det.total_cantidad, 0)::int AS total_cantidad,
            COALESCE(sit.total_solicitudes_item, 0)::int AS total_solicitudes_item,
            COALESCE(sit.total_solicitudes_item_pendientes, 0)::int AS total_solicitudes_item_pendientes,
            COALESCE(sit.total_solicitudes_item_en_revision, 0)::int AS total_solicitudes_item_en_revision,
            COALESCE(sit.total_solicitudes_item_atendidas, 0)::int AS total_solicitudes_item_atendidas,
            COALESCE(sit.total_solicitudes_item_rechazadas, 0)::int AS total_solicitudes_item_rechazadas,
            compra.id_compra AS id_compra_actual,
            compra.id_proveedor AS id_proveedor_actual,
            compra.nombre_proveedor AS nombre_proveedor_actual,
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
            -- AM: publica sucursal operativa en el listado para visibilidad clara admin <-> sucursal.
            SELECT
              COALESCE(a_scope.id_sucursal, a_item_scope.id_sucursal) AS id_sucursal,
              COALESCE(s_scope.nombre_sucursal, s_item_scope.nombre_sucursal) AS nombre_sucursal
            FROM public.detalle_orden_compras doc_scope
            LEFT JOIN public.almacenes a_scope ON a_scope.id_almacen = doc_scope.id_almacen_destino
            LEFT JOIN public.sucursales s_scope ON s_scope.id_sucursal = a_scope.id_sucursal
            LEFT JOIN public.productos p_scope ON p_scope.id_producto = doc_scope.id_producto
            LEFT JOIN public.insumos i_scope ON i_scope.id_insumo = doc_scope.id_insumo
            LEFT JOIN public.almacenes a_item_scope ON a_item_scope.id_almacen = COALESCE(p_scope.id_almacen, i_scope.id_almacen)
            LEFT JOIN public.sucursales s_item_scope ON s_item_scope.id_sucursal = a_item_scope.id_sucursal
            WHERE doc_scope.id_orden_compra = oc.id_orden_compra
            ORDER BY doc_scope.id_detalle_orden ASC
            LIMIT 1
          ) suc ON true
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
            SELECT
              COUNT(*)::int AS total_solicitudes_item,
              COUNT(*) FILTER (WHERE UPPER(COALESCE(si.estado, '')) = 'PENDIENTE')::int AS total_solicitudes_item_pendientes,
              COUNT(*) FILTER (WHERE UPPER(COALESCE(si.estado, '')) = 'EN_REVISION')::int AS total_solicitudes_item_en_revision,
              COUNT(*) FILTER (WHERE UPPER(COALESCE(si.estado, '')) = 'ATENDIDA')::int AS total_solicitudes_item_atendidas,
              COUNT(*) FILTER (WHERE UPPER(COALESCE(si.estado, '')) = 'RECHAZADA')::int AS total_solicitudes_item_rechazadas
            FROM public.orden_compra_solicitudes_item si
            WHERE si.id_orden_compra = oc.id_orden_compra
          ) sit ON true
          LEFT JOIN LATERAL (
            SELECT
              c.id_compra,
              c.id_proveedor,
              prov.nombre_proveedor,
              c.total,
              c.fecha,
              c.id_archivo_transferencia,
              a.url_publica AS transferencia_url_publica
            FROM public.compras c
            LEFT JOIN public.proveedores prov ON prov.id_proveedor = c.id_proveedor
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
      // AM: mantiene datos de recepcion para liberar card en Cocina y habilitar Convertir en Admin.
      rowsResult = await pool.query(
        `
          SELECT
            oc.id_orden_compra,
            COALESCE(NULLIF(to_jsonb(oc)->>'numero_oc_visible', '')::int, NULL) AS numero_oc_visible,
            oc.id_usuario,
            oc.id_usuario_revisor,
            oc.id_usuario_abastecedor,
            meta.id_usuario_recepcion,
            oc.fecha,
            meta.fecha_creacion,
            oc.estado,
            oc.estado_flujo,
            oc.observacion_solicitud,
            oc.comentario_revision,
            oc.fecha_revision,
            oc.fecha_abastecimiento,
            meta.id_archivo_factura_recepcion,
            meta.fecha_recepcion_reportada,
            meta.observacion_recepcion,
            u.nombre_usuario AS solicitante_nombre_usuario,
            rol.roles AS solicitante_roles,
            ur.nombre_usuario AS revisor_nombre_usuario,
            ua.nombre_usuario AS abastecedor_nombre_usuario,
            ux.nombre_usuario AS recepcion_nombre_usuario,
            suc.id_sucursal,
            suc.nombre_sucursal,
            ar.url_publica AS factura_recepcion_url_publica,
            COALESCE(det.total_items, 0)::int AS total_items,
            COALESCE(det.total_cantidad, 0)::int AS total_cantidad,
            0::int AS total_solicitudes_item,
            0::int AS total_solicitudes_item_pendientes,
            0::int AS total_solicitudes_item_en_revision,
            0::int AS total_solicitudes_item_atendidas,
            0::int AS total_solicitudes_item_rechazadas,
            compra.id_compra AS id_compra_actual,
            NULL::int AS id_proveedor_actual,
            NULL::varchar AS nombre_proveedor_actual,
            compra.total AS total_compra_actual,
            compra.fecha AS fecha_compra_actual,
            NULL::int AS id_archivo_transferencia_actual,
            NULL::varchar AS transferencia_url_publica_actual
          FROM public.orden_compras oc
          LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
          LEFT JOIN public.usuarios ur ON ur.id_usuario = oc.id_usuario_revisor
          LEFT JOIN public.usuarios ua ON ua.id_usuario = oc.id_usuario_abastecedor
          LEFT JOIN LATERAL (
            SELECT
              CASE
                WHEN COALESCE(to_jsonb(oc)->>'id_usuario_recepcion', '') ~ '^[0-9]+$'
                THEN (to_jsonb(oc)->>'id_usuario_recepcion')::int
                ELSE NULL
              END AS id_usuario_recepcion,
              CASE
                WHEN COALESCE(to_jsonb(oc)->>'id_archivo_factura_recepcion', '') ~ '^[0-9]+$'
                THEN (to_jsonb(oc)->>'id_archivo_factura_recepcion')::int
                ELSE NULL
              END AS id_archivo_factura_recepcion,
              NULLIF(to_jsonb(oc)->>'fecha_recepcion_reportada', '')::timestamp AS fecha_recepcion_reportada,
              NULLIF(to_jsonb(oc)->>'observacion_recepcion', '')::text AS observacion_recepcion,
              COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp) AS fecha_creacion
          ) meta ON true
          LEFT JOIN public.usuarios ux ON ux.id_usuario = meta.id_usuario_recepcion
          LEFT JOIN public.archivos ar ON ar.id_archivo = meta.id_archivo_factura_recepcion
          LEFT JOIN LATERAL (
            -- AM: fallback sin tabla solicitudes/evidencias, manteniendo sucursal visible por detalle/item legacy.
            SELECT
              COALESCE(a_scope.id_sucursal, a_item_scope.id_sucursal) AS id_sucursal,
              COALESCE(s_scope.nombre_sucursal, s_item_scope.nombre_sucursal) AS nombre_sucursal
            FROM public.detalle_orden_compras doc_scope
            LEFT JOIN public.almacenes a_scope ON a_scope.id_almacen = doc_scope.id_almacen_destino
            LEFT JOIN public.sucursales s_scope ON s_scope.id_sucursal = a_scope.id_sucursal
            LEFT JOIN public.productos p_scope ON p_scope.id_producto = doc_scope.id_producto
            LEFT JOIN public.insumos i_scope ON i_scope.id_insumo = doc_scope.id_insumo
            LEFT JOIN public.almacenes a_item_scope ON a_item_scope.id_almacen = COALESCE(p_scope.id_almacen, i_scope.id_almacen)
            LEFT JOIN public.sucursales s_item_scope ON s_item_scope.id_sucursal = a_item_scope.id_sucursal
            WHERE doc_scope.id_orden_compra = oc.id_orden_compra
            ORDER BY doc_scope.id_detalle_orden ASC
            LIMIT 1
          ) suc ON true
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

        const visibleFlowOrderNumberMap = await getVisibleFlowOrderNumberMap(
      (rowsResult.rows || []).map((row) => row.id_orden_compra)
    );

    const rowsWithVisibleFlowNumber = (rowsResult.rows || []).map((row) => ({
      ...row,
      // AM: correlativo compacto solo para visualizacion del flujo; no toca el id interno.
      numero_oc_visible_flujo: parsePositiveInt(visibleFlowOrderNumberMap.get(Number(row.id_orden_compra))) || null
    }));

    const canViewAdminData = await canUserViewAdminOrderData(req, idUsuario);
    const rowsPayload = canViewAdminData
      ? rowsWithVisibleFlowNumber
      : rowsWithVisibleFlowNumber.map((row) => sanitizeWorkflowListRowForOperative(row));

    return res.status(200).json({
      ok: true,
      data: rowsPayload,
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

        const visibleFlowOrderNumberMap = await getVisibleFlowOrderNumberMap([idOrdenCompra]);
    const orderRowWithVisibleFlowNumber = {
      ...orderRow,
      // AM: numero compacto visible para detalle/modal sin reusar el id tecnico.
      numero_oc_visible_flujo: parsePositiveInt(visibleFlowOrderNumberMap.get(Number(idOrdenCompra))) || null
    };

    const canViewAdminData = await canUserViewAdminOrderData(req, idUsuario);
    const compraActual = canViewAdminData ? await getLatestCompraByOrden(idOrdenCompra) : null;
    const detallesRaw = await getOrderDetails(idOrdenCompra, compraActual?.id_compra || null);
    const detalles = canViewAdminData ? detallesRaw : sanitizeOrderDetailsForOperative(detallesRaw);
    const solicitudesItem = await getOrderItemRequests(idOrdenCompra);
    const ordenPayload = canViewAdminData
      ? orderRowWithVisibleFlowNumber
      : sanitizeOrderForOperativeDetail(orderRowWithVisibleFlowNumber);

    return res.status(200).json({
      ok: true,
      data: {
        orden: ordenPayload,
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
      // AM: solicitudes_item quedan para flujo operativo; perfiles administrativos deben resolver catalogo directo.
      const isAdminWorkflowActor = await canUserManageOrderWorkflow(req, idUsuario, client);
      if (isAdminWorkflowActor) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Las solicitudes de item no registrado son exclusivas de perfiles operativos (Cocina/Cajero).'
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
    await acquireOcVisibleNumberLock(client);
    const numeroOcVisible = await getNextVisibleOrderNumber(client);

    // AM: crea la orden en estado pendiente con trazabilidad del solicitante.
    const ordenResult = await client.query(
      `
        INSERT INTO public.orden_compras (
          id_usuario,
          fecha,
          estado,
          estado_flujo,
          observacion_solicitud,
          numero_oc_visible
        )
        VALUES ($1, CURRENT_DATE, false, $2, $3, $4)
        RETURNING id_orden_compra, numero_oc_visible
      `,
      [idUsuario, ESTADO_PENDIENTE, observacionSolicitud, numeroOcVisible]
    );
    const idOrdenCompra = Number(ordenResult.rows?.[0]?.id_orden_compra);
    const numeroOcVisibleCreado = parsePositiveInt(ordenResult.rows?.[0]?.numero_oc_visible) || numeroOcVisible;

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
            id_proveedor_sugerido,
            id_almacen_destino
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          detail.cantidad,
          idOrdenCompra,
          idInsumo,
          idProducto,
          detail.id_proveedor_sugerido || null,
          detail.id_almacen_destino
        ]
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
      id_orden_compra: idOrdenCompra,
      numero_oc_visible: numeroOcVisibleCreado
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
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const payloadUpdates = Array.isArray(req.body?.actualizar) ? req.body.actualizar : [];
    const payloadDeletes = Array.isArray(req.body?.eliminar) ? req.body.eliminar : [];
    const payloadAdds = Array.isArray(req.body?.agregar) ? req.body.agregar : [];
    if (payloadUpdates.length === 0 && payloadDeletes.length === 0 && payloadAdds.length === 0) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Debes enviar actualizar, eliminar o agregar para modificar detalles.'
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

    const parsedAdds = parseCreateDetails(payloadAdds);
    if (!parsedAdds.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', parsedAdds.message);
    }
    if (parsedAdds.details.length > 0) {
      const existenciaAdds = await validateCreateItemsExistence(parsedAdds.details, client);
      if (!existenciaAdds.ok) {
        return sendError(res, 400, 'VALIDATION_ERROR', existenciaAdds.message);
      }

      const canViewAllAdds = await canUserViewAllOrders(req, idUsuario, client);
      if (!canViewAllAdds) {
        const userSucursalId = await getUserSucursalId(idUsuario, client);
        if (!userSucursalId) {
          return sendError(
            res,
            403,
            'FORBIDDEN',
            'Tu usuario no tiene sucursal asignada para editar esta orden.'
          );
        }

        const requestedWarehouseIds = Array.from(
          new Set(
            parsedAdds.details
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
                `No puedes agregar lineas para el almacen ${idAlmacen} porque pertenece a otra sucursal.`
              );
            }
          }
        }
      }
    }

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    // AM: valida visibilidad operacional por sucursal tambien para edicion administrativa.
    const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
    if (!canView) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para editar detalles de esta orden.');
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

    for (const detail of parsedAdds.details) {
      const idProducto = detail.item_tipo === 'producto' ? detail.id_item : null;
      const idInsumo = detail.item_tipo === 'insumo' ? detail.id_item : null;
      const existingRow = await client.query(
        `
          SELECT id_detalle_orden, cantidad_orden
          FROM public.detalle_orden_compras
          WHERE id_orden_compra = $1
            AND (
              ($2::int IS NOT NULL AND id_producto = $2 AND id_insumo IS NULL)
              OR ($3::int IS NOT NULL AND id_insumo = $3 AND id_producto IS NULL)
            )
            AND id_almacen_destino = $4
          LIMIT 1
        `,
        [idOrdenCompra, idProducto, idInsumo, detail.id_almacen_destino]
      );

      if (existingRow.rowCount > 0) {
        // AM: evita duplicar lineas; suma cantidad cuando el item ya existe en el mismo almacen destino.
        await client.query(
          `
            UPDATE public.detalle_orden_compras
            SET cantidad_orden = cantidad_orden + $1
            WHERE id_detalle_orden = $2
              AND id_orden_compra = $3
          `,
          [detail.cantidad, existingRow.rows[0].id_detalle_orden, idOrdenCompra]
        );
      } else {
        // AM: permite a Admin agregar lineas nuevas en orden pendiente sin romper contrato existente.
        await client.query(
          `
            INSERT INTO public.detalle_orden_compras (
              cantidad_orden,
              id_orden_compra,
              id_insumo,
              id_producto,
              id_proveedor_sugerido,
              id_almacen_destino
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            detail.cantidad,
            idOrdenCompra,
            idInsumo,
            idProducto,
            detail.id_proveedor_sugerido || null,
            detail.id_almacen_destino
          ]
        );
      }
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
        detalles_agregados: parsedAdds.details.length,
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

router.post(
  '/orden_compras/workflow/:id_orden_compra/solicitudes_item/:id_solicitud_item/revisar',
  checkPermission(PERM_OC_REVIEW),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const idUsuario = getRequestUserId(req);
      if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

      const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
      const idSolicitudItem = parsePositiveInt(req.params?.id_solicitud_item);
      if (!idOrdenCompra || !idSolicitudItem) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra o id_solicitud_item invalido.');
      }

      const accion = parseItemRequestReviewAction(req.body?.accion);
      if (!accion) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'accion invalida. Usa "aprobar" o "rechazar".');
      }

      const comentarioRevision = normalizeText(req.body?.comentario_revision || req.body?.comentario, MAX_TEXT_LEN);
      if (accion === 'rechazar' && !comentarioRevision) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Debes ingresar comentario para rechazar la solicitud.');
      }

      await client.query('BEGIN');

      const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
      if (!orderRow) {
        await withRollback(client);
        return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
      }

      const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
      if (!canView) {
        await withRollback(client);
        return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para revisar solicitudes de esta orden.');
      }

      const itemRequest = await getOrderItemRequestByIdForUpdate(idOrdenCompra, idSolicitudItem, client);
      if (!itemRequest) {
        await withRollback(client);
        return sendError(res, 404, 'NOT_FOUND', 'Solicitud de item no registrada en esta orden.');
      }

      const estadoActual = String(itemRequest.estado || '').trim().toUpperCase();
      if (accion === 'aprobar') {
        if (estadoActual === ESTADO_SOLICITUD_ITEM_EN_REVISION) {
          await client.query('COMMIT');
          return res.status(200).json({
            ok: true,
            message: 'La solicitud ya estaba aprobada.',
            data: {
              id_solicitud_item: idSolicitudItem,
              estado: ESTADO_SOLICITUD_ITEM_EN_REVISION,
              already_processed: true
            }
          });
        }

        if (estadoActual !== ESTADO_SOLICITUD_ITEM_PENDIENTE) {
          await withRollback(client);
          return sendError(
            res,
            409,
            'INVALID_STATE',
            `Solo se puede aprobar una solicitud en estado ${ESTADO_SOLICITUD_ITEM_PENDIENTE}. Estado actual: ${estadoActual}.`
          );
        }
      } else {
        if (estadoActual === ESTADO_SOLICITUD_ITEM_RECHAZADA) {
          await client.query('COMMIT');
          return res.status(200).json({
            ok: true,
            message: 'La solicitud ya estaba rechazada.',
            data: {
              id_solicitud_item: idSolicitudItem,
              estado: ESTADO_SOLICITUD_ITEM_RECHAZADA,
              already_processed: true
            }
          });
        }

        if (estadoActual === ESTADO_SOLICITUD_ITEM_ATENDIDA) {
          await withRollback(client);
          return sendError(
            res,
            409,
            'INVALID_STATE',
            'La solicitud ya fue atendida y no puede rechazarse.'
          );
        }
      }

      const estadoDestino =
        accion === 'aprobar' ? ESTADO_SOLICITUD_ITEM_EN_REVISION : ESTADO_SOLICITUD_ITEM_RECHAZADA;
      const updateResult = await client.query(
        `
          UPDATE public.orden_compra_solicitudes_item
          SET
            estado = $1,
            id_usuario_revisor = $2,
            fecha_revision = NOW(),
            comentario_revision = CASE
              WHEN $3::text IS NOT NULL THEN $3
              ELSE comentario_revision
            END
          WHERE id_solicitud_item = $4
            AND id_orden_compra = $5
          RETURNING
            id_solicitud_item,
            id_orden_compra,
            tipo_item,
            nombre_sugerido,
            estado,
            id_usuario_revisor,
            fecha_revision,
            comentario_revision
        `,
        [estadoDestino, idUsuario, comentarioRevision, idSolicitudItem, idOrdenCompra]
      );

      await client.query('COMMIT');
      return res.status(200).json({
        ok: true,
        message: accion === 'aprobar' ? 'Solicitud aprobada correctamente.' : 'Solicitud rechazada correctamente.',
        data: updateResult.rows?.[0] || null
      });
    } catch (error) {
      await withRollback(client);
      return sendServerError(
        res,
        'POST /orden_compras/workflow/:id_orden_compra/solicitudes_item/:id_solicitud_item/revisar',
        error
      );
    } finally {
      client.release();
    }
  }
);

router.post(
  '/orden_compras/workflow/:id_orden_compra/solicitudes_item/:id_solicitud_item/atender',
  checkPermission(PERM_OC_REVIEW),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const idUsuario = getRequestUserId(req);
      if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

      const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
      const idSolicitudItem = parsePositiveInt(req.params?.id_solicitud_item);
      const idItemCreado = parsePositiveInt(req.body?.id_item_creado);
      if (!idOrdenCompra || !idSolicitudItem || !idItemCreado) {
        return sendError(
          res,
          400,
          'VALIDATION_ERROR',
          'id_orden_compra, id_solicitud_item e id_item_creado son obligatorios.'
        );
      }

      await client.query('BEGIN');

      const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
      if (!orderRow) {
        await withRollback(client);
        return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
      }

      const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
      if (!canView) {
        await withRollback(client);
        return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para atender solicitudes de esta orden.');
      }

      const itemRequest = await getOrderItemRequestByIdForUpdate(idOrdenCompra, idSolicitudItem, client);
      if (!itemRequest) {
        await withRollback(client);
        return sendError(res, 404, 'NOT_FOUND', 'Solicitud de item no registrada en esta orden.');
      }

      const tipoItemSolicitud = String(itemRequest.tipo_item || '')
        .trim()
        .toLowerCase();
      if (!['producto', 'insumo'].includes(tipoItemSolicitud)) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', 'La solicitud tiene un tipo_item invalido.');
      }

      const estadoActual = String(itemRequest.estado || '').trim().toUpperCase();
      if (estadoActual === ESTADO_SOLICITUD_ITEM_ATENDIDA) {
        await client.query('COMMIT');
        return res.status(200).json({
          ok: true,
          message: 'La solicitud ya estaba atendida.',
          data: {
            id_solicitud_item: idSolicitudItem,
            estado: ESTADO_SOLICITUD_ITEM_ATENDIDA,
            already_processed: true
          }
        });
      }

      if (estadoActual !== ESTADO_SOLICITUD_ITEM_EN_REVISION) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'INVALID_STATE',
          `Solo se puede marcar atendida una solicitud en estado ${ESTADO_SOLICITUD_ITEM_EN_REVISION}. Estado actual: ${estadoActual}.`
        );
      }

      const itemExistsResult =
        tipoItemSolicitud === 'producto'
          ? await client.query(
              `
                SELECT 1
                FROM public.productos p
                WHERE p.id_producto = $1
                  AND COALESCE(p.estado, true) = true
                LIMIT 1
              `,
              [idItemCreado]
            )
          : await client.query(
              `
                SELECT 1
                FROM public.insumos i
                WHERE i.id_insumo = $1
                  AND COALESCE(i.estado, true) = true
                LIMIT 1
              `,
              [idItemCreado]
            );
      if (itemExistsResult.rowCount === 0) {
        await withRollback(client);
        return sendError(
          res,
          400,
          'VALIDATION_ERROR',
          `El ${tipoItemSolicitud} indicado no existe o esta inactivo.`
        );
      }

      const comentarioManual = normalizeText(req.body?.comentario_revision || req.body?.comentario, MAX_TEXT_LEN);
      const notaAtencion = `Item creado: ${tipoItemSolicitud} #${idItemCreado}.`;
      const comentarioFinal = comentarioManual ? `${notaAtencion} ${comentarioManual}` : notaAtencion;
      const updateResult = await client.query(
        `
          UPDATE public.orden_compra_solicitudes_item
          SET
            estado = $1,
            id_usuario_revisor = $2,
            fecha_revision = NOW(),
            comentario_revision = $3
          WHERE id_solicitud_item = $4
            AND id_orden_compra = $5
          RETURNING
            id_solicitud_item,
            id_orden_compra,
            tipo_item,
            nombre_sugerido,
            estado,
            id_usuario_revisor,
            fecha_revision,
            comentario_revision
        `,
        [ESTADO_SOLICITUD_ITEM_ATENDIDA, idUsuario, comentarioFinal, idSolicitudItem, idOrdenCompra]
      );

      await client.query('COMMIT');
      return res.status(200).json({
        ok: true,
        message: 'Solicitud marcada como atendida correctamente.',
        data: updateResult.rows?.[0] || null
      });
    } catch (error) {
      await withRollback(client);
      return sendServerError(
        res,
        'POST /orden_compras/workflow/:id_orden_compra/solicitudes_item/:id_solicitud_item/atender',
        error
      );
    } finally {
      client.release();
    }
  }
);

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

    // AM: evita aprobar ordenes fuera del scope de sucursal del usuario operador.
    const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
    if (!canView) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para aprobar esta orden.');
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

    const approvalPrecheck = await client.query(
      `
        SELECT
          (SELECT COUNT(*)::int FROM public.detalle_orden_compras doc WHERE doc.id_orden_compra = $1) AS total_detalles,
          (
            SELECT COUNT(*)::int
            FROM public.orden_compra_solicitudes_item si
            WHERE si.id_orden_compra = $1
              AND UPPER(COALESCE(si.estado, '')) IN ('PENDIENTE', 'EN_REVISION')
          ) AS total_solicitudes_abiertas
      `,
      [idOrdenCompra]
    );
    const totalDetalles = Number(approvalPrecheck.rows?.[0]?.total_detalles || 0);
    const totalSolicitudesAbiertas = Number(approvalPrecheck.rows?.[0]?.total_solicitudes_abiertas || 0);
    if (totalDetalles <= 0 && totalSolicitudesAbiertas > 0) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        'No puedes aprobar una solicitud de item nuevo mientras existan solicitudes pendientes o en revision sin lineas de orden.'
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
    // AM: serializa liberacion de correlativo visible al rechazar para no cruzarse con altas concurrentes.
    await acquireOcVisibleNumberLock(client);

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    // AM: evita rechazar ordenes fuera del scope de sucursal del usuario operador.
    const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
    if (!canView) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para rechazar esta orden.');
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
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    const accion = String(req.body?.accion || 'guardar')
      .trim()
      .toLowerCase();
    if (!['guardar', 'guardar_y_abastecer'].includes(accion)) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'accion invalida. Usa "guardar" o "guardar_y_abastecer".'
      );
    }

    const idProveedor = parsePositiveInt(req.body?.id_proveedor);
    if (!idProveedor) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_proveedor es obligatorio.');
    }

    const idArchivoTransferencia = hasValue(req.body?.id_archivo_transferencia)
      ? parsePositiveInt(req.body?.id_archivo_transferencia)
      : null;
    if (hasValue(req.body?.id_archivo_transferencia) && !idArchivoTransferencia) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_archivo_transferencia invalido.');
    }

    const referenciaTransferencia = normalizeText(
      req.body?.referencia_transferencia || req.body?.observacion_admin || req.body?.observacion,
      MAX_TEXT_LEN
    );

    const compraFecha = parseDateInput(req.body?.fecha_compra) || parseDateInput(req.body?.fecha) || null;
    const parsedDetailOverrides = parseConvertDetailOverrides(req.body?.detalles);
    if (!parsedDetailOverrides.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', parsedDetailOverrides.message);
    }

    const parsedGlobalDiscount = parseGlobalDiscount(req.body?.descuento_tipo, req.body?.descuento_valor);
    if (!parsedGlobalDiscount.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', parsedGlobalDiscount.message);
    }

    let isvPct = null;
    if (hasValue(req.body?.isv_pct)) {
      const parsedIsvPct = parseNonNegativeNumber(req.body?.isv_pct);
      if (parsedIsvPct === null || parsedIsvPct > 100) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'isv_pct debe ser un numero entre 0 y 100.');
      }
      isvPct = round2(parsedIsvPct);
    }

    await client.query('BEGIN');

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    // AM: mantiene control por sucursal tambien en el endpoint legacy de conversion.
    const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
    if (!canView) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para convertir esta orden.');
    }

    if (!assertStateTransition(orderRow.estado_flujo, ESTADO_EN_COMPRA)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Solo se puede continuar una orden en estado ${ESTADO_EN_COMPRA}. Estado actual: ${orderRow.estado_flujo}.`
      );
    }

    // AM: exige que la recepcion de sucursal exista antes de permitir gestion administrativa.
    // AM: en fase 2 la factura puede ser opcional; se exige recepcion registrada por cualquier evidencia valida.
    const recepcionRegistrada =
      parsePositiveInt(orderRow.id_usuario_recepcion) ||
      normalizeText(orderRow.fecha_recepcion_reportada, 80) ||
      normalizeText(orderRow.observacion_recepcion, MAX_TEXT_LEN) ||
      parsePositiveInt(orderRow.id_archivo_factura_recepcion);
    if (!recepcionRegistrada) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'Debes registrar primero la recepcion de sucursal antes de continuar con la conversion administrativa.'
      );
    }

    const proveedorExiste = await validateProveedor(idProveedor, client);
    if (!proveedorExiste) {
      await withRollback(client);
      return sendError(res, 400, 'VALIDATION_ERROR', 'El proveedor seleccionado no existe.');
    }

    if (idArchivoTransferencia) {
      const transferenciaExiste = await validateArchivo(idArchivoTransferencia, client, { expectedMimePrefix: 'image/' });
      if (!transferenciaExiste) {
        await withRollback(client);
        return sendError(res, 400, 'VALIDATION_ERROR', 'El comprobante de transferencia no existe en archivos.');
      }
    }

    const compraExistenteResult = await client.query(
      `
        SELECT
          id_compra,
          id_archivo_transferencia,
          id_proveedor,
          referencia_transferencia,
          sub_total,
          descuento,
          isv,
          total_detalle,
          total,
          descuento_tipo,
          descuento_valor
        FROM public.compras
        WHERE id_orden_compra = $1
        ORDER BY id_compra DESC
        LIMIT 1
        FOR UPDATE
      `,
      [idOrdenCompra]
    );
    let compraActual = compraExistenteResult.rows?.[0] || null;
    let idCompra = parsePositiveInt(compraActual?.id_compra);
    let descuentoTipo = parsedGlobalDiscount.descuento_tipo;
    let descuentoValor = parsedGlobalDiscount.descuento_valor;
    if (!hasValue(req.body?.descuento_tipo) && !hasValue(req.body?.descuento_valor) && compraActual) {
      // AM: compatibilidad con clientes anteriores: preserva descuento existente si no se manda en payload.
      const descuentoTipoPrevio = parseDiscountMode(compraActual.descuento_tipo);
      const descuentoValorPrevio = parseNonNegativeNumber(compraActual.descuento_valor);
      if (descuentoTipoPrevio) descuentoTipo = descuentoTipoPrevio;
      if (descuentoValorPrevio !== null) descuentoValor = round2(descuentoValorPrevio);
    }
    if (isvPct === null && compraActual) {
      // AM: compatibilidad con clientes anteriores: conserva %ISV inferido si no se manda isv_pct.
      const basePrevio = parseNonNegativeNumber(compraActual.total_detalle);
      const isvPrevio = parseNonNegativeNumber(compraActual.isv);
      if (basePrevio !== null && basePrevio > 0 && isvPrevio !== null) {
        isvPct = round2((isvPrevio * 100) / basePrevio);
      }
    }
    if (isvPct === null) isvPct = 0;

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
          COALESCE(p.estado, true) AS producto_activo,
          COALESCE(i.estado, true) AS insumo_activo,
          COALESCE(p.precio, i.precio, 0)::numeric AS precio_referencia,
          COALESCE(p.id_almacen, i.id_almacen) AS id_almacen_item,
          dc_prev.sub_total AS sub_total_compra_prev,
          dc_prev.descuento AS descuento_compra_prev
        FROM public.detalle_orden_compras doc
        LEFT JOIN public.productos p ON p.id_producto = doc.id_producto
        LEFT JOIN public.insumos i ON i.id_insumo = doc.id_insumo
        LEFT JOIN LATERAL (
          SELECT
            dc1.sub_total,
            dc1.descuento
          FROM public.detalle_compras dc1
          WHERE $2::int IS NOT NULL
            AND dc1.id_compra = $2
            AND dc1.id_almacen_destino = COALESCE(doc.id_almacen_destino, COALESCE(p.id_almacen, i.id_almacen))
            AND (
              (doc.id_producto IS NOT NULL AND dc1.id_producto = doc.id_producto)
              OR (doc.id_insumo IS NOT NULL AND dc1.id_insumo = doc.id_insumo)
            )
          ORDER BY dc1.id_detalle_compra DESC
          LIMIT 1
        ) dc_prev ON true
        WHERE doc.id_orden_compra = $1
        ORDER BY doc.id_detalle_orden ASC
      `,
      [idOrdenCompra, idCompra || null]
    );
    const details = detailsResult.rows || [];
    if (details.length === 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden no tiene detalles para continuar.');
    }

    const detailWarehouseIds = Array.from(
      new Set(
        details
          .map((detail) => parsePositiveInt(detail.id_almacen_destino) || parsePositiveInt(detail.id_almacen_item))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );
    const detailWarehouseMap = new Map();
    if (detailWarehouseIds.length > 0) {
      const warehouseRows = await client.query(
        `
          SELECT id_almacen, COALESCE(estado, true) AS estado
          FROM public.almacenes
          WHERE id_almacen = ANY($1::int[])
        `,
        [detailWarehouseIds]
      );
      for (const row of warehouseRows.rows || []) {
        detailWarehouseMap.set(Number(row.id_almacen), Boolean(row.estado));
      }
    }

    const detailOverridesMap = parsedDetailOverrides.map;
    let subTotalBruto = 0;
    let descuentoLineas = 0;
    let totalLineas = 0;
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
          `El detalle ${idDetalleOrden} tiene una cantidad invalida para continuar.`
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
      if (
        detail.id_producto &&
        !(detail.producto_activo === true || detail.producto_activo === 1 || detail.producto_activo === '1')
      ) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El producto asociado al detalle ${idDetalleOrden} esta inactivo.`
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
      if (
        detail.id_insumo &&
        !(detail.insumo_activo === true || detail.insumo_activo === 1 || detail.insumo_activo === '1')
      ) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El insumo asociado al detalle ${idDetalleOrden} esta inactivo.`
        );
      }

      const idAlmacenDestino = parsePositiveInt(detail.id_almacen_destino) || parsePositiveInt(detail.id_almacen_item);
      if (!idAlmacenDestino) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El detalle ${idDetalleOrden} no tiene almacen destino valido.`
        );
      }
      if (!detailWarehouseMap.has(idAlmacenDestino)) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El detalle ${idDetalleOrden} referencia un almacen destino que no existe.`
        );
      }
      if (!detailWarehouseMap.get(idAlmacenDestino)) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El almacen destino del detalle ${idDetalleOrden} esta inactivo.`
        );
      }

      const override = detailOverridesMap.get(idDetalleOrden);
      let precioUnitario = parseNonNegativeNumber(override?.precio_unitario);
      if (precioUnitario === null) {
        const prevSubTotal = parseNonNegativeNumber(detail.sub_total_compra_prev);
        if (prevSubTotal !== null && cantidad > 0) {
          precioUnitario = round2(prevSubTotal / cantidad);
        } else {
          precioUnitario = parseNonNegativeNumber(detail.precio_referencia) ?? 0;
        }
      }

      let descuentoLinea = parseNonNegativeNumber(override?.descuento);
      if (descuentoLinea === null) {
        descuentoLinea = parseNonNegativeNumber(detail.descuento_compra_prev) ?? 0;
      }

      const itemSubTotal = round2(cantidad * precioUnitario);
      descuentoLinea = round2(descuentoLinea);
      if (descuentoLinea > itemSubTotal) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El descuento de linea supera el subtotal del detalle ${idDetalleOrden}.`
        );
      }

      const itemTotal = round2(itemSubTotal - descuentoLinea);
      subTotalBruto = round2(subTotalBruto + itemSubTotal);
      descuentoLineas = round2(descuentoLineas + descuentoLinea);
      totalLineas = round2(totalLineas + itemTotal);

      computedDetails.push({
        id_producto: detail.id_producto ? Number(detail.id_producto) : null,
        id_insumo: detail.id_insumo ? Number(detail.id_insumo) : null,
        id_almacen_destino: idAlmacenDestino,
        cantidad,
        sub_total: itemSubTotal,
        descuento: descuentoLinea,
        total_detalle_compra: itemTotal
      });
    }

    const descuentoGlobal =
      descuentoTipo === DISCOUNT_MODE_PORCENTAJE
        ? round2(totalLineas * (descuentoValor / 100))
        : round2(descuentoValor);
    if (descuentoGlobal > totalLineas) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'El descuento global supera el total disponible de las lineas.'
      );
    }

    const descuentoTotal = round2(descuentoLineas + descuentoGlobal);
    const baseTotal = Math.max(0, round2(subTotalBruto - descuentoTotal));
    const isv = round2(baseTotal * (isvPct / 100));
    const totalCompra = round2(baseTotal + isv);

    if (!idCompra) {
      // AM: crea compra administrativa base y deja persistidos montos reales para auditoria.
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
          subTotalBruto,
          descuentoTotal,
          isv,
          baseTotal,
          idArchivoTransferencia,
          referenciaTransferencia,
          descuentoTipo,
          descuentoValor
        ]
      );
      idCompra = Number(compraResult.rows?.[0]?.id_compra);
    } else {
      // AM: actualiza metadata y montos administrativos sin tocar inventario en esta etapa.
      await client.query(
        `
          UPDATE public.compras
          SET
            id_proveedor = $1,
            fecha = COALESCE($2::date, COALESCE(fecha, CURRENT_DATE)),
            referencia_transferencia = COALESCE($3, referencia_transferencia),
            id_archivo_transferencia = CASE
              WHEN $4::int IS NOT NULL THEN $4
              ELSE id_archivo_transferencia
            END,
            sub_total = $5,
            descuento = $6,
            isv = $7,
            total_detalle = $8,
            total = $9,
            descuento_tipo = $10,
            descuento_valor = $11
          WHERE id_compra = $12
        `,
        [
          idProveedor,
          compraFecha,
          referenciaTransferencia,
          idArchivoTransferencia,
          subTotalBruto,
          descuentoTotal,
          isv,
          baseTotal,
          totalCompra,
          descuentoTipo,
          descuentoValor,
          idCompra
        ]
      );
    }

    // AM: sincroniza detalle_compras con la configuracion administrativa vigente de costos/descuentos por linea.
    await client.query(
      `
        DELETE FROM public.detalle_compras
        WHERE id_compra = $1
      `,
      [idCompra]
    );

    for (const detail of computedDetails) {
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

    const compraActualizadaResult = await client.query(
      `
        SELECT
          c.id_compra,
          c.id_archivo_transferencia,
          c.referencia_transferencia,
          c.id_proveedor,
          c.sub_total,
          c.descuento,
          c.isv,
          c.total_detalle,
          c.total,
          c.descuento_tipo,
          c.descuento_valor
        FROM public.compras c
        WHERE c.id_compra = $1
        LIMIT 1
      `,
      [idCompra]
    );
    const compraActualizada = compraActualizadaResult.rows?.[0] || null;
    const idArchivoTransferenciaFinal = parsePositiveInt(compraActualizada?.id_archivo_transferencia);

    if (accion === 'guardar_y_abastecer' && !idArchivoTransferenciaFinal) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'Para "Guardar y abastecer" debes registrar la imagen de deposito/transferencia.'
      );
    }

    const alreadyProcessed =
      compraActual &&
      Number(compraActual.id_proveedor) === Number(compraActualizada?.id_proveedor) &&
      parsePositiveInt(compraActual.id_archivo_transferencia) === idArchivoTransferenciaFinal &&
      normalizeText(compraActual.referencia_transferencia, MAX_TEXT_LEN) ===
        normalizeText(compraActualizada?.referencia_transferencia, MAX_TEXT_LEN) &&
      round2(Number(compraActual.total || 0)) === round2(Number(compraActualizada?.total || 0));

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message:
        accion === 'guardar_y_abastecer'
          ? 'Datos administrativos guardados. La orden quedo lista para abastecer.'
          : 'Datos administrativos guardados correctamente.',
      data: {
        id_orden_compra: idOrdenCompra,
        id_compra: idCompra,
        id_proveedor: parsePositiveInt(compraActualizada?.id_proveedor),
        id_archivo_transferencia: idArchivoTransferenciaFinal,
        observacion_admin: normalizeText(compraActualizada?.referencia_transferencia, MAX_TEXT_LEN),
        sub_total: round2(Number(compraActualizada?.sub_total || 0)),
        descuento: round2(Number(compraActualizada?.descuento || 0)),
        isv: round2(Number(compraActualizada?.isv || 0)),
        total_detalle: round2(Number(compraActualizada?.total_detalle || 0)),
        total: round2(Number(compraActualizada?.total || 0)),
        descuento_tipo: parseDiscountMode(compraActualizada?.descuento_tipo) || descuentoTipo,
        descuento_valor: round2(Number(compraActualizada?.descuento_valor || 0)),
        isv_pct: isvPct,
        accion,
        ready_for_supply: Boolean(idArchivoTransferenciaFinal),
        already_processed: Boolean(alreadyProcessed)
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

    // AM: en fase 1 la factura es opcional, pero si viene debe ser un id valido.
    const idArchivoFactura = hasValue(req.body?.id_archivo_factura_recepcion)
      ? parsePositiveInt(req.body?.id_archivo_factura_recepcion)
      : null;
    if (hasValue(req.body?.id_archivo_factura_recepcion) && !idArchivoFactura) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_archivo_factura_recepcion invalido.');
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

    // AM: evita que perfiles administrativos de compra (convertir) ejecuten la recepcion operativa por error.
    const userCanConvert = await userHasAnyPermission(idUsuario, PERM_OC_CONVERT, client);
    const isSuperAdmin = await isRequestUserSuperAdmin(req);
    if (userCanConvert && !isSuperAdmin) {
      await withRollback(client);
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'La recepcion de sucursal debe ser registrada por un perfil operativo (Cocina/Cajero).'
      );
    }

    if (![ESTADO_APROBADA, ESTADO_EN_COMPRA].includes(String(orderRow.estado_flujo || '').toUpperCase())) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'INVALID_STATE',
        `Solo se puede reportar recepcion en estado ${ESTADO_APROBADA} o ${ESTADO_EN_COMPRA}. Estado actual: ${orderRow.estado_flujo}.`
      );
    }

    const idArchivoFacturaActual = parsePositiveInt(orderRow.id_archivo_factura_recepcion);
    const observacionRecepcionActual = normalizeText(orderRow.observacion_recepcion, MAX_TEXT_LEN);
    const idUsuarioRecepcionActual = parsePositiveInt(orderRow.id_usuario_recepcion);
    const fechaRecepcionActual = normalizeText(orderRow.fecha_recepcion_reportada, 80);

    if (idArchivoFactura && idArchivoFacturaActual && idArchivoFacturaActual !== idArchivoFactura) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'La orden ya tiene una factura de recepcion registrada y no se puede sobrescribir en esta fase.'
      );
    }

    if (observacionRecepcion && observacionRecepcionActual && observacionRecepcion !== observacionRecepcionActual) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'La recepcion ya tiene una observacion registrada y no se puede sobrescribir en esta fase.'
      );
    }

    if (idArchivoFactura && !idArchivoFacturaActual) {
      const archivoExiste = await validateArchivo(idArchivoFactura, client, { expectedMimePrefix: 'image/' });
      if (!archivoExiste) {
        await withRollback(client);
        return sendError(res, 400, 'VALIDATION_ERROR', 'La factura de recepcion no existe en archivos.');
      }
    }

    const estadoActual = String(orderRow.estado_flujo || '').toUpperCase();
    const estadoResultante = estadoActual === ESTADO_APROBADA ? ESTADO_EN_COMPRA : estadoActual;

    const resolvedArchivoFactura = idArchivoFacturaActual || idArchivoFactura || null;
    const resolvedObservacion = observacionRecepcionActual || observacionRecepcion || null;
    const resolvedUsuarioRecepcion = idUsuarioRecepcionActual || idUsuario;
    const alreadyProcessed =
      (idArchivoFacturaActual || null) === (resolvedArchivoFactura || null) &&
      (observacionRecepcionActual || null) === (resolvedObservacion || null) &&
      (idUsuarioRecepcionActual || null) === (resolvedUsuarioRecepcion || null) &&
      estadoActual === estadoResultante &&
      Boolean(fechaRecepcionActual);

    if (alreadyProcessed) {
      // AM: idempotencia para doble click/polling en recepcion.
      await client.query('COMMIT');
      return res.status(200).json({
        ok: true,
        message: 'La recepcion ya estaba registrada para esta orden.',
        data: {
          id_orden_compra: idOrdenCompra,
          id_archivo_factura_recepcion: resolvedArchivoFactura,
          estado_flujo: estadoResultante,
          already_processed: true
        }
      });
    }

    // AM: registra recepcion basica (factura opcional) y avanza APROBADA -> EN_COMPRA.
    const updateResult = await client.query(
      `
        UPDATE public.orden_compras
        SET
          id_archivo_factura_recepcion = COALESCE(id_archivo_factura_recepcion, $1),
          fecha_recepcion_reportada = COALESCE(fecha_recepcion_reportada, NOW()),
          id_usuario_recepcion = COALESCE(id_usuario_recepcion, $2),
          observacion_recepcion = COALESCE(observacion_recepcion, $3),
          estado_flujo = CASE WHEN estado_flujo = $5 THEN $6 ELSE estado_flujo END,
          estado = CASE WHEN estado_flujo = $5 THEN $7 ELSE estado END
        WHERE id_orden_compra = $4
        RETURNING
          id_archivo_factura_recepcion,
          id_usuario_recepcion,
          fecha_recepcion_reportada,
          observacion_recepcion,
          estado_flujo
      `,
      [
        idArchivoFactura || null,
        idUsuario,
        observacionRecepcion,
        idOrdenCompra,
        ESTADO_APROBADA,
        ESTADO_EN_COMPRA,
        stateToLegacyBoolean(ESTADO_EN_COMPRA)
      ]
    );

    await client.query('COMMIT');
    const updatedRow = updateResult.rows?.[0] || {};
    return res.status(200).json({
      ok: true,
      message: 'Recepcion registrada correctamente.',
      data: {
        id_orden_compra: idOrdenCompra,
        id_archivo_factura_recepcion: parsePositiveInt(updatedRow.id_archivo_factura_recepcion),
        id_usuario_recepcion: parsePositiveInt(updatedRow.id_usuario_recepcion),
        fecha_recepcion_reportada: updatedRow.fecha_recepcion_reportada || null,
        observacion_recepcion: normalizeText(updatedRow.observacion_recepcion, MAX_TEXT_LEN),
        estado_flujo: updatedRow.estado_flujo || estadoResultante
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

    // AM: aplica control por sucursal para impedir abastecer OC fuera del alcance del usuario.
    const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
    if (!canView) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para abastecer esta orden.');
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

    const recepcionRegistrada =
      parsePositiveInt(orderRow.id_usuario_recepcion) ||
      normalizeText(orderRow.fecha_recepcion_reportada, 80) ||
      normalizeText(orderRow.observacion_recepcion, MAX_TEXT_LEN) ||
      parsePositiveInt(orderRow.id_archivo_factura_recepcion);
    if (!recepcionRegistrada) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'Debes registrar primero la recepcion de sucursal antes del abastecimiento oficial.'
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
          SELECT id_compra, id_orden_compra, id_archivo_transferencia
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

    if (!parsePositiveInt(compraRow.id_archivo_transferencia)) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'Debes registrar primero el pago administrativo antes del abastecimiento oficial.'
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
        const warehouseResult = await client.query(
          `
            SELECT COALESCE(estado, true) AS estado
            FROM public.almacenes
            WHERE id_almacen = $1
            LIMIT 1
          `,
          [idAlmacenDestino]
        );
        if (warehouseResult.rowCount === 0) {
          await withRollback(client);
          return sendError(
            res,
            409,
            'CONFLICT',
            `El almacen destino ${idAlmacenDestino} no existe para abastecer.`
          );
        }
        if (!Boolean(warehouseResult.rows?.[0]?.estado)) {
          await withRollback(client);
          return sendError(
            res,
            409,
            'CONFLICT',
            `El almacen destino ${idAlmacenDestino} esta inactivo.`
          );
        }
        idAlmacen = idAlmacenDestino;
      }

      if (row.id_producto) {
        if (!idAlmacen) {
          const productRow = await client.query(
            `
              SELECT id_almacen, COALESCE(estado, true) AS estado
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
          if (!Boolean(productRow.rows?.[0]?.estado)) {
            await withRollback(client);
            return sendError(res, 409, 'CONFLICT', `El producto ${row.id_producto} esta inactivo.`);
          }
          idAlmacen = parsePositiveInt(productRow.rows?.[0]?.id_almacen);
        }
        idProducto = Number(row.id_producto);
      } else if (row.id_insumo) {
        if (!idAlmacen) {
          const insumoRow = await client.query(
            `
              SELECT id_almacen, COALESCE(estado, true) AS estado
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
          if (!Boolean(insumoRow.rows?.[0]?.estado)) {
            await withRollback(client);
            return sendError(res, 409, 'CONFLICT', `El insumo ${row.id_insumo} esta inactivo.`);
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

      const storedWarehouse = await client.query(
        `
          SELECT COALESCE(estado, true) AS estado
          FROM public.almacenes
          WHERE id_almacen = $1
          LIMIT 1
        `,
        [idAlmacen]
      );
      if (storedWarehouse.rowCount === 0) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `No se encontro el almacen ${idAlmacen} para abastecer el detalle ${row.id_detalle_compra}.`
        );
      }
      if (!Boolean(storedWarehouse.rows?.[0]?.estado)) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El almacen ${idAlmacen} esta inactivo y no puede abastecer el detalle ${row.id_detalle_compra}.`
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
