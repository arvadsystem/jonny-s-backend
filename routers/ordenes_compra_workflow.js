import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../middleware/checkPermission.js';
import { supabase } from '../services/supabaseClient.js';
import { SUPABASE_ADMIN_BUCKET, buildAbsolutePublicUrl } from '../utils/uploads.js';

const router = express.Router();

// AM: Fase 4B.2 - permisos granulares OC con fallback legacy equivalente por endpoint.
const PERM_OC_CREATE = ['INVENTARIO_OC_CREAR_SOLICITUD', 'INVENTARIO_ORDENES_COMPRA_CREAR'];
const PERM_OC_VIEW_FLOW = [
  'INVENTARIO_OC_VER_FLUJO',
  'INVENTARIO_ORDENES_COMPRA_VER',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const PERM_OC_VIEW_DETAIL = [
  'INVENTARIO_OC_VER_DETALLE',
  'INVENTARIO_OC_VER_HISTORIAL',
  'INVENTARIO_ORDENES_COMPRA_VER',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const PERM_OC_VIEW_EVIDENCIAS = [
  'INVENTARIO_OC_VER_EVIDENCIAS',
  'INVENTARIO_OC_RECEPCIONAR',
  'INVENTARIO_OC_SUBIR_FACTURA',
  'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR',
  'INVENTARIO_ORDENES_COMPRA_VER',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const PERM_OC_VIEW_ALL = [
  // AM: VIEW_ALL significa alcance global real; lectura basica no debe escalar sucursal.
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const PERM_OC_EDIT_REQUEST = ['INVENTARIO_OC_EDITAR_SOLICITUD', 'INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
const PERM_OC_APPROVE = ['INVENTARIO_OC_APROBAR', 'INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
const PERM_OC_REJECT = ['INVENTARIO_OC_RECHAZAR', 'INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
const PERM_OC_CANCEL = [
  'INVENTARIO_OC_CANCELAR',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS',
  'INVENTARIO_ORDENES_COMPRA_GESTIONAR'
];
const PERM_OC_CONVERT = ['INVENTARIO_OC_CONVERTIR_CONTINUAR', 'INVENTARIO_ORDENES_COMPRA_CONVERTIR'];
const PERM_OC_SUPPLY = ['INVENTARIO_OC_ABASTECER', 'INVENTARIO_ORDENES_COMPRA_ABASTECER'];
const PERM_OC_UPLOAD_FACTURA = ['INVENTARIO_OC_SUBIR_FACTURA', 'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'];
const PERM_OC_UPLOAD_DEPOSITO = ['INVENTARIO_OC_SUBIR_DEPOSITO', 'INVENTARIO_ORDENES_COMPRA_CONVERTIR'];
// AM: recepcion de sucursal solo para perfiles operativos con permiso explicito.
const PERM_OC_RECEIVE = ['INVENTARIO_OC_RECEPCIONAR', 'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'];
const PERM_OC_RECEIVE_OR_UPLOAD_FACTURA = Array.from(new Set([...PERM_OC_RECEIVE, ...PERM_OC_UPLOAD_FACTURA]));
const PERM_OC_CONVERT_OR_UPLOAD_DEPOSITO = Array.from(new Set([...PERM_OC_CONVERT, ...PERM_OC_UPLOAD_DEPOSITO]));
const PERM_OC_REVIEW_ITEM_REQUEST = ['INVENTARIO_OC_REVISAR_SOLICITUD_ITEM', 'INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
const PERM_OC_ATTEND_ITEM_REQUEST = ['INVENTARIO_OC_ATENDER_SOLICITUD_ITEM', 'INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
// AM: permisos que habilitan ver informacion administrativa completa de OC (compra/proveedor/transferencia).
const PERM_OC_ADMIN_DETAIL_VIEW = Array.from(
  new Set([
    ...PERM_OC_VIEW_EVIDENCIAS,
    'INVENTARIO_OC_VER_HISTORIAL',
    ...PERM_OC_EDIT_REQUEST,
    ...PERM_OC_CONVERT,
    ...PERM_OC_UPLOAD_DEPOSITO,
    ...PERM_OC_SUPPLY,
    ...PERM_OC_VIEW_ALL
  ])
);
// AM: actor administrativo del workflow (puede revisar/decidir solicitudes operativas de OC).
const PERM_OC_ADMIN_WORKFLOW = Array.from(
  new Set([
    ...PERM_OC_EDIT_REQUEST,
    ...PERM_OC_APPROVE,
    ...PERM_OC_REJECT,
    ...PERM_OC_CANCEL,
    ...PERM_OC_CONVERT,
    ...PERM_OC_UPLOAD_DEPOSITO,
    ...PERM_OC_SUPPLY,
    ...PERM_OC_REVIEW_ITEM_REQUEST,
    ...PERM_OC_ATTEND_ITEM_REQUEST
  ])
);

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
const MAX_PROVIDER_SUGGESTION_ITEMS = 100;
const OC_EVIDENCE_SIGNED_URL_TTL_SECONDS = 900;
// AM: lock transaccional para asignar correlativo visible de OC sin carreras concurrentes.
const OC_VISIBLE_NUMBER_LOCK_KEY = 830051;
const DISCOUNT_MODE_MONTO = 'MONTO';
const DISCOUNT_MODE_PORCENTAJE = 'PORCENTAJE';
const DISCOUNT_MODES = new Set([DISCOUNT_MODE_MONTO, DISCOUNT_MODE_PORCENTAJE]);
// AM: fallback seguro para resumen de listado OC; evita tumbar el endpoint si falla solo el bloque summary.
const EMPTY_ORDER_WORKFLOW_SUMMARY = Object.freeze({
  total_ordenes: 0,
  pendientes_aprobacion: 0,
  en_compra: 0,
  abastecidas: 0,
  evidencias_pendientes: 0,
  monto_total_estimado: 0,
  monto_total_real: 0
});

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
const roundDecimal = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const parsePositiveDecimal4 = (value) => {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+|\d+\.\d{1,4})$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getRequestUserId = (req) => parsePositiveInt(req?.user?.id_usuario);

const sendError = (res, status, code, message, extra = {}) =>
  res.status(status).json({
    ok: false,
    error: true,
    code,
    message,
    ...extra
  });

// AM: payload canonico para diagnosticar mismatch entre almacen destino de OC y almacen real del item.
const buildWarehouseMismatchData = ({
  idDetalle = null,
  id_detalle = null,
  itemTipo = null,
  item_tipo = null,
  idItem = null,
  id_item = null,
  idAlmacenDestino = null,
  id_almacen_destino = null,
  idAlmacenActual = null,
  id_almacen_actual = null
} = {}) => {
  const resolvedItemTipo = itemTipo ?? item_tipo;
  const normalizedItemTipo = String(resolvedItemTipo || '')
    .trim()
    .toLowerCase();
  return {
    id_detalle: parsePositiveInt(idDetalle ?? id_detalle),
    item_tipo: ['producto', 'insumo'].includes(normalizedItemTipo) ? normalizedItemTipo : null,
    id_item: parsePositiveInt(idItem ?? id_item),
    id_almacen_destino: parsePositiveInt(idAlmacenDestino ?? id_almacen_destino),
    id_almacen_actual: parsePositiveInt(idAlmacenActual ?? id_almacen_actual)
  };
};

// AM: mensaje uniforme para UI/API cuando se detecta incoherencia de almacenes por item.
const formatWarehouseMismatchMessage = (data = {}) => {
  const itemTipo = String(data?.item_tipo || '')
    .trim()
    .toLowerCase();
  const itemLabel = itemTipo === 'producto' ? 'producto' : itemTipo === 'insumo' ? 'insumo' : 'item';
  const idItem = parsePositiveInt(data?.id_item);
  const idAlmacenDestino = parsePositiveInt(data?.id_almacen_destino);
  const idAlmacenActual = parsePositiveInt(data?.id_almacen_actual);

  if (idItem && idAlmacenDestino && idAlmacenActual) {
    return `El ${itemLabel} ${idItem} pertenece al almacen ${idAlmacenActual} y no al almacen destino ${idAlmacenDestino}.`;
  }

  if (idAlmacenDestino && idAlmacenActual) {
    return `El item pertenece al almacen ${idAlmacenActual} y no al almacen destino ${idAlmacenDestino}.`;
  }

  return 'Se detecto una incoherencia entre almacen destino y almacen real del item.';
};

// AM: parser defensivo para mapear excepciones SQL del trigger mono-almacen al contrato HTTP estable.
const parseWarehouseMismatchDataFromDbError = (error) => {
  const message = String(error?.message || '');
  const detail = String(error?.detail || '');
  const source = `${message} ${detail}`;
  if (!source.toUpperCase().includes('WAREHOUSE_ITEM_MISMATCH')) return null;

  const extractToken = (key) => {
    const match = source.match(new RegExp(`${key}=([A-Za-z0-9_-]+)`, 'i'));
    return match?.[1] || null;
  };

  return buildWarehouseMismatchData({
    idDetalle: extractToken('id_detalle'),
    itemTipo: extractToken('item_tipo'),
    idItem: extractToken('id_item'),
    idAlmacenDestino: extractToken('id_almacen_destino'),
    idAlmacenActual: extractToken('id_almacen_actual')
  });
};

const sendWarehouseMismatchConflict = (res, context = {}) => {
  const data = buildWarehouseMismatchData(context);
  return sendError(
    res,
    409,
    'WAREHOUSE_ITEM_MISMATCH',
    formatWarehouseMismatchMessage(data),
    { data }
  );
};

// AM: resuelve de forma uniforme el item de una linea OC/compra para validaciones de almacen destino.
const resolveOrderItemReference = ({ idProducto = null, idInsumo = null } = {}) => {
  const parsedProducto = parsePositiveInt(idProducto);
  if (parsedProducto) {
    return { item_tipo: 'producto', id_item: parsedProducto };
  }

  const parsedInsumo = parsePositiveInt(idInsumo);
  if (parsedInsumo) {
    return { item_tipo: 'insumo', id_item: parsedInsumo };
  }

  return { item_tipo: null, id_item: null };
};

// AM: helper central para bloquear incoherencias item-vs-almacen destino en modo mono-almacen real.
const validateItemWarehouseAlignment = ({
  idDetalle = null,
  itemTipo = null,
  idItem = null,
  idAlmacenDestino = null,
  idAlmacenActual = null
} = {}) => {
  const data = buildWarehouseMismatchData({
    idDetalle,
    itemTipo,
    idItem,
    idAlmacenDestino,
    idAlmacenActual
  });
  const warehouseDestino = parsePositiveInt(data.id_almacen_destino);
  const warehouseActual = parsePositiveInt(data.id_almacen_actual);

  if (warehouseDestino && warehouseActual && warehouseDestino !== warehouseActual) {
    return {
      ok: false,
      data
    };
  }

  return {
    ok: true,
    data,
    id_almacen_resuelto: warehouseDestino || warehouseActual || null
  };
};

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

const buildSafeWorkflowErrorLog = (error) => {
  const message = normalizeText(error?.message, 300) || 'Unhandled workflow error.';
  const detail = normalizeText(error?.detail, 300);
  const hint = normalizeText(error?.hint, 200);
  const where = normalizeText(error?.where, 200);
  const constraint = normalizeText(error?.constraint, 120);
  const table = normalizeText(error?.table, 80);
  const column = normalizeText(error?.column, 80);
  const schema = normalizeText(error?.schema, 80);
  const dataType = normalizeText(error?.dataType, 80);
  const severity = normalizeText(error?.severity, 40);
  const position = normalizeText(error?.position, 40);
  const internalPosition = normalizeText(error?.internalPosition, 40);
  const internalQuery = normalizeText(error?.internalQuery, 200);
  const routine = normalizeText(error?.routine, 80);

  return {
    code: normalizeText(error?.code, 20) || null,
    name: normalizeText(error?.name, 60) || null,
    severity: severity || null,
    message,
    detail: detail || null,
    hint: hint || null,
    where: where || null,
    constraint: constraint || null,
    schema: schema || null,
    table: table || null,
    column: column || null,
    data_type: dataType || null,
    position: position || null,
    internal_position: internalPosition || null,
    internal_query: internalQuery || null,
    routine: routine || null
  };
};

const sendServerError = (res, context, error) => {
  console.error(`[ordenes_compra_workflow] ${context}:`, buildSafeWorkflowErrorLog(error));

  const warehouseMismatchData = parseWarehouseMismatchDataFromDbError(error);
  if (warehouseMismatchData) {
    return sendWarehouseMismatchConflict(res, warehouseMismatchData);
  }

  // AM: normaliza conflictos de unicidad antes del mapeo de schema para evitar falsos OC_SCHEMA_MISSING.
  if (error?.code === '23505') {
    return sendError(res, 409, 'CONFLICT', 'La operacion genero un conflicto con datos existentes.');
  }

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
  // AM: compatibilidad retroactiva; "mine/propias" se interpreta como scope de sucursal.
  if (!normalized || normalized === 'mine' || normalized === 'propias' || normalized === 'branch' || normalized === 'sucursal') {
    return 'branch';
  }
  if (normalized === 'all' || normalized === 'todas' || normalized === 'global') return 'all';
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

// AM: normaliza nombre de rol para endurecer reglas funcionales sin depender de etiquetas exactas en BD/token.
const normalizeRoleName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

const ADMIN_OC_ROLE_NAMES = new Set(['SUPER_ADMIN', 'ADMIN', 'ADMINISTRADOR']);
const OPERATIVE_OC_ROLE_NAMES = new Set([
  'CAJERO',
  'COCINA',
  'COCINERO',
  'COCINERA',
  'JEFA_COCINA',
  'JEFE_COCINA'
]);

const getOcRoleContext = async (req, idUsuario, queryRunner = pool) => {
  const cached = req?.__ocRoleContext;
  if (cached?.idUsuario === idUsuario) return cached;

  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  const tokenRoles = Array.isArray(req?.user?.roles)
    ? req.user.roles.map(normalizeRoleName).filter(Boolean)
    : [];
  const roleSet = new Set(tokenRoles);

  // AM: fallback a BD para sesiones/tokenes que no incluyan roles completos.
  if (roleSet.size === 0 && idUsuario) {
    const dbRolesResult = await queryRunner.query(
      `
        SELECT DISTINCT UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) AS role_name
        FROM public.roles_usuarios ru
        INNER JOIN public.roles r ON r.id_rol = ru.id_rol
        WHERE ru.id_usuario = $1
      `,
      [idUsuario]
    );
    for (const row of dbRolesResult.rows || []) {
      const normalized = normalizeRoleName(row?.role_name);
      if (normalized) roleSet.add(normalized);
    }
  }

  const isAdmin = !isSuperAdmin && Array.from(roleSet).some((role) => ADMIN_OC_ROLE_NAMES.has(role));
  const isFullOcManager = isSuperAdmin || isAdmin;
  const isOperativeOcActor = !isFullOcManager && Array.from(roleSet).some((role) => OPERATIVE_OC_ROLE_NAMES.has(role));

  const payload = { idUsuario, isSuperAdmin, isAdmin, isFullOcManager, isOperativeOcActor, roleSet };
  req.__ocRoleContext = payload;
  return payload;
};

const canUserViewAllOrders = async (req, idUsuario, queryRunner = pool) => {
  // AM: el alcance global de OC queda restringido a Admin/Super Admin por rol funcional.
  const roleContext = await getOcRoleContext(req, idUsuario, queryRunner);
  return roleContext.isFullOcManager;
};

const canUserManageOrderWorkflow = async (req, idUsuario, queryRunner = pool) => {
  // AM: gestion administrativa de OC restringida al rol funcional Admin/Super Admin.
  const roleContext = await getOcRoleContext(req, idUsuario, queryRunner);
  if (!roleContext.isFullOcManager) return false;
  return true;
};

const canUserViewAdminOrderData = async (req, idUsuario, queryRunner = pool) => {
  // AM: datos administrativos completos de OC se reservan para Admin/Super Admin.
  const roleContext = await getOcRoleContext(req, idUsuario, queryRunner);
  if (!roleContext.isFullOcManager) return false;
  return true;
};

const sanitizeOrderForOperativeDetail = (row) => {
  if (!row || typeof row !== 'object') return row;
  const estadoActual = String(row?.estado_flujo || '').trim().toUpperCase();
  const comentarioRevisionRechazo =
    estadoActual === ESTADO_RECHAZADA ? normalizeText(row?.comentario_revision, MAX_TEXT_LEN) : null;
  // AM: cocina/cajero no deben ver acciones/metadata administrativas internas.
  return {
    ...row,
    // AM: operativo solo puede ver el motivo cuando la orden fue rechazada.
    comentario_revision: comentarioRevisionRechazo,
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
          AND UPPER(COALESCE(oc.estado_flujo, '')) <> $1
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
    [ESTADO_RECHAZADA]
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
        doc.id_unidad_base,
        ub.nombre AS unidad_base_nombre,
        ub.simbolo AS unidad_base_simbolo,
        doc.id_presentacion_insumo,
        ip.nombre_presentacion,
        doc.cantidad_presentacion,
        doc.id_unidad_presentacion,
        up.nombre AS unidad_presentacion_nombre,
        up.simbolo AS unidad_presentacion_simbolo,
        doc.factor_conversion_usado,
        COALESCE(ip.estado, false) AS presentacion_estado_actual,
        COALESCE(ip.uso_compra, false) AS presentacion_uso_compra_actual,
        CASE
          WHEN doc.id_presentacion_insumo IS NOT NULL THEN 'presentacion'
          ELSE 'base'
        END AS modo_unidad,
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
      LEFT JOIN public.unidades_medida ub ON ub.id_unidad_medida = doc.id_unidad_base
      LEFT JOIN public.insumo_presentaciones ip ON ip.id_presentacion = doc.id_presentacion_insumo
      LEFT JOIN public.unidades_medida up ON up.id_unidad_medida = doc.id_unidad_presentacion
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

// AM: resumen confiable por proveedor para OC multi-proveedor sin depender de compra_actual singular.
const getComprasPorProveedorSummary = async (
  idOrdenCompra,
  { idArchivoFacturaRecepcion = null } = {},
  queryRunner = pool
) => {
  const requiredProvidersResult = await queryRunner.query(
    `
      SELECT
        doc.id_proveedor_sugerido AS id_proveedor,
        COALESCE(prov.nombre_proveedor, 'Proveedor sin definir') AS nombre_proveedor,
        COUNT(*)::int AS total_lineas_oc,
        COALESCE(SUM(doc.cantidad_orden), 0)::int AS total_cantidad_oc
      FROM public.detalle_orden_compras doc
      LEFT JOIN public.proveedores prov ON prov.id_proveedor = doc.id_proveedor_sugerido
      WHERE doc.id_orden_compra = $1
      GROUP BY doc.id_proveedor_sugerido, COALESCE(prov.nombre_proveedor, 'Proveedor sin definir')
      ORDER BY doc.id_proveedor_sugerido ASC NULLS FIRST
    `,
    [idOrdenCompra]
  );
  const requiredProviderRows = requiredProvidersResult.rows || [];
  if (requiredProviderRows.length === 0) return [];

  const comprasByProviderResult = await queryRunner.query(
    `
      SELECT DISTINCT ON (c.id_proveedor)
        c.id_compra,
        c.id_proveedor,
        c.id_archivo_transferencia,
        c.referencia_transferencia,
        COALESCE(NULLIF(to_jsonb(c)->>'observacion_pago', ''), NULL)::text AS observacion_pago,
        COALESCE(NULLIF(to_jsonb(c)->>'metodo_pago', ''), NULL)::text AS metodo_pago,
        COALESCE(NULLIF(to_jsonb(c)->>'metodo_pago_codigo', ''), NULL)::text AS metodo_pago_codigo,
        COALESCE(NULLIF(to_jsonb(c)->>'tipo_pago', ''), NULL)::text AS tipo_pago,
        COALESCE(NULLIF(to_jsonb(c)->>'forma_pago', ''), NULL)::text AS forma_pago,
        prov.nombre_proveedor
      FROM public.compras c
      LEFT JOIN public.proveedores prov ON prov.id_proveedor = c.id_proveedor
      WHERE c.id_orden_compra = $1
        AND c.id_proveedor IS NOT NULL
      ORDER BY c.id_proveedor ASC, c.id_compra DESC
    `,
    [idOrdenCompra]
  );
  const latestCompraByProvider = new Map();
  for (const row of comprasByProviderResult.rows || []) {
    const providerId = parsePositiveInt(row.id_proveedor);
    if (!providerId) continue;
    latestCompraByProvider.set(providerId, row);
  }

  const compraIds = Array.from(
    new Set(
      Array.from(latestCompraByProvider.values())
        .map((row) => parsePositiveInt(row.id_compra))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  const purchaseDetailByCompra = new Map();
  if (compraIds.length > 0) {
    const purchaseDetailAggResult = await queryRunner.query(
      `
        SELECT
          dc.id_compra,
          COUNT(*)::int AS total_lineas_compra,
          COALESCE(SUM(dc.cantidad), 0)::int AS total_cantidad_compra
        FROM public.detalle_compras dc
        WHERE dc.id_compra = ANY($1::int[])
        GROUP BY dc.id_compra
      `,
      [compraIds]
    );
    for (const row of purchaseDetailAggResult.rows || []) {
      const idCompra = parsePositiveInt(row.id_compra);
      if (!idCompra) continue;
      purchaseDetailByCompra.set(idCompra, {
        total_lineas_compra: parsePositiveInt(row.total_lineas_compra) || 0,
        total_cantidad_compra: parseNonNegativeNumber(row.total_cantidad_compra) || 0
      });
    }
  }

  const hasFacturaRecepcion = Boolean(parsePositiveInt(idArchivoFacturaRecepcion));
  return requiredProviderRows.map((requiredRow) => {
    const providerId = parsePositiveInt(requiredRow.id_proveedor);
    const compraProveedor = providerId ? latestCompraByProvider.get(providerId) || null : null;
    const idCompra = parsePositiveInt(compraProveedor?.id_compra);
    const compraAgg = idCompra
      ? purchaseDetailByCompra.get(idCompra) || { total_lineas_compra: 0, total_cantidad_compra: 0 }
      : { total_lineas_compra: 0, total_cantidad_compra: 0 };
    const totalLineasOc = parsePositiveInt(requiredRow.total_lineas_oc) || 0;
    const totalCantidadOc = parseNonNegativeNumber(requiredRow.total_cantidad_oc) || 0;
    const totalLineasCompra = parsePositiveInt(compraAgg.total_lineas_compra) || 0;
    const totalCantidadCompra = parseNonNegativeNumber(compraAgg.total_cantidad_compra) || 0;
    const tieneCompra = Boolean(providerId && idCompra);
    const cantidadesCuadran = Boolean(tieneCompra && totalCantidadCompra === totalCantidadOc);
    const hintsRaw = [
      compraProveedor?.metodo_pago,
      compraProveedor?.metodo_pago_codigo,
      compraProveedor?.tipo_pago,
      compraProveedor?.forma_pago,
      compraProveedor?.observacion_pago,
      compraProveedor?.referencia_transferencia
    ]
      .map((value) => normalizeText(value, MAX_SHORT_TEXT_LEN))
      .filter(Boolean);
    const metodoPago = hintsRaw[0] || null;
    const hasMetodoPagoHint = hintsRaw.length > 0;
    const tieneTransferencia = Boolean(parsePositiveInt(compraProveedor?.id_archivo_transferencia));

    const evidenciasPendientes = [];
    if (!hasFacturaRecepcion) {
      evidenciasPendientes.push('Falta factura general de la orden.');
    }
    if (tieneCompra && doesCompraRequireTransferEvidence(compraProveedor) && !tieneTransferencia) {
      evidenciasPendientes.push('Falta comprobante de deposito o transferencia.');
    }
    if (tieneCompra && !hasMetodoPagoHint) {
      evidenciasPendientes.push('Metodo de pago no claro para validar comprobante.');
    }

    let estadoGrupo = 'PENDIENTE';
    if (!providerId) {
      // AM: proveedor sin definir siempre se reporta pendiente para forzar definicion operativa previa.
      estadoGrupo = 'PENDIENTE';
    } else if (tieneCompra) {
      estadoGrupo = cantidadesCuadran && totalLineasCompra > 0 ? 'CONVERTIDO' : 'EN_COMPRA';
    }

    return {
      id_proveedor: providerId || null,
      nombre_proveedor:
        normalizeText(
          requiredRow.nombre_proveedor ||
            compraProveedor?.nombre_proveedor ||
            (providerId ? `Proveedor #${providerId}` : 'Proveedor sin definir'),
          MAX_SHORT_TEXT_LEN
        ) || (providerId ? `Proveedor #${providerId}` : 'Proveedor sin definir'),
      id_compra: idCompra || null,
      estado_grupo: estadoGrupo,
      total_lineas_oc: totalLineasOc,
      total_cantidad_oc: totalCantidadOc,
      total_lineas_compra: totalLineasCompra,
      total_cantidad_compra: totalCantidadCompra,
      tiene_compra: tieneCompra,
      cantidades_cuadran: cantidadesCuadran,
      tiene_transferencia: tieneTransferencia,
      metodo_pago: metodoPago,
      evidencias_pendientes: evidenciasPendientes
    };
  });
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

const getOrderEvidenceHistory = async (idOrdenCompra, queryRunner = pool) => {
  try {
    const result = await queryRunner.query(
      `
        SELECT
          h.id_historial_evidencia,
          h.id_orden_compra,
          h.id_compra,
          h.tipo_evidencia,
          h.id_archivo,
          h.id_usuario_registro,
          h.origen_etapa,
          h.fecha_registro,
          a.url_publica AS evidencia_url_publica,
          u.nombre_usuario AS usuario_registro_nombre
        FROM public.orden_compra_evidencias_historial h
        LEFT JOIN public.archivos a ON a.id_archivo = h.id_archivo
        LEFT JOIN public.usuarios u ON u.id_usuario = h.id_usuario_registro
        WHERE h.id_orden_compra = $1
        ORDER BY h.fecha_registro DESC, h.id_historial_evidencia DESC
      `,
      [idOrdenCompra]
    );
    return result.rows || [];
  } catch (error) {
    // AM: compatibilidad con entornos donde la migracion de historial aun no esta aplicada.
    if (error?.code === '42P01' || error?.code === '42883') return [];
    throw error;
  }
};

const getArchivoById = async (idArchivo, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT id_archivo, url_publica, tipo_archivo
      FROM public.archivos
      WHERE id_archivo = $1
        AND COALESCE(estado, true) = true
      LIMIT 1
    `,
    [idArchivo]
  );
  return result.rows?.[0] || null;
};

const resolveEvidenceAccessUrl = async (req, storedPath) => {
  const normalized = String(storedPath || '').trim();
  if (!normalized) return { url: null, signed: false, expiresIn: null };
  if (/^https?:\/\//i.test(normalized)) {
    return { url: normalized, signed: false, expiresIn: null };
  }

  const [bucket, ...pathParts] = normalized.replace(/^\/+/, '').split('/');
  const filePath = pathParts.join('/');

  if (bucket === SUPABASE_ADMIN_BUCKET && filePath) {
    const { data, error } = await supabase.storage
      .from(SUPABASE_ADMIN_BUCKET)
      .createSignedUrl(filePath, OC_EVIDENCE_SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      throw new Error('No se pudo generar la URL firmada de evidencia.');
    }

    return {
      url: data.signedUrl,
      signed: true,
      expiresIn: OC_EVIDENCE_SIGNED_URL_TTL_SECONDS
    };
  }

  return {
    url: buildAbsolutePublicUrl(req, normalized),
    signed: false,
    expiresIn: null
  };
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
    const modoUnidad = String(detail?.modo_unidad || 'base').trim().toLowerCase();
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

    if (hasValue(rawProveedorSugerido) && !idProveedorSugerido) {
      return { ok: false, message: 'id_proveedor_sugerido debe ser un entero mayor a 0.' };
    }

    if (itemTipo === 'producto') {
      if (modoUnidad !== 'base') {
        return { ok: false, message: 'Los productos no aceptan modo de presentacion.' };
      }
      if (
        hasValue(detail?.id_presentacion_insumo) ||
        hasValue(detail?.cantidad_presentacion) ||
        hasValue(detail?.id_unidad_presentacion) ||
        hasValue(detail?.factor_conversion_usado)
      ) {
        return { ok: false, message: 'Los productos no aceptan presentaciones de insumo.' };
      }
    }

    if (itemTipo === 'insumo' && !['base', 'presentacion'].includes(modoUnidad)) {
      return { ok: false, message: 'modo_unidad debe ser "base" o "presentacion".' };
    }

    const idPresentacionInsumo =
      itemTipo === 'insumo' && modoUnidad === 'presentacion'
        ? parsePositiveInt(detail?.id_presentacion_insumo)
        : null;
    const cantidadPresentacion =
      itemTipo === 'insumo' && modoUnidad === 'presentacion'
        ? parsePositiveDecimal4(detail?.cantidad_presentacion)
        : null;
    const cantidad =
      itemTipo === 'producto'
        ? parsePositiveInt(detail?.cantidad)
        : modoUnidad === 'presentacion'
          ? null
          : parsePositiveDecimal4(detail?.cantidad);

    if (itemTipo === 'producto' && !cantidad) {
      return { ok: false, message: 'cantidad de producto debe ser un entero mayor a 0.' };
    }
    if (itemTipo === 'insumo' && modoUnidad === 'base' && cantidad === null) {
      return { ok: false, message: 'cantidad de insumo debe ser decimal positivo con hasta 4 decimales.' };
    }
    if (itemTipo === 'insumo' && modoUnidad === 'presentacion') {
      if (!idPresentacionInsumo) {
        return { ok: false, message: 'id_presentacion_insumo debe ser un entero mayor a 0.' };
      }
      if (cantidadPresentacion === null) {
        return { ok: false, message: 'cantidad_presentacion debe ser decimal positivo con hasta 4 decimales.' };
      }
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
    const aggregationMode = itemTipo === 'insumo' ? modoUnidad : 'base';
    const key = `${itemTipo}:${idItem}:${idAlmacenDestino}:${idProveedorSugerido || 0}:${aggregationMode}:${idPresentacionInsumo || 0}`;
    const previous = aggregatedMap.get(key);
    if (!previous) {
      aggregatedMap.set(key, {
        item_tipo: itemTipo,
        id_item: idItem,
        id_almacen_destino: idAlmacenDestino,
        id_proveedor_sugerido: idProveedorSugerido,
        modo_unidad: aggregationMode,
        id_presentacion_insumo: idPresentacionInsumo,
        cantidad,
        cantidad_orden: cantidad,
        cantidad_presentacion: cantidadPresentacion,
        id_unidad_base: null,
        id_unidad_presentacion: null,
        factor_conversion_usado: null
      });
      continue;
    }

    if (aggregationMode === 'presentacion') {
      previous.cantidad_presentacion = roundDecimal(
        Number(previous.cantidad_presentacion || 0) + Number(cantidadPresentacion || 0),
        4
      );
    } else {
      previous.cantidad = itemTipo === 'producto'
        ? Number(previous.cantidad || 0) + Number(cantidad || 0)
        : roundDecimal(Number(previous.cantidad || 0) + Number(cantidad || 0), 4);
      previous.cantidad_orden = previous.cantidad;
    }
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

const resolvePurchasePresentationDetails = async (details, queryRunner = pool) => {
  const rows = Array.isArray(details) ? details : [];
  const insumoIds = Array.from(
    new Set(
      rows
        .filter((detail) => detail.item_tipo === 'insumo')
        .map((detail) => Number(detail.id_item))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
  const presentationIds = Array.from(
    new Set(
      rows
        .filter((detail) => detail.item_tipo === 'insumo' && detail.modo_unidad === 'presentacion')
        .map((detail) => Number(detail.id_presentacion_insumo))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  const insumosMap = new Map();
  if (insumoIds.length > 0) {
    const insumosResult = await queryRunner.query(
      `
        SELECT id_insumo, nombre_insumo, id_unidad_medida, COALESCE(estado, true) AS estado
        FROM public.insumos
        WHERE id_insumo = ANY($1::int[])
      `,
      [insumoIds]
    );
    for (const row of insumosResult.rows || []) {
      insumosMap.set(Number(row.id_insumo), {
        id_insumo: Number(row.id_insumo),
        nombre_insumo: normalizeText(row.nombre_insumo, MAX_SHORT_TEXT_LEN) || `Insumo ${row.id_insumo}`,
        id_unidad_medida: parsePositiveInt(row.id_unidad_medida),
        estado: Boolean(row.estado)
      });
    }
  }

  const presentacionesMap = new Map();
  if (presentationIds.length > 0) {
    const presentacionesResult = await queryRunner.query(
      `
        SELECT
          ip.id_presentacion,
          ip.id_insumo,
          ip.nombre_presentacion,
          ip.cantidad_presentacion,
          ip.id_unidad_presentacion,
          ip.cantidad_base,
          ip.id_unidad_base,
          COALESCE(ip.uso_compra, false) AS uso_compra,
          COALESCE(ip.estado, true) AS estado
        FROM public.insumo_presentaciones ip
        WHERE ip.id_presentacion = ANY($1::bigint[])
      `,
      [presentationIds]
    );
    for (const row of presentacionesResult.rows || []) {
      presentacionesMap.set(Number(row.id_presentacion), row);
    }
  }

  const resolved = [];
  for (const [index, detail] of rows.entries()) {
    const lineLabel = `linea ${index + 1}`;
    if (detail.item_tipo === 'producto') {
      resolved.push({
        ...detail,
        modo_unidad: 'base',
        cantidad_orden: Number(detail.cantidad),
        id_unidad_base: null,
        id_presentacion_insumo: null,
        cantidad_presentacion: null,
        id_unidad_presentacion: null,
        factor_conversion_usado: null
      });
      continue;
    }

    const insumo = insumosMap.get(Number(detail.id_item));
    if (!insumo) {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: `El insumo ${detail.id_item} no existe.` };
    }
    if (!insumo.estado) {
      return { ok: false, status: 409, code: 'CONFLICT', message: `El insumo ${insumo.nombre_insumo} esta inactivo.` };
    }

    if (detail.modo_unidad !== 'presentacion') {
      const cantidadOrden = roundDecimal(detail.cantidad, 4);
      if (cantidadOrden <= 0) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          message: `La cantidad de la ${lineLabel} redondea a 0.0000. Ingresa una cantidad mayor.`
        };
      }
      resolved.push({
        ...detail,
        modo_unidad: 'base',
        cantidad: cantidadOrden,
        cantidad_orden: cantidadOrden,
        id_unidad_base: insumo.id_unidad_medida || null,
        id_presentacion_insumo: null,
        cantidad_presentacion: null,
        id_unidad_presentacion: null,
        factor_conversion_usado: null
      });
      continue;
    }

    if (!insumo.id_unidad_medida) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `El insumo ${insumo.nombre_insumo} no tiene unidad base definida para usar presentaciones.`
      };
    }

    const presentacion = presentacionesMap.get(Number(detail.id_presentacion_insumo));
    if (!presentacion) {
      return {
        ok: false,
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `La presentacion ${detail.id_presentacion_insumo} de la ${lineLabel} no existe.`
      };
    }
    if (Number(presentacion.id_insumo) !== Number(detail.id_item)) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `La presentacion ${detail.id_presentacion_insumo} pertenece a otro insumo.`
      };
    }
    if (!Boolean(presentacion.estado)) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `La presentacion ${presentacion.nombre_presentacion || detail.id_presentacion_insumo} esta inactiva.`
      };
    }
    if (!Boolean(presentacion.uso_compra)) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `La presentacion ${presentacion.nombre_presentacion || detail.id_presentacion_insumo} no esta habilitada para compras.`
      };
    }
    if (Number(presentacion.id_unidad_base) !== Number(insumo.id_unidad_medida)) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `La unidad base de la presentacion no coincide con el insumo ${insumo.nombre_insumo}.`
      };
    }

    const configCantidadPresentacion = parsePositiveDecimal4(presentacion.cantidad_presentacion);
    const configCantidadBase = parsePositiveDecimal4(presentacion.cantidad_base);
    const idUnidadPresentacion = parsePositiveInt(presentacion.id_unidad_presentacion);
    if (configCantidadPresentacion === null || configCantidadBase === null || !idUnidadPresentacion) {
      return {
        ok: false,
        status: 409,
        code: 'CONFLICT',
        message: `La presentacion ${presentacion.nombre_presentacion || detail.id_presentacion_insumo} tiene una conversion invalida.`
      };
    }

    const cantidadPresentacion = roundDecimal(detail.cantidad_presentacion, 4);
    const factorConversion = roundDecimal(configCantidadBase / configCantidadPresentacion, 6);
    const cantidadOrden = roundDecimal(cantidadPresentacion * factorConversion, 4);
    if (cantidadOrden <= 0) {
      return {
        ok: false,
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `La conversion de la ${lineLabel} redondea a 0.0000. Ingresa una cantidad mayor.`
      };
    }

    resolved.push({
      ...detail,
      cantidad: cantidadOrden,
      cantidad_orden: cantidadOrden,
      cantidad_presentacion: cantidadPresentacion,
      id_unidad_base: insumo.id_unidad_medida,
      id_unidad_presentacion: idUnidadPresentacion,
      factor_conversion_usado: factorConversion
    });
  }

  return { ok: true, details: resolved };
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
  const allowPdf = Boolean(options?.allowPdf);
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
  if (allowPdf && tipoArchivo === 'application/pdf') return true;
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

const normalizePaymentMethodText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

// AM: regla conservadora para comprobante: si metodo no es claro, se exige transferencia/deposito.
const doesCompraRequireTransferEvidence = (compraRow = {}) => {
  const hints = [
    compraRow?.metodo_pago,
    compraRow?.metodo_pago_codigo,
    compraRow?.tipo_pago,
    compraRow?.forma_pago,
    compraRow?.observacion_pago,
    compraRow?.referencia_transferencia
  ]
    .map((value) => normalizePaymentMethodText(value))
    .filter(Boolean)
    .join(' ');

  if (!hints) return true;
  if (hints.includes('transfer') || hints.includes('deposit')) return true;
  if (hints.includes('efectivo')) return false;
  if (hints.includes('credito') || hints.includes('credito_fiscal')) return false;
  return true;
};

const buildProviderItemKey = ({ idProveedor, idProducto, idInsumo, idAlmacenDestino }) =>
  [
    `prov:${parsePositiveInt(idProveedor) || 0}`,
    `prod:${parsePositiveInt(idProducto) || 0}`,
    `ins:${parsePositiveInt(idInsumo) || 0}`,
    `alm:${parsePositiveInt(idAlmacenDestino) || 0}`
  ].join('|');

const getProviderLabel = (providerMap, idProveedor) => {
  const key = parsePositiveInt(idProveedor) || 0;
  const providerName = normalizeText(providerMap?.get?.(key), MAX_SHORT_TEXT_LEN);
  if (providerName) return providerName;
  return `#${key}`;
};

const parseItemRequestReviewAction = (value) => {
  const action = String(value ?? '')
    .trim()
    .toLowerCase();
  if (action === 'aprobar') return 'aprobar';
  if (action === 'rechazar') return 'rechazar';
  return null;
};

const parseIsoDateOnly = (value) => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
};

const parseTriStateYesNo = (value) => {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (['si', 'sí', 'yes', 'true', '1'].includes(text)) return true;
  if (['no', 'false', '0'].includes(text)) return false;
  return null;
};

const parseProviderSuggestionItems = (rawItems) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, message: 'items debe ser un arreglo con al menos un elemento.' };
  }
  if (rawItems.length > MAX_PROVIDER_SUGGESTION_ITEMS) {
    return {
      ok: false,
      message: `items no puede superar ${MAX_PROVIDER_SUGGESTION_ITEMS} elementos por solicitud.`
    };
  }

  const dedupe = new Map();
  for (const row of rawItems) {
    const itemTipo = String(row?.item_tipo ?? '')
      .trim()
      .toUpperCase();
    const idItem = parsePositiveInt(row?.id_item);
    if (!['PRODUCTO', 'INSUMO'].includes(itemTipo)) {
      return { ok: false, message: 'item_tipo debe ser PRODUCTO o INSUMO.' };
    }
    if (!idItem) {
      return { ok: false, message: 'id_item debe ser un entero mayor a 0.' };
    }
    const key = `${itemTipo}:${idItem}`;
    if (!dedupe.has(key)) {
      dedupe.set(key, {
        item_tipo: itemTipo,
        id_item: idItem
      });
    }
  }

  return { ok: true, items: Array.from(dedupe.values()) };
};

const validateSucursalExists = async (idSucursal, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT 1
      FROM public.sucursales s
      WHERE s.id_sucursal = $1
        AND COALESCE(s.estado, true) = true
      LIMIT 1
    `,
    [idSucursal]
  );
  return result.rowCount > 0;
};

// AM: resuelve proveedor sugerido por lote priorizando historial de sucursal y fallback global.
const getSuggestedProvidersByItems = async (idSucursal, items, queryRunner = pool) => {
  const itemTipos = items.map((item) => item.item_tipo);
  const itemIds = items.map((item) => item.id_item);

  const result = await queryRunner.query(
    `
      WITH input_items AS (
        SELECT DISTINCT
          src.item_tipo,
          src.id_item
        FROM UNNEST($2::text[], $3::int[]) AS src(item_tipo, id_item)
      ),
      history AS (
        SELECT
          input.item_tipo,
          input.id_item,
          c.id_compra,
          c.id_proveedor,
          prov.nombre_proveedor,
          c.fecha,
          alm.id_sucursal,
          COALESCE(UPPER(NULLIF(oc.estado_flujo, '')), '') AS estado_flujo
        FROM input_items input
        INNER JOIN public.detalle_compras dc
          ON (
            (input.item_tipo = 'PRODUCTO' AND dc.id_producto = input.id_item)
            OR (input.item_tipo = 'INSUMO' AND dc.id_insumo = input.id_item)
          )
        INNER JOIN public.compras c ON c.id_compra = dc.id_compra
        INNER JOIN public.proveedores prov ON prov.id_proveedor = c.id_proveedor
        LEFT JOIN public.almacenes alm ON alm.id_almacen = dc.id_almacen_destino
        LEFT JOIN public.orden_compras oc ON oc.id_orden_compra = c.id_orden_compra
        WHERE c.id_proveedor IS NOT NULL
          AND COALESCE(c.estado, true) = true
          AND COALESCE(prov.estado, true) = true
      ),
      history_agg AS (
        SELECT
          h.item_tipo,
          h.id_item,
          h.id_proveedor,
          MAX(h.nombre_proveedor) AS nombre_proveedor,
          COUNT(*) FILTER (WHERE h.id_sucursal = $1) AS freq_sucursal,
          MAX(h.fecha) FILTER (WHERE h.id_sucursal = $1) AS latest_fecha_sucursal,
          MAX(h.id_compra) FILTER (WHERE h.id_sucursal = $1) AS latest_compra_sucursal,
          COUNT(*) FILTER (
            WHERE h.id_sucursal = $1
              AND h.estado_flujo IN ('ABASTECIDA', 'EN_COMPRA')
          ) AS preferred_state_hits_sucursal,
          COUNT(*) AS freq_global,
          MAX(h.fecha) AS latest_fecha_global,
          MAX(h.id_compra) AS latest_compra_global,
          COUNT(*) FILTER (
            WHERE h.estado_flujo IN ('ABASTECIDA', 'EN_COMPRA')
          ) AS preferred_state_hits_global
        FROM history h
        GROUP BY h.item_tipo, h.id_item, h.id_proveedor
      ),
      best_sucursal AS (
        SELECT
          agg.item_tipo,
          agg.id_item,
          agg.id_proveedor,
          agg.nombre_proveedor,
          ROW_NUMBER() OVER (
            PARTITION BY agg.item_tipo, agg.id_item
            ORDER BY
              CASE WHEN agg.preferred_state_hits_sucursal > 0 THEN 1 ELSE 0 END DESC,
              agg.latest_fecha_sucursal DESC NULLS LAST,
              agg.freq_sucursal DESC,
              agg.latest_compra_sucursal DESC NULLS LAST,
              agg.id_proveedor DESC
          ) AS rn
        FROM history_agg agg
        WHERE agg.freq_sucursal > 0
      ),
      best_global AS (
        SELECT
          agg.item_tipo,
          agg.id_item,
          agg.id_proveedor,
          agg.nombre_proveedor,
          ROW_NUMBER() OVER (
            PARTITION BY agg.item_tipo, agg.id_item
            ORDER BY
              CASE WHEN agg.preferred_state_hits_global > 0 THEN 1 ELSE 0 END DESC,
              agg.latest_fecha_global DESC NULLS LAST,
              agg.freq_global DESC,
              agg.latest_compra_global DESC NULLS LAST,
              agg.id_proveedor DESC
          ) AS rn
        FROM history_agg agg
        WHERE agg.freq_global > 0
      )
      SELECT
        input.item_tipo,
        input.id_item,
        COALESCE(bs.id_proveedor, bg.id_proveedor) AS id_proveedor_sugerido,
        COALESCE(bs.nombre_proveedor, bg.nombre_proveedor) AS proveedor_sugerido_nombre,
        CASE
          WHEN bs.id_proveedor IS NOT NULL THEN 'HISTORIAL_SUCURSAL'
          WHEN bg.id_proveedor IS NOT NULL THEN 'HISTORIAL_GLOBAL'
          ELSE 'SIN_HISTORIAL'
        END AS proveedor_sugerido_origen
      FROM input_items input
      LEFT JOIN best_sucursal bs
        ON bs.item_tipo = input.item_tipo
       AND bs.id_item = input.id_item
       AND bs.rn = 1
      LEFT JOIN best_global bg
        ON bg.item_tipo = input.item_tipo
       AND bg.id_item = input.id_item
       AND bg.rn = 1
      ORDER BY input.item_tipo ASC, input.id_item ASC
    `,
    [idSucursal, itemTipos, itemIds]
  );

  const map = new Map();
  for (const row of result.rows || []) {
    const itemTipo = String(row.item_tipo || '')
      .trim()
      .toUpperCase();
    const idItem = parsePositiveInt(row.id_item);
    if (!['PRODUCTO', 'INSUMO'].includes(itemTipo) || !idItem) continue;
    const key = `${itemTipo}:${idItem}`;
    map.set(key, {
      item_tipo: itemTipo,
      id_item: idItem,
      id_proveedor_sugerido: parsePositiveInt(row.id_proveedor_sugerido) || null,
      proveedor_sugerido_nombre:
        normalizeText(row.proveedor_sugerido_nombre, MAX_SHORT_TEXT_LEN) || null,
      proveedor_sugerido_origen: String(row.proveedor_sugerido_origen || 'SIN_HISTORIAL').trim()
    });
  }

  return items.map((item) => {
    const key = `${item.item_tipo}:${item.id_item}`;
    const suggested = map.get(key);
    if (suggested) return suggested;
    return {
      item_tipo: item.item_tipo,
      id_item: item.id_item,
      id_proveedor_sugerido: null,
      proveedor_sugerido_nombre: null,
      proveedor_sugerido_origen: 'SIN_HISTORIAL'
    };
  });
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

    const presentacionesResult = await pool.query(
      `
        SELECT
          ip.id_presentacion,
          ip.id_insumo,
          ip.nombre_presentacion,
          ip.cantidad_presentacion,
          ip.id_unidad_presentacion,
          up.nombre AS unidad_presentacion_nombre,
          up.simbolo AS unidad_presentacion_simbolo,
          ip.cantidad_base,
          ip.id_unidad_base,
          ub.nombre AS unidad_base_nombre,
          ub.simbolo AS unidad_base_simbolo,
          COALESCE(ip.es_predeterminada_compra, false) AS es_predeterminada_compra
        FROM public.insumo_presentaciones ip
        LEFT JOIN public.unidades_medida up ON up.id_unidad_medida = ip.id_unidad_presentacion
        LEFT JOIN public.unidades_medida ub ON ub.id_unidad_medida = ip.id_unidad_base
        WHERE COALESCE(ip.estado, true) = true
          AND COALESCE(ip.uso_compra, false) = true
        ORDER BY ip.id_insumo ASC, COALESCE(ip.es_predeterminada_compra, false) DESC, ip.nombre_presentacion ASC
      `
    );

    return res.status(200).json({
      ok: true,
      data: {
        id_sucursal_usuario: userSucursalId || null,
        restringido_a_sucursal_usuario: !canViewAll,
        almacenes_permitidos: warehousesResult.rows || [],
        presentaciones_compra: presentacionesResult.rows || []
      }
    });
  } catch (error) {
    return sendServerError(res, 'GET /orden_compras/workflow/contexto_creacion', error);
  }
});

router.post('/orden_compras/workflow/proveedores-sugeridos', checkPermission(PERM_OC_CREATE), async (req, res) => {
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    const idSucursal = parsePositiveInt(req.body?.id_sucursal);
    if (!idSucursal) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_sucursal es obligatorio y debe ser valido.');
    }

    const parsedItems = parseProviderSuggestionItems(req.body?.items);
    if (!parsedItems.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', parsedItems.message);
    }

    const canViewAll = await canUserViewAllOrders(req, idUsuario);
    const userSucursalId = await getUserSucursalId(idUsuario);
    if (!canViewAll) {
      if (!userSucursalId) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Tu usuario no tiene sucursal asignada para consultar proveedores sugeridos.'
        );
      }
      if (userSucursalId !== idSucursal) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'No tienes permiso para consultar proveedores sugeridos de otra sucursal.'
        );
      }
    }

    const sucursalExiste = await validateSucursalExists(idSucursal);
    if (!sucursalExiste) {
      return sendError(res, 404, 'NOT_FOUND', 'La sucursal indicada no existe o esta inactiva.');
    }

    // AM: sugerencias por lote para evitar N+1 y mantener creacion rapida en OC con muchas lineas.
    const suggestions = await getSuggestedProvidersByItems(idSucursal, parsedItems.items);

    return res.status(200).json({
      ok: true,
      data: suggestions
    });
  } catch (error) {
    return sendServerError(res, 'POST /orden_compras/workflow/proveedores-sugeridos', error);
  }
});

router.get('/orden_compras/workflow', checkPermission(PERM_OC_VIEW_FLOW), async (req, res) => {
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');

    // AM: `scope` se valida por compatibilidad con clientes legacy, pero no define el alcance real.
    const requestedScope = resolveScope(req.query?.scope);
    if (!requestedScope) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'scope invalido. Use branch o all. El alcance final se define por rol.'
      );
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
    // AM: paginacion profesional: page_size preferido con fallback compat a limit/pageSize legacy.
    const rawPageSize = hasValue(req.query?.page_size)
      ? req.query?.page_size
      : hasValue(req.query?.pageSize)
      ? req.query?.pageSize
      : req.query?.limit;
    const pageSize = Math.min(parsePositiveInt(rawPageSize) || 15, 50);
    const offset = (page - 1) * pageSize;
    const search = normalizeText(req.query?.q, 120);
    const idProveedorFilter = parseOptionalPositiveInt(req.query?.id_proveedor);
    if (hasValue(req.query?.id_proveedor) && !idProveedorFilter) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_proveedor invalido.');
    }

    const fechaDesde = hasValue(req.query?.fecha_desde) ? parseIsoDateOnly(req.query?.fecha_desde) : null;
    if (hasValue(req.query?.fecha_desde) && !fechaDesde) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'fecha_desde invalida. Formato esperado YYYY-MM-DD.');
    }
    const fechaHasta = hasValue(req.query?.fecha_hasta) ? parseIsoDateOnly(req.query?.fecha_hasta) : null;
    if (hasValue(req.query?.fecha_hasta) && !fechaHasta) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'fecha_hasta invalida. Formato esperado YYYY-MM-DD.');
    }
    if (fechaDesde && fechaHasta && fechaDesde > fechaHasta) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'fecha_desde no puede ser mayor que fecha_hasta.');
    }

    const evidenciasPendientesFilter = hasValue(req.query?.evidencias_pendientes)
      ? parseTriStateYesNo(req.query?.evidencias_pendientes)
      : null;
    if (hasValue(req.query?.evidencias_pendientes) && evidenciasPendientesFilter === null) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'evidencias_pendientes invalido. Use SI/NO o true/false.'
      );
    }

    const canViewAll = await canUserViewAllOrders(req, idUsuario);
    // AM: la visibilidad real del negocio se define por rol, no por query param.
    // AM: admins/superadmin = global; operativos = sucursal propia.
    const effectiveScope = canViewAll ? 'all' : 'branch';

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
        // AM: para perfiles operativos se fuerza sucursal propia y se ignora filtro externo.
        effectiveSucursalFilter = userSucursalId;
      } else {
        effectiveSucursalFilter = userSucursalId;
      }
    }

    const whereParts = [];
    const params = [];

    if (effectiveScope === 'branch' && effectiveSucursalFilter) {
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

    if (idProveedorFilter) {
      params.push(idProveedorFilter);
      // AM: proveedor filtra por lineas sugeridas y por compras ya convertidas en la OC.
      whereParts.push(`
        (
          EXISTS (
            SELECT 1
            FROM public.detalle_orden_compras doc_prov
            WHERE doc_prov.id_orden_compra = oc.id_orden_compra
              AND doc_prov.id_proveedor_sugerido = $${params.length}
          )
          OR EXISTS (
            SELECT 1
            FROM public.compras c_prov
            WHERE c_prov.id_orden_compra = oc.id_orden_compra
              AND c_prov.id_proveedor = $${params.length}
          )
        )
      `);
    }

    if (fechaDesde) {
      params.push(fechaDesde);
      whereParts.push(
        `DATE(COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp)) >= $${params.length}::date`
      );
    }

    if (fechaHasta) {
      params.push(fechaHasta);
      whereParts.push(
        `DATE(COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp)) <= $${params.length}::date`
      );
    }

    if (evidenciasPendientesFilter === true) {
      // AM: "SI" significa compra existente con factura o transferencia pendientes.
      whereParts.push(`
        EXISTS (
          SELECT 1
          FROM public.compras c_ev
          WHERE c_ev.id_orden_compra = oc.id_orden_compra
        )
        AND (
          oc.id_archivo_factura_recepcion IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.compras c_ev_p
            WHERE c_ev_p.id_orden_compra = oc.id_orden_compra
              AND c_ev_p.id_archivo_transferencia IS NULL
          )
        )
      `);
    } else if (evidenciasPendientesFilter === false) {
      // AM: "NO" incluye ordenes sin compra (no aplica) y ordenes con evidencias completas.
      whereParts.push(`
        (
          NOT EXISTS (
            SELECT 1
            FROM public.compras c_ev
            WHERE c_ev.id_orden_compra = oc.id_orden_compra
          )
          OR (
            oc.id_archivo_factura_recepcion IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM public.compras c_ev_p
              WHERE c_ev_p.id_orden_compra = oc.id_orden_compra
                AND c_ev_p.id_archivo_transferencia IS NULL
            )
          )
        )
      `);
    }

    if (search) {
      params.push(`%${search}%`);
      whereParts.push(`
        (
          CAST(oc.id_orden_compra AS text) ILIKE $${params.length}
          OR COALESCE(NULLIF(to_jsonb(oc)->>'numero_oc_visible', ''), '') ILIKE $${params.length}
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
    let summary = {
      ...EMPTY_ORDER_WORKFLOW_SUMMARY,
      total_ordenes: total
    };
    try {
      // AM: resumen global del conjunto filtrado completo; no depende de page ni page_size.
      const summaryResult = await pool.query(
        `
          WITH filtered_orders AS (
            SELECT
              oc.id_orden_compra,
              oc.estado_flujo,
              oc.id_archivo_factura_recepcion
            FROM public.orden_compras oc
            LEFT JOIN public.usuarios u ON u.id_usuario = oc.id_usuario
            ${whereSql}
          ),
          order_estimated AS (
            SELECT
              fo.id_orden_compra,
              COALESCE(
                SUM(
                  COALESCE(doc.cantidad_orden, 0) * COALESCE(p.precio, i.precio, 0)
                ),
                0
              )::numeric AS monto_estimado
            FROM filtered_orders fo
            LEFT JOIN public.detalle_orden_compras doc ON doc.id_orden_compra = fo.id_orden_compra
            LEFT JOIN public.productos p ON p.id_producto = doc.id_producto
            LEFT JOIN public.insumos i ON i.id_insumo = doc.id_insumo
            GROUP BY fo.id_orden_compra
          ),
          order_real AS (
            SELECT
              fo.id_orden_compra,
              -- AM: suma total real por OC para contemplar compras multi-proveedor dentro de la misma orden.
              COALESCE(SUM(COALESCE(c.total, 0)), 0)::numeric AS monto_real
            FROM filtered_orders fo
            LEFT JOIN public.compras c ON c.id_orden_compra = fo.id_orden_compra
            GROUP BY fo.id_orden_compra
          )
          SELECT
            COUNT(*)::int AS total_ordenes,
            COUNT(*) FILTER (WHERE UPPER(COALESCE(fo.estado_flujo, '')) = 'PENDIENTE')::int AS pendientes_aprobacion,
            COUNT(*) FILTER (WHERE UPPER(COALESCE(fo.estado_flujo, '')) = 'EN_COMPRA')::int AS en_compra,
            COUNT(*) FILTER (WHERE UPPER(COALESCE(fo.estado_flujo, '')) = 'ABASTECIDA')::int AS abastecidas,
            COUNT(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM public.compras c_ev
                WHERE c_ev.id_orden_compra = fo.id_orden_compra
              )
              AND (
                fo.id_archivo_factura_recepcion IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM public.compras c_ev_p
                  WHERE c_ev_p.id_orden_compra = fo.id_orden_compra
                    AND c_ev_p.id_archivo_transferencia IS NULL
                )
              )
            )::int AS evidencias_pendientes,
            COALESCE(SUM(est.monto_estimado), 0)::numeric AS monto_total_estimado,
            COALESCE(SUM(real.monto_real), 0)::numeric AS monto_total_real
          FROM filtered_orders fo
          LEFT JOIN order_estimated est ON est.id_orden_compra = fo.id_orden_compra
          LEFT JOIN order_real real ON real.id_orden_compra = fo.id_orden_compra
        `,
        params
      );
      const summaryRow = summaryResult.rows?.[0] || {};
      // AM: payload estable para KPIs globales filtrados, manteniendo compatibilidad con data/pagination.
      summary = {
        total_ordenes: Number(summaryRow.total_ordenes || 0),
        pendientes_aprobacion: Number(summaryRow.pendientes_aprobacion || 0),
        en_compra: Number(summaryRow.en_compra || 0),
        abastecidas: Number(summaryRow.abastecidas || 0),
        evidencias_pendientes: Number(summaryRow.evidencias_pendientes || 0),
        // AM: estimado global se calcula por lineas OC usando precio referencia de producto/insumo.
        monto_total_estimado: round2(Number(summaryRow.monto_total_estimado || 0)),
        // AM: real global se calcula como suma de compras por OC filtrada (multi-proveedor compatible).
        monto_total_real: round2(Number(summaryRow.monto_total_real || 0))
      };
    } catch (summaryError) {
      // AM: fallback seguro: si falla summary no debe romper listado/paginacion ni devolver 500.
      console.error(
        '[ordenes_compra_workflow] GET /orden_compras/workflow summary_fallback:',
        buildSafeWorkflowErrorLog(summaryError)
      );
    }
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    params.push(pageSize);
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
        // AM: conserva campos legacy y agrega metadata moderna para frontend de produccion.
        limit: pageSize,
        page_size: pageSize,
        total,
        totalPages,
        total_pages: totalPages,
        has_next: hasNext,
        has_prev: hasPrev
      },
      summary
    });
  } catch (error) {
    return sendServerError(res, 'GET /orden_compras/workflow', error);
  }
});

router.get('/orden_compras/workflow/:id_orden_compra', checkPermission(PERM_OC_VIEW_DETAIL), async (req, res) => {
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
    const comprasPorProveedor = canViewAdminData
      ? await getComprasPorProveedorSummary(
          idOrdenCompra,
          {
            // AM: usa factura de recepcion existente para marcar evidencias pendientes de forma informativa.
            idArchivoFacturaRecepcion: orderRowWithVisibleFlowNumber?.id_archivo_factura_recepcion
          }
        )
      : [];
    const evidenciasHistorial = canViewAdminData ? await getOrderEvidenceHistory(idOrdenCompra) : [];
    const solicitudesItem = await getOrderItemRequests(idOrdenCompra);
    const ordenPayload = canViewAdminData
      ? orderRowWithVisibleFlowNumber
      : sanitizeOrderForOperativeDetail(orderRowWithVisibleFlowNumber);

    return res.status(200).json({
      ok: true,
      data: {
        orden: ordenPayload,
        compra_actual: compraActual || null,
        // AM: nuevo resumen por proveedor para frontend multi-proveedor, sin romper compra_actual legacy.
        compras_por_proveedor: comprasPorProveedor,
        detalles,
        evidencias_historial: evidenciasHistorial,
        solicitudes_item: solicitudesItem
      }
    });
  } catch (error) {
    return sendServerError(res, 'GET /orden_compras/workflow/:id_orden_compra', error);
  }
});

router.get(
  '/orden_compras/workflow/:id_orden_compra/evidencias/factura',
  checkPermission(PERM_OC_VIEW_EVIDENCIAS),
  async (req, res) => {
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

      const idArchivoFactura = parsePositiveInt(orderRow?.id_archivo_factura_recepcion);
      if (!idArchivoFactura) {
        return sendError(res, 404, 'NOT_FOUND', 'La orden no tiene factura de recepcion registrada.');
      }

      const archivoRow = await getArchivoById(idArchivoFactura);
      if (!archivoRow) {
        return sendError(res, 404, 'NOT_FOUND', 'La evidencia de factura no existe o no esta disponible.');
      }

      const access = await resolveEvidenceAccessUrl(req, archivoRow.url_publica);
      if (!access?.url) {
        return sendError(res, 404, 'NOT_FOUND', 'No se pudo resolver la evidencia de factura.');
      }

      return res.status(200).json({
        ok: true,
        data: {
          id_orden_compra: idOrdenCompra,
          tipo_evidencia: 'FACTURA_RECEPCION',
          id_archivo: idArchivoFactura,
          mime_type: String(archivoRow?.tipo_archivo || '').trim().toLowerCase() || null,
          url: access.url,
          is_signed_url: access.signed,
          expires_in: access.expiresIn
        }
      });
    } catch (error) {
      return sendServerError(
        res,
        'GET /orden_compras/workflow/:id_orden_compra/evidencias/factura',
        error
      );
    }
  }
);

router.get(
  '/orden_compras/workflow/:id_orden_compra/evidencias/transferencia',
  checkPermission(PERM_OC_VIEW_EVIDENCIAS),
  async (req, res) => {
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

      const canViewAdminData = await canUserViewAdminOrderData(req, idUsuario);
      if (!canViewAdminData) {
        return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para ver evidencias administrativas.');
      }

      const compraActual = await getLatestCompraByOrden(idOrdenCompra);
      const idArchivoTransferencia = parsePositiveInt(compraActual?.id_archivo_transferencia);
      if (!idArchivoTransferencia) {
        return sendError(res, 404, 'NOT_FOUND', 'La orden no tiene deposito/transferencia registrada.');
      }

      const archivoRow = await getArchivoById(idArchivoTransferencia);
      if (!archivoRow) {
        return sendError(
          res,
          404,
          'NOT_FOUND',
          'La evidencia de deposito/transferencia no existe o no esta disponible.'
        );
      }

      const access = await resolveEvidenceAccessUrl(req, archivoRow.url_publica);
      if (!access?.url) {
        return sendError(res, 404, 'NOT_FOUND', 'No se pudo resolver la evidencia de deposito/transferencia.');
      }

      return res.status(200).json({
        ok: true,
        data: {
          id_orden_compra: idOrdenCompra,
          tipo_evidencia: 'DEPOSITO_TRANSFERENCIA',
          id_archivo: idArchivoTransferencia,
          mime_type: String(archivoRow?.tipo_archivo || '').trim().toLowerCase() || null,
          url: access.url,
          is_signed_url: access.signed,
          expires_in: access.expiresIn
        }
      });
    } catch (error) {
      return sendServerError(
        res,
        'GET /orden_compras/workflow/:id_orden_compra/evidencias/transferencia',
        error
      );
    }
  }
);

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

      const resolvedDetails = await resolvePurchasePresentationDetails(parsedDetails.details, client);
      if (!resolvedDetails.ok) {
        return sendError(res, resolvedDetails.status, resolvedDetails.code, resolvedDetails.message);
      }
      parsedDetails.details = resolvedDetails.details;
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
            id_almacen_destino,
            id_unidad_base,
            id_presentacion_insumo,
            cantidad_presentacion,
            id_unidad_presentacion,
            factor_conversion_usado
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          detail.cantidad_orden,
          idOrdenCompra,
          idInsumo,
          idProducto,
          detail.id_proveedor_sugerido || null,
          detail.id_almacen_destino,
          detail.id_unidad_base || null,
          detail.id_presentacion_insumo || null,
          detail.cantidad_presentacion,
          detail.id_unidad_presentacion || null,
          detail.factor_conversion_usado
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

router.put('/orden_compras/workflow/:id_orden_compra/detalles', checkPermission(PERM_OC_EDIT_REQUEST), async (req, res) => {
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
      if (!idDetalleOrden) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'actualizar requiere id_detalle_orden valido.');
      }
      updates.push({
        id_detalle_orden: idDetalleOrden,
        modo_unidad: hasValue(row?.modo_unidad) ? String(row.modo_unidad).trim().toLowerCase() : null,
        cantidad_raw: row?.cantidad,
        id_presentacion_insumo_raw: row?.id_presentacion_insumo,
        cantidad_presentacion_raw: row?.cantidad_presentacion
      });
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

      const resolvedAdds = await resolvePurchasePresentationDetails(parsedAdds.details, client);
      if (!resolvedAdds.ok) {
        return sendError(res, resolvedAdds.status, resolvedAdds.code, resolvedAdds.message);
      }
      parsedAdds.details = resolvedAdds.details;

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
        SELECT
          id_detalle_orden,
          id_insumo,
          id_producto,
          id_almacen_destino,
          id_proveedor_sugerido,
          id_presentacion_insumo,
          cantidad_presentacion,
          cantidad_orden
        FROM public.detalle_orden_compras
        WHERE id_orden_compra = $1
      `,
      [idOrdenCompra]
    );
    const currentDetailMap = new Map(
      detalleRows.rows.map((row) => [Number(row.id_detalle_orden), row])
    );
    const currentDetailIds = new Set(currentDetailMap.keys());

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

    const updateDetailsForResolution = [];
    for (const row of updates) {
      const currentDetail = currentDetailMap.get(row.id_detalle_orden);
      if (currentDetail?.id_producto) {
        if (
          row.modo_unidad === 'presentacion' ||
          hasValue(row.id_presentacion_insumo_raw) ||
          hasValue(row.cantidad_presentacion_raw)
        ) {
          await withRollback(client);
          return sendError(res, 400, 'VALIDATION_ERROR', 'Los productos no aceptan presentaciones de insumo.');
        }

        const cantidadProducto = parsePositiveInt(row.cantidad_raw);
        if (!cantidadProducto) {
          await withRollback(client);
          return sendError(res, 400, 'VALIDATION_ERROR', 'cantidad de producto debe ser un entero mayor a 0.');
        }

        updateDetailsForResolution.push({
          id_detalle_orden: row.id_detalle_orden,
          item_tipo: 'producto',
          id_item: Number(currentDetail.id_producto),
          id_almacen_destino: parsePositiveInt(currentDetail.id_almacen_destino),
          id_proveedor_sugerido: parsePositiveInt(currentDetail.id_proveedor_sugerido),
          modo_unidad: 'base',
          cantidad: cantidadProducto
        });
        continue;
      }

      const idInsumo = parsePositiveInt(currentDetail?.id_insumo);
      const currentPresentationId = parsePositiveInt(currentDetail?.id_presentacion_insumo);
      const requestedMode = row.modo_unidad || (currentPresentationId ? 'presentacion' : 'base');
      if (!['base', 'presentacion'].includes(requestedMode)) {
        await withRollback(client);
        return sendError(res, 400, 'VALIDATION_ERROR', 'modo_unidad debe ser "base" o "presentacion".');
      }
      if (!row.modo_unidad && currentPresentationId) {
        await withRollback(client);
        return sendError(
          res,
          400,
          'VALIDATION_ERROR',
          'Para actualizar una linea con presentacion debes enviar modo_unidad "presentacion" y cantidad_presentacion, o modo_unidad "base" para cambiarla a unidad base.'
        );
      }

      if (requestedMode === 'presentacion') {
        const idPresentacionInsumo = parsePositiveInt(row.id_presentacion_insumo_raw) || currentPresentationId;
        const cantidadPresentacion = parsePositiveDecimal4(row.cantidad_presentacion_raw);
        if (!idPresentacionInsumo) {
          await withRollback(client);
          return sendError(res, 400, 'VALIDATION_ERROR', 'id_presentacion_insumo debe ser un entero mayor a 0.');
        }
        if (cantidadPresentacion === null) {
          await withRollback(client);
          return sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'cantidad_presentacion debe ser decimal positivo con hasta 4 decimales.'
          );
        }

        updateDetailsForResolution.push({
          id_detalle_orden: row.id_detalle_orden,
          item_tipo: 'insumo',
          id_item: idInsumo,
          id_almacen_destino: parsePositiveInt(currentDetail.id_almacen_destino),
          id_proveedor_sugerido: parsePositiveInt(currentDetail.id_proveedor_sugerido),
          modo_unidad: 'presentacion',
          id_presentacion_insumo: idPresentacionInsumo,
          cantidad_presentacion: cantidadPresentacion
        });
      } else {
        const cantidadInsumo = parsePositiveDecimal4(row.cantidad_raw);
        if (cantidadInsumo === null) {
          await withRollback(client);
          return sendError(
            res,
            400,
            'VALIDATION_ERROR',
            'cantidad de insumo debe ser decimal positivo con hasta 4 decimales.'
          );
        }

        updateDetailsForResolution.push({
          id_detalle_orden: row.id_detalle_orden,
          item_tipo: 'insumo',
          id_item: idInsumo,
          id_almacen_destino: parsePositiveInt(currentDetail.id_almacen_destino),
          id_proveedor_sugerido: parsePositiveInt(currentDetail.id_proveedor_sugerido),
          modo_unidad: 'base',
          cantidad: cantidadInsumo
        });
      }
    }

    if (updateDetailsForResolution.length > 0) {
      const resolvedUpdates = await resolvePurchasePresentationDetails(updateDetailsForResolution, client);
      if (!resolvedUpdates.ok) {
        await withRollback(client);
        return sendError(res, resolvedUpdates.status, resolvedUpdates.code, resolvedUpdates.message);
      }

      for (const detail of resolvedUpdates.details) {
        // AM: actualiza cantidad y snapshot de presentacion antes de aprobar/rechazar la orden.
        await client.query(
          `
            UPDATE public.detalle_orden_compras
            SET cantidad_orden = $1,
                id_unidad_base = $2,
                id_presentacion_insumo = $3,
                cantidad_presentacion = $4,
                id_unidad_presentacion = $5,
                factor_conversion_usado = $6
            WHERE id_detalle_orden = $7
              AND id_orden_compra = $8
          `,
          [
            detail.cantidad_orden,
            detail.id_unidad_base || null,
            detail.id_presentacion_insumo || null,
            detail.cantidad_presentacion,
            detail.id_unidad_presentacion || null,
            detail.factor_conversion_usado,
            detail.id_detalle_orden,
            idOrdenCompra
          ]
        );
      }
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
          SELECT id_detalle_orden, cantidad_orden, cantidad_presentacion
          FROM public.detalle_orden_compras
          WHERE id_orden_compra = $1
            AND (
              ($2::int IS NOT NULL AND id_producto = $2 AND id_insumo IS NULL)
              OR ($3::int IS NOT NULL AND id_insumo = $3 AND id_producto IS NULL)
            )
            AND id_almacen_destino = $4
            AND COALESCE(id_proveedor_sugerido, 0) = COALESCE($5::int, 0)
            AND (
              ($6::bigint IS NULL AND id_presentacion_insumo IS NULL)
              OR ($6::bigint IS NOT NULL AND id_presentacion_insumo = $6)
            )
          LIMIT 1
        `,
        [
          idOrdenCompra,
          idProducto,
          idInsumo,
          detail.id_almacen_destino,
          detail.id_proveedor_sugerido || null,
          detail.id_presentacion_insumo || null
        ]
      );

      if (existingRow.rowCount > 0) {
        const existingDetail = existingRow.rows[0];
        if (detail.modo_unidad === 'presentacion') {
          const totalPresentacion = roundDecimal(
            Number(existingDetail.cantidad_presentacion || 0) + Number(detail.cantidad_presentacion || 0),
            4
          );
          const totalOrden = roundDecimal(totalPresentacion * Number(detail.factor_conversion_usado), 4);

          // AM: evita duplicar lineas; suma presentaciones y recalcula la base canonica con el factor snapshot.
          await client.query(
            `
              UPDATE public.detalle_orden_compras
              SET cantidad_orden = $1,
                  cantidad_presentacion = $2,
                  id_unidad_base = $3,
                  id_unidad_presentacion = $4,
                  factor_conversion_usado = $5
              WHERE id_detalle_orden = $6
                AND id_orden_compra = $7
            `,
            [
              totalOrden,
              totalPresentacion,
              detail.id_unidad_base || null,
              detail.id_unidad_presentacion || null,
              detail.factor_conversion_usado,
              existingDetail.id_detalle_orden,
              idOrdenCompra
            ]
          );
        } else {
          // AM: evita duplicar lineas; suma cantidad base cuando item/proveedor/almacen coinciden.
          await client.query(
            `
              UPDATE public.detalle_orden_compras
              SET cantidad_orden = cantidad_orden + $1,
                  id_unidad_base = COALESCE(id_unidad_base, $2::int)
              WHERE id_detalle_orden = $3
                AND id_orden_compra = $4
            `,
            [
              detail.cantidad_orden,
              detail.id_unidad_base || null,
              existingDetail.id_detalle_orden,
              idOrdenCompra
            ]
          );
        }
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
              id_almacen_destino,
              id_unidad_base,
              id_presentacion_insumo,
              cantidad_presentacion,
              id_unidad_presentacion,
              factor_conversion_usado
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `,
          [
            detail.cantidad_orden,
            idOrdenCompra,
            idInsumo,
            idProducto,
            detail.id_proveedor_sugerido || null,
            detail.id_almacen_destino,
            detail.id_unidad_base || null,
            detail.id_presentacion_insumo || null,
            detail.cantidad_presentacion,
            detail.id_unidad_presentacion || null,
            detail.factor_conversion_usado
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
  checkPermission(PERM_OC_REVIEW_ITEM_REQUEST),
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
  checkPermission(PERM_OC_ATTEND_ITEM_REQUEST),
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

router.post('/orden_compras/workflow/:id_orden_compra/aprobar', checkPermission(PERM_OC_APPROVE), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');
    const roleContext = await getOcRoleContext(req, idUsuario, client);
    if (!roleContext.isFullOcManager) {
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para aprobar órdenes de compra.');
    }

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

router.post('/orden_compras/workflow/:id_orden_compra/rechazar', checkPermission(PERM_OC_REJECT), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');
    const roleContext = await getOcRoleContext(req, idUsuario, client);
    if (!roleContext.isFullOcManager) {
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso para rechazar órdenes de compra.');
    }

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

router.post('/orden_compras/workflow/:id_orden_compra/cancelar', checkPermission(PERM_OC_CANCEL), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');
    const roleContext = await getOcRoleContext(req, idUsuario, client);

    const idOrdenCompra = parsePositiveInt(req.params?.id_orden_compra);
    if (!idOrdenCompra) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'id_orden_compra invalido.');
    }

    await client.query('BEGIN');
    // AM: serializa liberacion de correlativo visible al cancelar para no cruzarse con altas concurrentes.
    await acquireOcVisibleNumberLock(client);

    const orderRow = await getOrderByIdForUpdate(idOrdenCompra, client);
    if (!orderRow) {
      await withRollback(client);
      return sendError(res, 404, 'NOT_FOUND', 'Orden de compra no encontrada.');
    }

    const canView = await validateOrderVisibility(req, idUsuario, orderRow, client);
    if (!canView) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'Solo puedes gestionar solicitudes de tu sucursal.');
    }

    const estadoActual = String(orderRow.estado_flujo || '').trim().toUpperCase();
    const idUsuarioCreador = parsePositiveInt(orderRow?.id_usuario);

    if (roleContext.isFullOcManager) {
      await withRollback(client);
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'Los perfiles administrativos no pueden cancelar ordenes. Usa rechazo con comentario.'
      );
    }

    // AM: operativo solo puede cancelar solicitudes pendientes y propias.
    if (estadoActual !== ESTADO_PENDIENTE) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'Solo puedes cancelar solicitudes pendientes.');
    }
    if (!idUsuarioCreador || Number(idUsuarioCreador) !== Number(idUsuario)) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'Solo puedes cancelar solicitudes creadas por tu usuario.');
    }

    await client.query(
      `
        UPDATE public.orden_compras
        SET
          estado_flujo = $1,
          estado = $2
        WHERE id_orden_compra = $3
      `,
      [ESTADO_CANCELADA, stateToLegacyBoolean(ESTADO_CANCELADA), idOrdenCompra]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Orden cancelada correctamente.',
      data: {
        id_orden_compra: idOrdenCompra,
        estado_flujo: ESTADO_CANCELADA
      }
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow/:id_orden_compra/cancelar', error);
  } finally {
    client.release();
  }
});

router.post('/orden_compras/workflow/:id_orden_compra/convertir', checkPermission(PERM_OC_CONVERT_OR_UPLOAD_DEPOSITO), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');
    const roleContext = await getOcRoleContext(req, idUsuario, client);
    if (!roleContext.isFullOcManager) {
      return sendError(res, 403, 'FORBIDDEN', 'No puedes registrar compra con este perfil.');
    }

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

    // AM: convierte/actualiza compra por proveedor dentro de la misma OC para evitar colision entre grupos.
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
          descuento_valor,
          COALESCE(NULLIF(to_jsonb(compras)->>'observacion_pago', ''), NULL)::text AS observacion_pago
        FROM public.compras
        WHERE id_orden_compra = $1
          AND id_proveedor = $2
        ORDER BY id_compra DESC
        LIMIT 1
        FOR UPDATE
      `,
      [idOrdenCompra, idProveedor]
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

    const orderWarehouseConsistencyResult = await client.query(
      `
        SELECT
          doc.id_detalle_orden,
          doc.id_almacen_destino,
          COALESCE(p.id_almacen, i.id_almacen) AS id_almacen_item
        FROM public.detalle_orden_compras doc
        LEFT JOIN public.productos p ON p.id_producto = doc.id_producto
        LEFT JOIN public.insumos i ON i.id_insumo = doc.id_insumo
        WHERE doc.id_orden_compra = $1
        ORDER BY doc.id_detalle_orden ASC
      `,
      [idOrdenCompra]
    );
    const orderWarehouseRows = orderWarehouseConsistencyResult.rows || [];
    const orderWarehouseIds = Array.from(
      new Set(
        orderWarehouseRows
          .map((detail) => parsePositiveInt(detail.id_almacen_destino) || parsePositiveInt(detail.id_almacen_item))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );
    if (orderWarehouseIds.length === 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden no tiene un almacen operativo valido.');
    }
    const orderWarehouseStateRows = await client.query(
      `
        SELECT id_almacen, id_sucursal, COALESCE(estado, true) AS estado
        FROM public.almacenes
        WHERE id_almacen = ANY($1::int[])
      `,
      [orderWarehouseIds]
    );
    const byWarehouse = new Map();
    for (const row of orderWarehouseStateRows.rows || []) {
      byWarehouse.set(Number(row.id_almacen), row);
    }
    const missingOrderWarehouses = orderWarehouseIds.filter((id) => !byWarehouse.has(id));
    if (missingOrderWarehouses.length > 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden referencia almacenes que no existen.');
    }
    const inactiveOrderWarehouse = Array.from(byWarehouse.values()).find((row) => !Boolean(row.estado));
    if (inactiveOrderWarehouse) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        `El almacen ${inactiveOrderWarehouse.id_almacen} esta inactivo y bloquea la conversion.`
      );
    }
    const sucursalSet = new Set(
      Array.from(byWarehouse.values())
        .map((row) => parsePositiveInt(row.id_sucursal))
        .filter((id) => Number.isInteger(id) && id > 0)
    );
    if (sucursalSet.size > 1) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden mezcla almacenes de distintas sucursales.');
    }
    if (orderWarehouseIds.length > 1) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'La orden mezcla multiples almacenes y no puede convertirse en esta fase.'
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
          doc.id_proveedor_sugerido,
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
          AND doc.id_proveedor_sugerido = $3
        ORDER BY doc.id_detalle_orden ASC
      `,
      [idOrdenCompra, idCompra || null, idProveedor]
    );
    const details = detailsResult.rows || [];
    if (details.length === 0) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'No hay lineas de la orden asociadas al proveedor seleccionado.'
      );
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
      const itemRef = resolveOrderItemReference({
        idProducto: detail.id_producto,
        idInsumo: detail.id_insumo
      });

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

      const warehouseAlignment = validateItemWarehouseAlignment({
        idDetalle: idDetalleOrden,
        itemTipo: itemRef.item_tipo,
        idItem: itemRef.id_item,
        idAlmacenDestino: detail.id_almacen_destino,
        idAlmacenActual: detail.id_almacen_item
      });
      if (!warehouseAlignment.ok) {
        await withRollback(client);
        return sendWarehouseMismatchConflict(res, warehouseAlignment.data);
      }

      const idAlmacenDestino = parsePositiveInt(warehouseAlignment.id_almacen_resuelto);
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
      // AM: crea compra administrativa por proveedor y deja persistidos montos reales para auditoria.
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
      // AM: actualiza metadata y montos administrativos del proveedor sin tocar inventario en esta etapa.
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

    // AM: valida readiness global por proveedor para no marcar lista una OC con grupos pendientes.
    const requiredProvidersResult = await client.query(
      `
        SELECT DISTINCT
          doc.id_proveedor_sugerido AS id_proveedor,
          prov.nombre_proveedor
        FROM public.detalle_orden_compras doc
        LEFT JOIN public.proveedores prov ON prov.id_proveedor = doc.id_proveedor_sugerido
        WHERE doc.id_orden_compra = $1
        ORDER BY doc.id_proveedor_sugerido ASC
      `,
      [idOrdenCompra]
    );
    const requiredProviderMap = new Map();
    let hasInvalidProviderGroup = false;
    for (const row of requiredProvidersResult.rows || []) {
      const providerId = parsePositiveInt(row.id_proveedor);
      if (!providerId) {
        hasInvalidProviderGroup = true;
        continue;
      }
      requiredProviderMap.set(providerId, normalizeText(row.nombre_proveedor, MAX_SHORT_TEXT_LEN));
    }

    const comprasByOrderResult = await client.query(
      `
        SELECT DISTINCT ON (c.id_proveedor)
          c.id_compra,
          c.id_proveedor,
          c.id_archivo_transferencia,
          c.referencia_transferencia,
          COALESCE(NULLIF(to_jsonb(c)->>'observacion_pago', ''), NULL)::text AS observacion_pago
        FROM public.compras c
        WHERE c.id_orden_compra = $1
          AND c.id_proveedor IS NOT NULL
        ORDER BY c.id_proveedor ASC, c.id_compra DESC
      `,
      [idOrdenCompra]
    );
    const latestCompraByProvider = new Map();
    for (const row of comprasByOrderResult.rows || []) {
      const providerId = parsePositiveInt(row.id_proveedor);
      if (!providerId) continue;
      latestCompraByProvider.set(providerId, row);
    }

    const idArchivoFacturaRecepcion = parsePositiveInt(orderRow.id_archivo_factura_recepcion);
    const missingProviderForSupply = [];
    const missingTransferByProvider = [];
    for (const providerId of requiredProviderMap.keys()) {
      const compraProveedor = latestCompraByProvider.get(providerId);
      if (!compraProveedor) {
        missingProviderForSupply.push(providerId);
        continue;
      }
      if (doesCompraRequireTransferEvidence(compraProveedor) && !parsePositiveInt(compraProveedor.id_archivo_transferencia)) {
        missingTransferByProvider.push(providerId);
      }
    }

    // AM: evidencias administrativas en convertir ya no bloquean; se acumulan como advertencias no destructivas.
    const evidenciaWarnings = [];
    if (accion === 'guardar_y_abastecer') {
      if (hasInvalidProviderGroup || missingProviderForSupply.length > 0) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', 'Faltan proveedores por registrar compra.');
      }
      // AM: factura pendiente pasa a warning administrativo para alinear convertir con abastecer.
      if (!idArchivoFacturaRecepcion) {
        evidenciaWarnings.push({
          code: 'OC_FACTURA_PENDIENTE',
          message: 'La orden fue guardada para abastecer, pero no tiene factura adjunta.'
        });
      }
      // AM: comprobante pendiente por proveedor pasa a warning administrativo y no bloquea el flujo.
      if (missingTransferByProvider.length > 0) {
        for (const providerIdMissing of missingTransferByProvider) {
          const missingLabel = getProviderLabel(requiredProviderMap, providerIdMissing);
          evidenciaWarnings.push({
            code: 'OC_COMPROBANTE_PENDIENTE',
            id_proveedor: providerIdMissing,
            proveedor: missingLabel,
            message: `La orden fue guardada para abastecer, pero no tiene comprobante de deposito o transferencia para el proveedor ${missingLabel}.`
          });
        }
      }
    }

    const alreadyProcessed =
      compraActual &&
      Number(compraActual.id_proveedor) === Number(compraActualizada?.id_proveedor) &&
      parsePositiveInt(compraActual.id_archivo_transferencia) === idArchivoTransferenciaFinal &&
      normalizeText(compraActual.referencia_transferencia, MAX_TEXT_LEN) ===
        normalizeText(compraActualizada?.referencia_transferencia, MAX_TEXT_LEN) &&
      round2(Number(compraActual.total || 0)) === round2(Number(compraActualizada?.total || 0));

    // AM: listo para abastecer ahora depende solo de validaciones duras; evidencias quedan como warning administrativo.
    const readyForSupply = !hasInvalidProviderGroup && missingProviderForSupply.length === 0;
    const hasWarnings = accion === 'guardar_y_abastecer' && evidenciaWarnings.length > 0;

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      // AM: mantiene contrato compatible y agrega warning no bloqueante cuando faltan evidencias administrativas.
      warning: hasWarnings,
      warning_code: hasWarnings ? 'OC_EVIDENCIAS_PENDIENTES' : null,
      message:
        accion === 'guardar_y_abastecer'
          ? hasWarnings
            ? 'Datos administrativos guardados. La orden puede abastecerse con evidencias pendientes de revision.'
            : 'Datos administrativos guardados. La orden quedo lista para abastecer.'
          : 'Datos administrativos guardados correctamente.',
      warnings: hasWarnings ? evidenciaWarnings : [],
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
        ready_for_supply: readyForSupply,
        already_processed: Boolean(alreadyProcessed),
        evidencias_pendientes: hasWarnings ? evidenciaWarnings : []
      }
    });
  } catch (error) {
    await withRollback(client);
    return sendServerError(res, 'POST /orden_compras/workflow/:id_orden_compra/convertir', error);
  } finally {
    client.release();
  }
});

router.post('/orden_compras/workflow/:id_orden_compra/recepcion', checkPermission(PERM_OC_RECEIVE_OR_UPLOAD_FACTURA), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = getRequestUserId(req);
    if (!idUsuario) return sendError(res, 401, 'UNAUTHORIZED', 'No autorizado.');
    const roleContext = await getOcRoleContext(req, idUsuario, client);

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

    // AM: recepcion operativa: bloquea actores administrativos y requiere perfil operativo funcional.
    if (roleContext.isFullOcManager) {
      await withRollback(client);
      return sendError(
        res,
        403,
        'FORBIDDEN',
        'La recepcion de sucursal debe ser registrada por un perfil operativo (Cocina/Cajero).'
      );
    }
    if (!roleContext.isOperativeOcActor) {
      await withRollback(client);
      return sendError(res, 403, 'FORBIDDEN', 'No tienes permiso operativo para reportar recepcion.');
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
      const archivoExiste = await validateArchivo(idArchivoFactura, client, {
        expectedMimePrefix: 'image/',
        allowPdf: true
      });
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
    const roleContext = await getOcRoleContext(req, idUsuario, client);
    if (!roleContext.isFullOcManager) {
      return sendError(res, 403, 'FORBIDDEN', 'No puedes abastecer inventario con este perfil.');
    }

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

    // AM: determina lineas requeridas de la OC y obliga proveedor por linea para soportar agrupacion segura.
    const requiredDetailsResult = await client.query(
      `
        SELECT
          doc.id_detalle_orden,
          doc.cantidad_orden,
          doc.id_producto,
          doc.id_insumo,
          doc.id_almacen_destino,
          doc.id_proveedor_sugerido,
          prov.nombre_proveedor,
          p.id_almacen AS id_almacen_producto,
          COALESCE(p.estado, true) AS producto_activo,
          i.id_almacen AS id_almacen_insumo,
          COALESCE(i.estado, true) AS insumo_activo
        FROM public.detalle_orden_compras doc
        LEFT JOIN public.proveedores prov ON prov.id_proveedor = doc.id_proveedor_sugerido
        LEFT JOIN public.productos p ON p.id_producto = doc.id_producto
        LEFT JOIN public.insumos i ON i.id_insumo = doc.id_insumo
        WHERE doc.id_orden_compra = $1
        ORDER BY doc.id_detalle_orden ASC
      `,
      [idOrdenCompra]
    );
    const requiredDetails = requiredDetailsResult.rows || [];
    if (requiredDetails.length === 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden no tiene lineas para abastecer.');
    }

    const requiredQtyByKey = new Map();
    const providerMap = new Map();
    const requiredProviders = new Set();
    const orderWarehouseIds = new Set();

    for (const detail of requiredDetails) {
      const providerId = parsePositiveInt(detail.id_proveedor_sugerido);
      if (!providerId) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', 'Faltan proveedores por registrar compra.');
      }
      requiredProviders.add(providerId);
      providerMap.set(providerId, normalizeText(detail.nombre_proveedor, MAX_SHORT_TEXT_LEN));

      const cantidadOrden = parsePositiveInt(detail.cantidad_orden);
      if (!cantidadOrden) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El detalle ${detail.id_detalle_orden} tiene cantidad invalida para abastecer.`
        );
      }

      const itemRef = resolveOrderItemReference({
        idProducto: detail.id_producto,
        idInsumo: detail.id_insumo
      });
      if (!itemRef.item_tipo || !itemRef.id_item) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El detalle ${detail.id_detalle_orden} no define un item valido para abastecimiento.`
        );
      }

      if (
        itemRef.item_tipo === 'producto' &&
        !(detail.producto_activo === true || detail.producto_activo === 1 || detail.producto_activo === '1')
      ) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', `El producto ${itemRef.id_item} esta inactivo.`);
      }
      if (
        itemRef.item_tipo === 'insumo' &&
        !(detail.insumo_activo === true || detail.insumo_activo === 1 || detail.insumo_activo === '1')
      ) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', `El insumo ${itemRef.id_item} esta inactivo.`);
      }

      const idAlmacenActual =
        itemRef.item_tipo === 'producto' ? detail.id_almacen_producto : detail.id_almacen_insumo;
      const warehouseAlignment = validateItemWarehouseAlignment({
        idDetalle: detail.id_detalle_orden,
        itemTipo: itemRef.item_tipo,
        idItem: itemRef.id_item,
        idAlmacenDestino: detail.id_almacen_destino,
        idAlmacenActual
      });
      if (!warehouseAlignment.ok) {
        await withRollback(client);
        return sendWarehouseMismatchConflict(res, warehouseAlignment.data);
      }

      const idAlmacenDestino = parsePositiveInt(warehouseAlignment.id_almacen_resuelto);
      if (!idAlmacenDestino) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          `El detalle ${detail.id_detalle_orden} no tiene almacen operativo valido.`
        );
      }
      orderWarehouseIds.add(idAlmacenDestino);

      const qtyKey = buildProviderItemKey({
        idProveedor: providerId,
        idProducto: detail.id_producto,
        idInsumo: detail.id_insumo,
        idAlmacenDestino
      });
      const currentQty = Number(requiredQtyByKey.get(qtyKey) || 0);
      requiredQtyByKey.set(qtyKey, currentQty + cantidadOrden);
    }

    const warehouseIds = Array.from(orderWarehouseIds.values());
    const warehouseRowsResult = await client.query(
      `
        SELECT id_almacen, id_sucursal, COALESCE(estado, true) AS estado
        FROM public.almacenes
        WHERE id_almacen = ANY($1::int[])
      `,
      [warehouseIds]
    );
    const warehousesById = new Map();
    for (const row of warehouseRowsResult.rows || []) {
      warehousesById.set(Number(row.id_almacen), row);
    }
    const missingWarehouses = warehouseIds.filter((id) => !warehousesById.has(id));
    if (missingWarehouses.length > 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden referencia almacenes inexistentes.');
    }
    const inactiveWarehouse = Array.from(warehousesById.values()).find((row) => !Boolean(row.estado));
    if (inactiveWarehouse) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        `El almacen ${inactiveWarehouse.id_almacen} esta inactivo y no puede abastecerse.`
      );
    }
    const sucursalSet = new Set(
      Array.from(warehousesById.values())
        .map((row) => parsePositiveInt(row.id_sucursal))
        .filter((id) => Number.isInteger(id) && id > 0)
    );
    if (sucursalSet.size > 1) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'La orden mezcla almacenes de distintas sucursales.');
    }
    if (warehouseIds.length !== 1) {
      await withRollback(client);
      return sendError(
        res,
        409,
        'CONFLICT',
        'La orden mezcla multiples almacenes y no puede abastecerse en esta fase.'
      );
    }
    const idAlmacenOperativo = warehouseIds[0];

    const comprasByProviderResult = await client.query(
      `
        SELECT DISTINCT ON (c.id_proveedor)
          c.id_compra,
          c.id_orden_compra,
          c.id_proveedor,
          c.id_archivo_transferencia,
          c.referencia_transferencia,
          COALESCE(NULLIF(to_jsonb(c)->>'observacion_pago', ''), NULL)::text AS observacion_pago,
          prov.nombre_proveedor
        FROM public.compras c
        LEFT JOIN public.proveedores prov ON prov.id_proveedor = c.id_proveedor
        WHERE c.id_orden_compra = $1
          AND c.id_proveedor IS NOT NULL
        ORDER BY c.id_proveedor ASC, c.id_compra DESC
      `,
      [idOrdenCompra]
    );
    const latestCompraByProvider = new Map();
    for (const row of comprasByProviderResult.rows || []) {
      const providerId = parsePositiveInt(row.id_proveedor);
      if (!providerId) continue;
      latestCompraByProvider.set(providerId, row);
      if (!providerMap.has(providerId)) {
        providerMap.set(providerId, normalizeText(row.nombre_proveedor, MAX_SHORT_TEXT_LEN));
      }
    }

    if (idCompraBody) {
      const selectedCompraExists = (comprasByProviderResult.rows || []).some(
        (row) => parsePositiveInt(row.id_compra) === idCompraBody
      );
      if (!selectedCompraExists) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', 'La compra indicada no pertenece a la orden seleccionada.');
      }
    }

    const missingProviders = Array.from(requiredProviders.values()).filter(
      (providerId) => !latestCompraByProvider.has(providerId)
    );
    if (missingProviders.length > 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'Faltan proveedores por registrar compra.');
    }

    // AM: evidencias pendientes pasan a advertencia administrativa y no bloquean abastecimiento.
    const evidenciaWarnings = [];
    const idArchivoFacturaRecepcion = parsePositiveInt(orderRow.id_archivo_factura_recepcion);
    if (!idArchivoFacturaRecepcion) {
      evidenciaWarnings.push({
        code: 'OC_FACTURA_PENDIENTE',
        message: 'La orden fue abastecida, pero no tiene factura adjunta.'
      });
    }

    for (const providerId of requiredProviders.values()) {
      const compraProveedor = latestCompraByProvider.get(providerId);
      if (doesCompraRequireTransferEvidence(compraProveedor) && !parsePositiveInt(compraProveedor.id_archivo_transferencia)) {
        const providerLabel = getProviderLabel(providerMap, providerId);
        evidenciaWarnings.push({
          code: 'OC_COMPROBANTE_PENDIENTE',
          id_proveedor: providerId,
          proveedor: providerLabel,
          message: `La orden fue abastecida, pero no tiene comprobante de deposito o transferencia para el proveedor ${providerLabel}.`
        });
      }
    }

    const compraIds = Array.from(
      new Set(
        Array.from(latestCompraByProvider.values())
          .map((row) => parsePositiveInt(row.id_compra))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );
    if (compraIds.length === 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'No se encontro una compra asociada para abastecer esta orden.');
    }

    const detalleCompraResult = await client.query(
      `
        SELECT
          dc.id_detalle_compra,
          dc.id_compra,
          c.id_proveedor,
          dc.id_producto,
          dc.id_insumo,
          dc.id_almacen_destino,
          dc.cantidad
        FROM public.detalle_compras dc
        INNER JOIN public.compras c ON c.id_compra = dc.id_compra
        WHERE c.id_orden_compra = $1
          AND dc.id_compra = ANY($2::int[])
        ORDER BY dc.id_compra ASC, dc.id_detalle_compra ASC
      `,
      [idOrdenCompra, compraIds]
    );
    const detalleCompra = detalleCompraResult.rows || [];
    if (detalleCompra.length === 0) {
      await withRollback(client);
      return sendError(res, 409, 'CONFLICT', 'No hay detalles de compra para abastecer inventario.');
    }

    const actualQtyByKey = new Map();
    const movimientos = [];

    for (const row of detalleCompra) {
      const providerId = parsePositiveInt(row.id_proveedor);
      if (!providerId || !requiredProviders.has(providerId)) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', 'Se detectaron detalles de compra fuera de los proveedores de la orden.');
      }

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

      const itemRef = resolveOrderItemReference({
        idProducto: row.id_producto,
        idInsumo: row.id_insumo
      });
      if (!itemRef.item_tipo || !itemRef.id_item) {
        await withRollback(client);
        return sendError(res, 409, 'CONFLICT', `Detalle de compra ${row.id_detalle_compra} no define item.`);
      }

      const idAlmacenDestino = parsePositiveInt(row.id_almacen_destino);
      if (itemRef.item_tipo === 'producto') {
        const productRow = await client.query(
          `
            SELECT id_almacen, COALESCE(estado, true) AS estado
            FROM public.productos
            WHERE id_producto = $1
            LIMIT 1
          `,
          [itemRef.id_item]
        );
        if (productRow.rowCount === 0) {
          await withRollback(client);
          return sendError(res, 409, 'CONFLICT', `Producto ${itemRef.id_item} no existe para abastecer.`);
        }
        if (!Boolean(productRow.rows?.[0]?.estado)) {
          await withRollback(client);
          return sendError(res, 409, 'CONFLICT', `El producto ${itemRef.id_item} esta inactivo.`);
        }

        const warehouseAlignment = validateItemWarehouseAlignment({
          idDetalle: row.id_detalle_compra,
          itemTipo: itemRef.item_tipo,
          idItem: itemRef.id_item,
          idAlmacenDestino,
          idAlmacenActual: productRow.rows?.[0]?.id_almacen
        });
        if (!warehouseAlignment.ok) {
          await withRollback(client);
          return sendWarehouseMismatchConflict(res, warehouseAlignment.data);
        }

        idAlmacen = parsePositiveInt(warehouseAlignment.id_almacen_resuelto);
        idProducto = itemRef.id_item;
      } else {
        const insumoRow = await client.query(
          `
            SELECT id_almacen, COALESCE(estado, true) AS estado
            FROM public.insumos
            WHERE id_insumo = $1
            LIMIT 1
          `,
          [itemRef.id_item]
        );
        if (insumoRow.rowCount === 0) {
          await withRollback(client);
          return sendError(res, 409, 'CONFLICT', `Insumo ${itemRef.id_item} no existe para abastecer.`);
        }
        if (!Boolean(insumoRow.rows?.[0]?.estado)) {
          await withRollback(client);
          return sendError(res, 409, 'CONFLICT', `El insumo ${itemRef.id_item} esta inactivo.`);
        }

        const warehouseAlignment = validateItemWarehouseAlignment({
          idDetalle: row.id_detalle_compra,
          itemTipo: itemRef.item_tipo,
          idItem: itemRef.id_item,
          idAlmacenDestino,
          idAlmacenActual: insumoRow.rows?.[0]?.id_almacen
        });
        if (!warehouseAlignment.ok) {
          await withRollback(client);
          return sendWarehouseMismatchConflict(res, warehouseAlignment.data);
        }

        idAlmacen = parsePositiveInt(warehouseAlignment.id_almacen_resuelto);
        idInsumo = itemRef.id_item;
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
      if (idAlmacen !== idAlmacenOperativo) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          'La orden incluye detalles de compra fuera del almacen operativo de su sucursal.'
        );
      }

      const qtyKey = buildProviderItemKey({
        idProveedor: providerId,
        idProducto: row.id_producto,
        idInsumo: row.id_insumo,
        idAlmacenDestino: idAlmacen
      });
      const actualQty = Number(actualQtyByKey.get(qtyKey) || 0);
      actualQtyByKey.set(qtyKey, actualQty + cantidad);

      movimientos.push({
        id_compra: parsePositiveInt(row.id_compra),
        cantidad,
        id_almacen: idAlmacen,
        id_producto: idProducto,
        id_insumo: idInsumo
      });
    }

    for (const [requiredKey, requiredQty] of requiredQtyByKey.entries()) {
      const actualQty = Number(actualQtyByKey.get(requiredKey) || 0);
      if (actualQty !== Number(requiredQty || 0)) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          'Las cantidades finales de compra no coinciden con las cantidades exactas requeridas en la orden.'
        );
      }
    }

    for (const actualKey of actualQtyByKey.keys()) {
      if (!requiredQtyByKey.has(actualKey)) {
        await withRollback(client);
        return sendError(
          res,
          409,
          'CONFLICT',
          'Se detectaron detalles de compra que no corresponden a las lineas oficiales de la orden.'
        );
      }
    }

    let totalMovimientos = 0;
    const abastecidaConPendientesEvidencia = evidenciaWarnings.length > 0;
    for (const mov of movimientos) {
      // AM: deja trazabilidad operativa en movimientos cuando se abastece con evidencias pendientes.
      const observacionEvidenciaPendiente = abastecidaConPendientesEvidencia
        ? ' - Evidencias pendientes de revision administrativa.'
        : '';
      const descripcion = normalizeText(
        `Abastecimiento OC #${idOrdenCompra} / Compra #${mov.id_compra}${observacionEvidenciaPendiente}${descripcionExtra ? ` - ${descripcionExtra}` : ''}`,
        250
      );

      // AM: abastece inventario una sola vez por OC despues de validar integralmente todos los proveedores.
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
        [mov.cantidad, mov.id_almacen, mov.id_producto, mov.id_insumo, idOrdenCompra, descripcion]
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
    const hasWarnings = evidenciaWarnings.length > 0;
    const warningMessage = 'La orden fue abastecida con evidencias pendientes de revision administrativa.';
    return res.status(200).json({
      ok: true,
      warning: hasWarnings,
      warning_code: hasWarnings ? 'OC_EVIDENCIAS_PENDIENTES' : null,
      message: hasWarnings ? 'Orden abastecida correctamente con evidencias pendientes de revision.' : 'Abastecimiento registrado correctamente.',
      warnings: hasWarnings
        ? [
            ...evidenciaWarnings,
            {
              code: 'OC_EVIDENCIAS_PENDIENTES',
              message: warningMessage
            }
          ]
        : [],
      data: {
        id_orden_compra: idOrdenCompra,
        id_compra: idCompraBody || compraIds[0] || null,
        movimientos_creados: totalMovimientos,
        evidencias_pendientes: hasWarnings ? evidenciaWarnings : []
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
