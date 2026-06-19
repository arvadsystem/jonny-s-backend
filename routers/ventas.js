import express from 'express';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission, requestHasAnyRole } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import { registerFacturaLoyaltyAccumulation } from '../services/fidelizacionService.js';
import { generarCodigoDocumento } from '../services/facturacionCorrelativoService.js';
import {
  aplicarSnapshotEnFactura,
  normalizarDatosTicketDesdeSnapshot,
  obtenerConfigFacturacionParaVenta
} from '../services/facturacionSnapshotService.js';
import { enviarCorreo } from '../utils/emailService.js';
import { getClientIp, parseUserAgent } from '../utils/security/clientInfo.js';
import {
  createVentaReversion,
  listFacturaReversiones
} from '../services/ventasReversionService.js';
import {
  listarAlertasInventarioPedido
} from '../services/inventarioAlertasService.js';
import {
  fetchEstadoPedidoRows,
  resolveEstadoPedidoIdByCode,
  resolveMetodoPagoRegistroPedido,
  resolveSucursalId
} from './ventas/services/catalogLookupService.js';
import {
  fetchClienteInfo,
  fetchVentaCatalogMaps
} from './ventas/services/ventasReadService.js';
import {
  buildKitchenSaleDetailItems,
  fetchCuentaDividida,
  inferKitchenItemQuantity,
  mergeVentaWithFacturacion,
  resolveVentaNumero
} from './ventas/services/ventaDetalleReadService.js';
import {
  buildVentaComplementContext,
  buildVentasStaticCacheKey,
  fetchCachedVentasStaticRows,
  resolveComboComplementMetadata,
  resolveRecetaComplementMetadata
} from './ventas/services/complementosCatalogService.js';
import {
  listCategoriasCatalogoHandler,
  listClientesCatalogoHandler,
  listCombosCatalogoHandler,
  listDescuentosCatalogoHandler,
  listExtrasPermitidosCatalogoHandler,
  listProductosCatalogoHandler,
  listRecetasCatalogoHandler,
  listTipoDepartamentoCatalogoHandler,
  listTiposDescuentoCatalogoHandler
} from './ventas/handlers/catalogosHandlers.js';
import {
  buscarVentaHandler,
  getVentaByIdHandler,
  getVentaTicketPdfByIdHandler,
  getVentaTicketByIdHandler
} from './ventas/handlers/ventasReadHandlers.js';
import {
  buildComplementLineConfig,
  buildComplementSnapshot,
  normalizeCartKey,
  normalizeVentaItems
} from './ventas/services/ventasPayloadService.js';
import {
  buildPedidoPendienteRpcPayload,
  buildVentaRpcPayload,
  buildVentaRpcV2Payload,
  validateVentaMontoCobro,
  VENTA_MONTO_COBRO_INVALIDO_CODE,
  VENTA_MONTO_COBRO_INVALIDO_MESSAGE
} from './ventas/services/ventasRpcPayloadService.js';
import {
  DESCUENTO_ALCANCE_KEYS,
  DESCUENTO_TIPO_KEYS,
  ESTADO_PEDIDO_CODES,
  PEDIDO_ESTADO_PAGO,
  PEDIDO_MENU_PAYMENT_WINDOW_MINUTES,
  PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO,
  PEDIDO_PENDIENTE_CANALES,
  PEDIDO_PENDIENTE_ESTADO_DELIVERY,
  PEDIDO_PENDIENTE_ESTADO_PAGO,
  PEDIDO_PENDIENTE_MODALIDADES,
  REVERSION_ALERT_EMAIL,
  REVERSION_FAILURE_EMAIL_COOLDOWN_MS,
  VENTA_COMPLEMENTO_TIPO_SALSAS,
  VENTA_DIRECTA_LABEL,
  VENTAS_DEFAULT_PAGE,
  VENTAS_DEFAULT_PAGE_SIZE,
  VENTAS_DESCUENTO_APLICAR_PERMISSION,
  VENTAS_DESCUENTOS_PERMISSIONS,
  VENTAS_DESCUENTOS_WRITE_PERMISSIONS,
  VENTAS_FIDELIZACION_ADVISORY_LOCK_CLASS,
  VENTAS_HISTORY_ADMIN_ROLES,
  VENTAS_HISTORY_CAJERO_ROLE,
  VENTAS_LIMIT_72H_CUTOFF_SQL,
  VENTAS_MAX_PAGE_SIZE
} from './ventas/constants.js';
import { roundMoney } from './ventas/utils/moneyUtils.js';
import {
  coercePositiveIntArray,
  isPlainObject,
  normalizeDescuentoAlcance,
  normalizeObservation,
  normalizeRoleName,
  normalizeTextKey,
  normalizeTipoItem,
  parseBooleanInput,
  parseBooleanish,
  parseBoundedPositiveInt,
  parseJsonArrayValue,
  parseNonNegativeNumber,
  parseOptionalDateInput,
  parseOptionalDateTime,
  parseOptionalPositiveInt,
  parsePositiveInt,
  parseRequiredPositiveInt
} from './ventas/utils/parseUtils.js';
import {
  createVentasPerfTracker,
  isPedidoPendienteRpcV1Enabled,
  isVentasPerfEnabled,
  isVentasRpcTransactionEnabled,
  isVentasRpcV2Enabled,
  logVentasPerfRoute,
  logVentasPerfStartupIfEnabled
} from './ventas/utils/perfUtils.js';
import { resolveExtrasInventory } from './ventas/services/extrasInventoryService.js';

const router = express.Router();

setImmediate(logVentasPerfStartupIfEnabled);

const buildBatchPlaceholders = (rowCount, columnCount, castsByColumn = {}) =>
  Array.from({ length: rowCount }, (_, rowIndex) => {
    const placeholders = Array.from({ length: columnCount }, (_, columnIndex) => {
      const paramIndex = rowIndex * columnCount + columnIndex + 1;
      return `$${paramIndex}${castsByColumn[columnIndex] || ''}`;
    });
    return `(${placeholders.join(', ')})`;
  }).join(', ');

const reversionFailureEmailCooldown = new Map();
const schemaColumnCache = new Map();

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
  const key = `table:${String(tableName || '').trim().toLowerCase()}`;
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

const PEDIDO_PENDIENTE_ALLOWED_EXTRAS_SCHEMA_TABLES = Object.freeze([
  'menu_extras',
  'menu_extra_receta',
  'menu_extra_combo'
]);
const PEDIDO_PENDIENTE_ALLOWED_EXTRAS_SCHEMA_MIN_TTL_MS = 5 * 60 * 1000;
const pedidoPendienteAllowedExtrasSchemaCache = new Map();

const getPedidoPendienteAllowedExtrasSchemaCacheTtlMs = () => {
  const ttl = Number(process.env.VENTAS_CATALOG_CACHE_TTL_MS);
  const configuredTtl = Number.isFinite(ttl) && ttl > 0 ? Math.round(ttl) : 30000;
  return Math.max(configuredTtl, PEDIDO_PENDIENTE_ALLOWED_EXTRAS_SCHEMA_MIN_TTL_MS);
};

const clonePedidoPendienteAllowedExtrasSchemaValue = (value) => ({
  hasMenuExtras: Boolean(value?.hasMenuExtras),
  hasMenuExtraReceta: Boolean(value?.hasMenuExtraReceta),
  hasMenuExtraCombo: Boolean(value?.hasMenuExtraCombo)
});

const resolvePedidoPendienteAllowedExtrasSchema = async (client, perf = null) => {
  const startedAt = perf?.now?.() || 0;
  try {
    const cacheKey = 'pedido_pendiente_allowed_extras_schema';
    const now = Date.now();
    const cached = pedidoPendienteAllowedExtrasSchemaCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return clonePedidoPendienteAllowedExtrasSchemaValue(cached.value);
    }
    if (cached) pedidoPendienteAllowedExtrasSchemaCache.delete(cacheKey);

    const result = await client.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
      `,
      [PEDIDO_PENDIENTE_ALLOWED_EXTRAS_SCHEMA_TABLES]
    );
    const existingTables = new Set(result.rows.map((row) => String(row.table_name || '').trim()));
    const value = {
      hasMenuExtras: existingTables.has('menu_extras'),
      hasMenuExtraReceta: existingTables.has('menu_extra_receta'),
      hasMenuExtraCombo: existingTables.has('menu_extra_combo')
    };
    pedidoPendienteAllowedExtrasSchemaCache.set(cacheKey, {
      value,
      expiresAt: now + getPedidoPendienteAllowedExtrasSchemaCacheTtlMs()
    });
    return clonePedidoPendienteAllowedExtrasSchemaValue(value);
  } finally {
    perf?.add?.('pedido_pendiente_allowed_extras_schema_ms', startedAt);
  }
};

const getIdempotencyKey = (req) => {
  const raw = req.headers?.['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const key = String(value || '').trim();
  return key || null;
};

const REVERSION_ALLOWED_ROLES = Object.freeze(['ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN']);

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
};

const buildIdempotencyRequestHash = (body) =>
  createHash('sha256')
    .update(stableStringify(body ?? null))
    .digest('hex');

const reserveVentasIdempotencyKey = async ({
  idempotencyKey,
  operation,
  requestHash,
  idUsuario = null,
  idSucursal = null
}) => {
  if (!idempotencyKey) return { enabled: false };

  try {
    const insertResult = await pool.query(
      `
        INSERT INTO public.ventas_idempotency_keys (
          idempotency_key,
          operation,
          request_hash,
          id_usuario,
          id_sucursal,
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `,
      [
        idempotencyKey,
        operation,
        requestHash,
        parseOptionalPositiveInt(idUsuario) || null,
        parseOptionalPositiveInt(idSucursal) || null
      ]
    );

    if (insertResult.rowCount > 0) {
      return { enabled: true, reserved: true, idempotencyKey, requestHash };
    }

    const existingResult = await pool.query(
      `
        SELECT
          idempotency_key,
          operation,
          request_hash,
          status,
          http_status,
          response_body
        FROM public.ventas_idempotency_keys
        WHERE idempotency_key = $1
        LIMIT 1
      `,
      [idempotencyKey]
    );
    const existing = existingResult.rows?.[0] || null;
    if (!existing) {
      return { enabled: true, conflict: true, code: 'REQUEST_ALREADY_IN_PROGRESS' };
    }

    if (existing.operation !== operation || existing.request_hash !== requestHash) {
      return { enabled: true, conflict: true, code: 'IDEMPOTENCY_KEY_REUSED' };
    }
    if (String(existing.status || '').trim().toUpperCase() === 'SUCCESS') {
      return {
        enabled: true,
        replay: true,
        httpStatus: Number(existing.http_status || 200),
        responseBody: existing.response_body || {}
      };
    }
    if (String(existing.status || '').trim().toUpperCase() === 'IN_PROGRESS') {
      return { enabled: true, conflict: true, code: 'REQUEST_ALREADY_IN_PROGRESS' };
    }

    await pool.query(
      `
        UPDATE public.ventas_idempotency_keys
        SET
          operation = $2,
          id_usuario = COALESCE($3, id_usuario),
          id_sucursal = COALESCE($4, id_sucursal),
          status = 'IN_PROGRESS',
          http_status = NULL,
          response_body = NULL,
          error_code = NULL,
          updated_at = now()
        WHERE idempotency_key = $1
      `,
      [
        idempotencyKey,
        operation,
        parseOptionalPositiveInt(idUsuario) || null,
        parseOptionalPositiveInt(idSucursal) || null
      ]
    );
    return { enabled: true, reserved: true, idempotencyKey, requestHash };
  } catch (err) {
    if (err?.code === '42P01') {
      console.warn('Tabla ventas_idempotency_keys no existe; se omite idempotencia de ventas.');
      return { enabled: false, missingTable: true };
    }
    throw err;
  }
};

const saveVentasIdempotencySuccess = async ({
  reservation,
  httpStatus,
  responseBody,
  idPedido = null,
  idFactura = null,
  idUsuario = null,
  idSucursal = null
}) => {
  if (!reservation?.reserved) return;
  await pool.query(
    `
      UPDATE public.ventas_idempotency_keys
      SET
        status = 'SUCCESS',
        http_status = $2,
        response_body = $3::jsonb,
        id_pedido = COALESCE($4, id_pedido),
        id_factura = COALESCE($5, id_factura),
        id_usuario = COALESCE($6, id_usuario),
        id_sucursal = COALESCE($7, id_sucursal),
        error_code = NULL,
        updated_at = now()
      WHERE idempotency_key = $1
    `,
    [
      reservation.idempotencyKey,
      httpStatus,
      JSON.stringify(responseBody),
      parseOptionalPositiveInt(idPedido) || null,
      parseOptionalPositiveInt(idFactura) || null,
      parseOptionalPositiveInt(idUsuario) || null,
      parseOptionalPositiveInt(idSucursal) || null
    ]
  );
};

const saveVentasIdempotencyFailure = async ({
  reservation,
  httpStatus = null,
  errorCode = null
}) => {
  if (!reservation?.reserved) return;
  await pool.query(
    `
      UPDATE public.ventas_idempotency_keys
      SET
        status = 'FAILED',
        http_status = $2,
        error_code = $3,
        updated_at = now()
      WHERE idempotency_key = $1
    `,
    [
      reservation.idempotencyKey,
      Number.isInteger(httpStatus) ? httpStatus : null,
      errorCode || null
    ]
  );
};
const hasDiscountIntentInPayload = (body) => {
  if (!isPlainObject(body)) return false;

  if (parseOptionalPositiveInt(body.id_descuento_catalogo)) {
    return true;
  }
  if (parseNonNegativeNumber(body.descuento ?? 0) > 0) {
    return true;
  }

  const descuentosLinea = Array.isArray(body.descuentos_linea) ? body.descuentos_linea : [];
  if (descuentosLinea.some((item) => parseOptionalPositiveInt(item?.id_descuento_catalogo))) {
    return true;
  }

  const items = Array.isArray(body.items) ? body.items : [];
  return items.some((item) => {
    if (!isPlainObject(item)) return false;
    if (parseOptionalPositiveInt(item.id_descuento_catalogo)) {
      return true;
    }
    if (parseNonNegativeNumber(item.descuento ?? 0) > 0) {
      return true;
    }
    return false;
  });
};
const sendVentasInternalError = (
  res,
  message = 'No se pudo procesar la solicitud de ventas.'
) => res.status(500).json({ error: true, message });

const normalizeClienteNombre = (cliente) => {
  const nombrePersona = [cliente?.nombre, cliente?.apellido].filter(Boolean).join(' ').trim();
  if (nombrePersona) return nombrePersona;
  if (cliente?.nombre_empresa) return cliente.nombre_empresa;
  return 'Consumidor final';
};

const buildEstadoPedidoSqlKey = (columnExpression) =>
  `LOWER(REGEXP_REPLACE(TRIM(COALESCE(${columnExpression}, '')), '\\s+', '_', 'g'))`;

const getVentaEstadoFilter = (value) => {
  const key = normalizeTextKey(value).toUpperCase();
  const estadoPedidoSqlKey = buildEstadoPedidoSqlKey('ep.descripcion');
  const toAliases = (...codes) =>
    codes.flatMap((code) => [...(ESTADO_PEDIDO_CODES[code] || new Set())]);

  if (!key) return null;

  if (key === 'VENTA_DIRECTA') {
    return { fragment: 'p.id_pedido IS NULL' };
  }

  if (key === 'EN_COCINA') {
    return {
      fragment: `${estadoPedidoSqlKey} = ANY($IDX::text[])`,
      value: toAliases('EN_COCINA', 'EN_PREPARACION')
    };
  }

  if (key === 'LISTO' || key === 'LISTO_PARA_ENTREGA') {
    return {
      fragment: `${estadoPedidoSqlKey} = ANY($IDX::text[])`,
      value: toAliases('LISTO_PARA_ENTREGA')
    };
  }

  if (key === 'COMPLETADA' || key === 'COMPLETADAS' || key === 'COMPLETADO') {
    return {
      fragment: `(p.id_pedido IS NULL OR ${estadoPedidoSqlKey} = ANY($IDX::text[]))`,
      value: toAliases('COMPLETADO')
    };
  }

  if (key === 'PENDIENTE' || key === 'PENDIENTES') {
    return {
      fragment: `${estadoPedidoSqlKey} = ANY($IDX::text[])`,
      value: toAliases('PENDIENTE')
    };
  }

  return null;
};
const getRequestRoleSet = (req) =>
  new Set(
    (Array.isArray(req.user?.roles) ? req.user.roles : [])
      .map(normalizeRoleName)
      .filter(Boolean)
  );

const validateVentasCatalogSucursal = async ({ scope, idSucursal, queryRunner = pool }) => {
  if (!idSucursal) return { ok: true };

  if (scope?.isSuperAdmin) {
    const result = await queryRunner.query(
      `
        SELECT id_sucursal
        FROM public.sucursales
        WHERE id_sucursal = $1
          AND COALESCE(estado, true) = true
        LIMIT 1
      `,
      [idSucursal]
    );
    if (result.rowCount > 0) return { ok: true };
    return {
      ok: false,
      status: 403,
      body: { error: true, message: 'No tiene acceso a la sucursal solicitada.' }
    };
  }

  const allowedSucursalIds = coercePositiveIntArray(scope?.allowedSucursalIds);
  if (allowedSucursalIds.length === 0) {
    return {
      ok: false,
      status: 403,
      body: { error: true, message: 'El empleado no tiene sucursales asignadas.' }
    };
  }
  if (!allowedSucursalIds.includes(idSucursal)) {
    return {
      ok: false,
      status: 403,
      body: { error: true, message: 'No tiene acceso a la sucursal solicitada.' }
    };
  }

  return { ok: true };
};

const resolveVentasAssignedSucursalIds = async ({ idUsuario, fallbackIds, queryRunner }) => {
  const allowedIds = new Set(coercePositiveIntArray(fallbackIds));
  const normalizedUserId = parsePositiveInt(idUsuario);
  if (!normalizedUserId) return [...allowedIds];

  const candidateQueries = [
    {
      sql: `
        SELECT vus.id_sucursal
        FROM public.v_usuarios_sucursales_scope vus
        WHERE vus.id_usuario = $1
          AND COALESCE(vus.estado, true) = true
      `,
      params: [normalizedUserId]
    },
    {
      sql: `
        SELECT es.id_sucursal
        FROM public.usuarios u
        INNER JOIN public.empleados_sucursales es
          ON es.id_empleado = u.id_empleado
        WHERE u.id_usuario = $1
          AND COALESCE(es.estado, true) = true
      `,
      params: [normalizedUserId]
    },
    {
      sql: `
        SELECT us.id_sucursal
        FROM public.usuarios_sucursales us
        WHERE us.id_usuario = $1
      `,
      params: [normalizedUserId]
    },
    {
      sql: `
        SELECT e.id_sucursal
        FROM public.usuarios u
        INNER JOIN public.empleados e
          ON e.id_empleado = u.id_empleado
        WHERE u.id_usuario = $1
          AND e.id_sucursal IS NOT NULL
        LIMIT 1
      `,
      params: [normalizedUserId]
    }
  ];

  for (const candidate of candidateQueries) {
    try {
      const result = await queryRunner.query(candidate.sql, candidate.params);
      if (result.rowCount === 0) continue;
      for (const row of result.rows) {
        const parsedId = parsePositiveInt(row.id_sucursal);
        if (parsedId) allowedIds.add(parsedId);
      }
    } catch (err) {
      if (!['42P01', '42703'].includes(err.code)) {
        console.error('resolveVentasAssignedSucursalIds error:', err);
      }
    }
  }

  return [...allowedIds];
};

const resolveVentasHistoryScope = async (req, queryRunner = pool) => {
  const baseScope = await resolveRequestUserSucursalScope(req, queryRunner);
  const roleSet = getRequestRoleSet(req);
  const isSuperAdmin = Boolean(baseScope.isSuperAdmin);
  const isAdminHistoryRole = [...roleSet].some((role) =>
    VENTAS_HISTORY_ADMIN_ROLES.has(role)
  );
  const isCajero = roleSet.has(VENTAS_HISTORY_CAJERO_ROLE);
  const limitedToLast72Hours = !isSuperAdmin && !isAdminHistoryRole;

  let allowedSucursalIds = [];
  if (isSuperAdmin) {
    const result = await queryRunner.query(
      `
        SELECT id_sucursal
        FROM public.sucursales
        WHERE COALESCE(estado, true) = true
        ORDER BY id_sucursal
      `
    );
    allowedSucursalIds = result.rows
      .map((row) => parseOptionalPositiveInt(row.id_sucursal))
      .filter(Boolean);
  } else {
    const empleadoSucursalId = parseOptionalPositiveInt(baseScope.userSucursalId);
    if (empleadoSucursalId) {
      allowedSucursalIds = [empleadoSucursalId];
    }
  }

  return {
    idUsuario: baseScope.idUsuario,
    roles: [...roleSet],
    isSuperAdmin,
    isAdminHistoryRole,
    isCajero,
    limitedToLast72Hours,
    allowedSucursalIds,
    userSucursalId: parseOptionalPositiveInt(baseScope.userSucursalId)
  };
};

const shouldSendReversionFailureEmail = ({ idUsuario, idFactura }) => {
  const key = `${Number(idUsuario || 0)}:${Number(idFactura || 0)}`;
  const now = Date.now();
  const previous = reversionFailureEmailCooldown.get(key) || 0;
  if (now - previous < REVERSION_FAILURE_EMAIL_COOLDOWN_MS) {
    return false;
  }
  reversionFailureEmailCooldown.set(key, now);
  return true;
};

const registerReversionFailureAttempt = async ({
  idFactura,
  idUsuario,
  idSucursal,
  motivo,
  errorCode,
  errorMessagePublic,
  ipOrigen,
  userAgent,
  dispositivo
}) => {
  try {
    await pool.query(
      `
        INSERT INTO public.facturas_reversiones_intentos (
          id_factura,
          id_usuario,
          id_sucursal,
          motivo,
          error_code,
          error_message_publico,
          ip_origen,
          user_agent,
          dispositivo
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        parseOptionalPositiveInt(idFactura),
        parseOptionalPositiveInt(idUsuario),
        parseOptionalPositiveInt(idSucursal),
        String(motivo || '').trim().toUpperCase() || null,
        String(errorCode || 'VENTAS_REVERSION_ERROR').slice(0, 100),
        String(errorMessagePublic || 'No se pudo completar la reversión.').slice(0, 300),
        String(ipOrigen || '-').slice(0, 80),
        String(userAgent || 'Desconocido').slice(0, 500),
        String(dispositivo || 'Desconocido').slice(0, 80)
      ]
    );
  } catch (auditErr) {
    console.error('Error registrando intento fallido de reversión:', auditErr);
  }
};

const sendReversionSuccessEmail = async ({ payload }) => {
  const html = `
    <h2>Reversión registrada</h2>
    <p><strong>Resultado:</strong> EXITOSA</p>
    <p><strong>Código reversión:</strong> ${payload.codigo_reversion}</p>
    <p><strong>Venta:</strong> ${payload.codigo_venta}</p>
    <p><strong>Usuario:</strong> ${payload.usuario || '-'}</p>
    <p><strong>Sucursal:</strong> ${payload.id_sucursal}</p>
    <p><strong>Caja original:</strong> ${payload.id_caja_original || '-'}</p>
    <p><strong>Caja actual:</strong> ${payload.id_caja_actual || '-'}</p>
    <p><strong>Motivo:</strong> ${payload.motivo}</p>
    <p><strong>Tipo:</strong> ${payload.tipo_reversion}</p>
    <p><strong>Monto reversado:</strong> L ${roundMoney(payload.monto_reversado)}</p>
    <p><strong>Fecha operación:</strong> ${payload.fecha_operacion}</p>
    <p><strong>IP:</strong> ${payload.ip_origen}</p>
    <p><strong>User-Agent:</strong> ${payload.user_agent}</p>
  `;
  await enviarCorreo(
    REVERSION_ALERT_EMAIL,
    `Reversión registrada - ${payload.codigo_reversion} / ${payload.codigo_venta}`,
    html,
    { id_usuario: payload.id_usuario, tipo_correo: 'reversion_exito', fromKey: 'ADMON' }
  );
};

const sendReversionFailureEmail = async ({ payload }) => {
  const html = `
    <h2>Intento fallido de reversión</h2>
    <p><strong>Resultado:</strong> FALLIDA</p>
    <p><strong>Venta:</strong> ${payload.codigo_venta || `VTA-${String(payload.id_factura).padStart(5, '0')}`}</p>
    <p><strong>Usuario:</strong> ${payload.usuario || '-'}</p>
    <p><strong>Sucursal:</strong> ${payload.id_sucursal || '-'}</p>
    <p><strong>Motivo solicitado:</strong> ${payload.motivo || '-'}</p>
    <p><strong>Error controlado:</strong> ${payload.error || 'No se pudo completar la reversión.'}</p>
    <p><strong>Fecha/hora:</strong> ${new Date().toISOString()}</p>
    <p><strong>IP:</strong> ${payload.ip_origen || '-'}</p>
    <p><strong>User-Agent:</strong> ${payload.user_agent || '-'}</p>
  `;
  await enviarCorreo(
    REVERSION_ALERT_EMAIL,
    `Intento fallido de reversión - ${payload.codigo_venta || `VTA-${String(payload.id_factura).padStart(5, '0')}`}`,
    html,
    { id_usuario: payload.id_usuario, tipo_correo: 'reversion_fallida', fromKey: 'ADMON' }
  );
};

const buildKitchenDescriptionSummary = (lines, fallbackValue = null) => {
  const summary = (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.requiere_cocina && line?.observacion)
    .map((line) => `${line.nombre_item}: ${line.observacion}`)
    .join(' | ')
    .slice(0, 250);

  if (summary) return summary;

  const fallback =
    typeof fallbackValue === 'string'
      ? fallbackValue.replace(/\s+/g, ' ').trim().slice(0, 250)
      : '';

  return fallback || null;
};

const fetchCreateVentaDetailContext = async (client, { idCliente, idUsuario, idCaja }) => {
  const result = await client.query(
    `
      WITH input AS (
        SELECT $1::int AS id_cliente, $2::int AS id_usuario, $3::int AS id_caja
      )
      SELECT
        COALESCE(
          NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
          emp.nombre_empresa,
          'Consumidor final'
        ) AS cliente_nombre,
        COALESCE(NULLIF(trim(per.rtn), ''), NULLIF(trim(emp.rtn), '')) AS cliente_rtn,
        u.nombre_usuario,
        cj.nombre_caja,
        cj.codigo_caja
      FROM input i
      LEFT JOIN clientes c ON c.id_cliente = i.id_cliente
      LEFT JOIN personas per ON per.id_persona = c.id_persona
      LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
      LEFT JOIN usuarios u ON u.id_usuario = i.id_usuario
      LEFT JOIN cajas cj ON cj.id_caja = i.id_caja
    `,
    [idCliente || null, idUsuario || null, idCaja || null]
  );

  const row = result.rows?.[0] || {};
  return {
    cliente_nombre: row.cliente_nombre || 'Consumidor final',
    cliente_rtn: row.cliente_rtn || null,
    nombre_usuario: row.nombre_usuario || null,
    nombre_caja: row.nombre_caja || null,
    codigo_caja: row.codigo_caja || null
  };
};

const buildCreatedVentaDetailItems = ({ detalleFacturaRows, detalleFacturaRowsInserted }) =>
  buildKitchenSaleDetailItems(
    (Array.isArray(detalleFacturaRows) ? detalleFacturaRows : []).map((entry, index) => {
      const line = entry.line || {};
      const inserted = detalleFacturaRowsInserted?.[index] || {};
      const origenSnapshot = inserted.origen_snapshot || entry.origenSnapshot || {};
      const tipoItem = inserted.tipo_item || entry.tipoItem || normalizeTipoItem(line.kind);

      return {
        id_detalle: Number(inserted.id_detalle_factura || 0) || null,
        id_detalle_factura: Number(inserted.id_detalle_factura || 0) || null,
        id_detalle_pedido: Number(inserted.id_detalle_pedido || entry.pedidoRef?.id_detalle_pedido || 0) || null,
        tipo_item: tipoItem,
        id_producto: Number(inserted.id_producto || line.id_producto || 0) || null,
        id_combo: Number(inserted.id_combo || line.id_combo || 0) || null,
        id_receta: Number(inserted.id_receta || line.id_receta || 0) || null,
        nombre_item: origenSnapshot.nombre_item || line.nombre_item || 'Item de cocina',
        nombre_producto: origenSnapshot.nombre_item || line.nombre_item || 'Item de cocina',
        cantidad: Number(line.cantidad || 0),
        precio_unitario: roundMoney(line.precio_unitario),
        sub_total: roundMoney(line.sub_total),
        subtotal_linea: roundMoney(line.sub_total),
        total_linea: roundMoney(line.total_linea),
        descuento: roundMoney(line.descuento),
        descuento_linea: roundMoney(line.descuento_linea),
        descuento_global: roundMoney(line.descuento_global),
        subtotal_extras: roundMoney(line.subtotal_extras),
        extras: Array.isArray(line.extras_detalle) ? line.extras_detalle : [],
        configuracion_menu: entry.pedidoRef?.configuracion_menu || buildComplementLineConfig(line),
        isv_15_linea: null,
        isv_18_linea: null,
        exento_linea: null,
        exonerado_linea: null,
        observacion: line.observacion || null,
        origen_snapshot: origenSnapshot
      };
    })
  );

const buildCreateVentaDetailResponse = ({
  idFactura,
  idPedido,
  venta,
  correlativoVenta,
  fechaHoraPedido,
  fechaHoraFacturacion,
  facturacion,
  context,
  items,
  fidelizacion,
  cuentaDividida
}) => {
  const numeroVenta = correlativoVenta.codigo;
  const subtotal = roundMoney(venta.subtotal);
  const descuento = roundMoney(venta.descuento);
  const isv = 0;
  const total = roundMoney(venta.total);
  const totalItems = (Array.isArray(items) ? items : []).reduce(
    (acc, item) => acc + (Number(item?.cantidad ?? 0) || 0),
    0
  );
  const facturacionNormalizada = mergeVentaWithFacturacion(
    {
      id_sucursal: venta.id_sucursal,
      facturacion_snapshot: facturacion
    },
    facturacion
  );

  return {
    message: 'Venta creada exitosamente.',
    id_factura: idFactura,
    id_pedido: idPedido,
    numero_venta: numeroVenta,
    codigo_venta: numeroVenta,
    fecha: fechaHoraFacturacion || fechaHoraPedido || null,
    fecha_operacion: correlativoVenta.fecha_operacion,
    fecha_hora_pedido: fechaHoraPedido || fechaHoraFacturacion || null,
    fecha_hora_facturacion: fechaHoraFacturacion || fechaHoraPedido || null,
    id_sucursal: venta.id_sucursal,
    nombre_sucursal: context?.nombre_sucursal || null,
    id_cliente: venta.id_cliente,
    cliente_nombre: context?.cliente_nombre || 'Consumidor final',
    cliente_rtn: context?.cliente_rtn || null,
    id_usuario: venta.id_usuario,
    nombre_usuario: context?.nombre_usuario || null,
    id_caja: venta.id_caja,
    nombre_caja: context?.nombre_caja || null,
    codigo_caja: context?.codigo_caja || null,
    id_sesion_caja: venta.id_sesion_caja,
    metodo_pago: venta.metodo_pago,
    metodo_pago_codigo: venta.metodo_pago_codigo,
    codigo_transaccion: venta.referencia_pago || null,
    referencia: venta.referencia_pago || null,
    efectivo_entregado: venta.efectivo_entregado,
    cambio: venta.cambio,
    sub_total: subtotal,
    subtotal_bruto: roundMoney(venta.subtotal_bruto ?? subtotal + descuento),
    subtotal,
    descuento_total: descuento,
    descuento,
    descuento_lineas: roundMoney(venta.descuento_lineas),
    descuento_global: roundMoney(venta.descuento_global),
    isv,
    impuesto: isv,
    isv_15: 0,
    isv_18: 0,
    total_isv: 0,
    gravado_15: 0,
    gravado_18: 0,
    exento: 0,
    exonerado: null,
    total,
    total_items: totalItems,
    estado_pedido: 'EN_COCINA',
    venta_directa: idPedido === null,
    ticket_ready: true,
    cliente: {
      id_cliente: venta.id_cliente,
      nombre: context?.cliente_nombre || 'Consumidor final',
      rtn: context?.cliente_rtn || null
    },
    caja: {
      id_caja: venta.id_caja,
      nombre_caja: context?.nombre_caja || null,
      codigo_caja: context?.codigo_caja || null,
      id_sesion_caja: venta.id_sesion_caja
    },
    sucursal: {
      id_sucursal: venta.id_sucursal,
      nombre_sucursal: context?.nombre_sucursal || null
    },
    pedido: {
      id_pedido: idPedido,
      descripcion_pedido: venta.descripcion_pedido,
      descripcion_envio: venta.descripcion_envio,
      estado_pedido: 'EN_COCINA'
    },
    pagos: [
      {
        metodo_pago: venta.metodo_pago,
        metodo_pago_codigo: venta.metodo_pago_codigo,
        monto: total,
        referencia: venta.referencia_pago || null
      }
    ],
    items,
    cuenta_dividida: cuentaDividida || null,
    ...facturacionNormalizada,
    fidelizacion: fidelizacion?.created
      ? {
          puntos_acumulados: fidelizacion.points,
          saldo_nuevo: fidelizacion.saldoNuevo
        }
      : null
  };
};

const logVentasFidelizacionAsyncPerf = (payload) => {
  if (!isVentasPerfEnabled()) return;
  console.info('[ventas:perf:fidelizacion_async]', payload);
};

const registerVentaFidelizacionAfterCommit = async ({
  idFactura,
  idPedido = null,
  idCliente = null,
  idSucursal = null,
  idUsuarioEjecutor = null,
  montoFactura = 0
}) => {
  const facturaId = parseOptionalPositiveInt(idFactura);
  const startedAt = performance.now();

  if (!facturaId || !parseOptionalPositiveInt(idCliente) || !parseOptionalPositiveInt(idSucursal)) {
    logVentasFidelizacionAsyncPerf({
      id_factura: facturaId || null,
      post_rpc_fidelizacion_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      created: false,
      reason: 'MISSING_REQUIRED_DATA'
    });
    return;
  }

  let client = null;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      [VENTAS_FIDELIZACION_ADVISORY_LOCK_CLASS, facturaId]
    );

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: facturaId,
      idPedido,
      idCliente,
      idSucursal,
      idUsuarioEjecutor,
      montoFactura
    });

    await client.query('COMMIT');
    transactionStarted = false;

    logVentasFidelizacionAsyncPerf({
      id_factura: facturaId,
      post_rpc_fidelizacion_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      created: Boolean(result?.created),
      reason: result?.reason || null
    });
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // La venta ya fue confirmada; este rollback solo protege el trabajo diferido.
      }
    }
    console.error('[ventas:fidelizacion_async] error:', {
      id_factura: facturaId,
      code: err?.code || err?.name || 'FIDELIZACION_ASYNC_ERROR'
    });
  } finally {
    if (client) client.release();
  }
};
const createVentaWithRpcTransaction = async ({ client, venta, perf, requestStartedAt = 0 }) => {
  const rpcTotalStart = perf?.now?.() || 0;

  const correlativoStart = perf?.now?.() || 0;
  const correlativoVenta = await generarCodigoDocumento({
    client,
    idSucursal: venta.id_sucursal,
    tipoDocumento: 'VENTA',
    perf
  });
  perf?.add?.('factura_correlativo_ms', correlativoStart);
  perf?.add?.('factura_ms', correlativoStart);

  const facturaSnapshotStart = perf?.now?.() || 0;
  const facturacionVenta = await obtenerConfigFacturacionParaVenta(client, venta.id_sucursal, {
    perf
  });
  const facturacionNormalizada = await normalizarDatosTicketDesdeSnapshot({
    client,
    factura: {
      id_sucursal: venta.id_sucursal,
      facturacion_snapshot: facturacionVenta.snapshot
    }
  });
  perf?.add?.('factura_snapshot_ms', facturaSnapshotStart);
  perf?.add?.('factura_ms', facturaSnapshotStart);

  const rpcPayloadBuildStart = perf?.now?.() || 0;
  const rpcPayload = buildVentaRpcPayload({
    venta,
    correlativoVenta,
    facturacionVenta,
    facturacionNormalizada
  });
  const amountValidation = validateVentaMontoCobro({ venta, payload: rpcPayload });
  if (!amountValidation.ok) {
    throw {
      httpStatus: amountValidation.status,
      code: amountValidation.code,
      publicMessage: amountValidation.message
    };
  }
  const rpcActor = {
    id_usuario: venta.id_usuario,
    id_sucursal: venta.id_sucursal,
    id_caja: venta.id_caja,
    id_sesion_caja: venta.id_sesion_caja
  };
  perf?.add?.('rpc_payload_build_ms', rpcPayloadBuildStart);
  perf?.add?.('pre_rpc_total_ms', rpcTotalStart);
  if (requestStartedAt) {
    perf?.add?.('node_before_rpc_ms', requestStartedAt);
  }

  const rpcCallStart = perf?.now?.() || 0;
  const rpcResult = await client.query(
    'SELECT public.registrar_venta_pos_v1($1::jsonb, $2::jsonb) AS response',
    [JSON.stringify(rpcPayload), JSON.stringify(rpcActor)]
  );
  perf?.add?.('rpc_call_ms', rpcCallStart);
  const afterRpcStart = perf?.now?.() || 0;

  const postRpcResponseStart = perf?.now?.() || 0;
  const response = rpcResult.rows?.[0]?.response;
  if (!isPlainObject(response) || !response.ticket_ready) {
    throw {
      httpStatus: 500,
      code: 'VENTAS_RPC_RESPONSE_INVALID',
      publicMessage: 'La venta fue procesada por RPC, pero la respuesta del ticket no es valida.'
    };
  }

  const idFactura = parseOptionalPositiveInt(response.id_factura);
  if (!idFactura) {
    throw {
      httpStatus: 500,
      code: 'VENTAS_RPC_FACTURA_INVALIDA',
      publicMessage: 'La venta fue procesada por RPC, pero no devolvio factura valida.'
    };
  }

  const responsePayload = {
    ...response,
    fidelizacion: null
  };
  perf?.add?.('post_rpc_response_ms', postRpcResponseStart);
  perf?.add?.('post_rpc_total_ms', afterRpcStart);
  perf?.add?.('rpc_total_ms', rpcTotalStart);

  return {
    response: responsePayload,
    afterRpcStart,
    fidelizacionJob: {
      idFactura,
      idPedido: parseOptionalPositiveInt(response.id_pedido),
      idCliente: venta.id_cliente,
      idSucursal: venta.id_sucursal,
      idUsuarioEjecutor: venta.id_usuario,
      montoFactura: venta.total
    }
  };
};
const createVentaWithRpcV2Transaction = async ({ client, venta, perf, requestStartedAt = 0 }) => {
  const rpcTotalStart = perf?.now?.() || 0;

  const rpcPayloadBuildStart = perf?.now?.() || 0;
  const rpcPayload = buildVentaRpcV2Payload({ venta });
  const amountValidation = validateVentaMontoCobro({ venta, payload: rpcPayload });
  if (!amountValidation.ok) {
    throw {
      httpStatus: amountValidation.status,
      code: amountValidation.code,
      publicMessage: amountValidation.message
    };
  }
  const rpcActor = {
    id_usuario: venta.id_usuario,
    id_sucursal: venta.id_sucursal,
    id_caja: venta.id_caja,
    id_sesion_caja: venta.id_sesion_caja
  };
  perf?.add?.('rpc_v2_payload_build_ms', rpcPayloadBuildStart);
  perf?.add?.('pre_rpc_total_ms', rpcTotalStart);
  if (requestStartedAt) {
    perf?.add?.('node_before_rpc_ms', requestStartedAt);
  }

  const rpcCallStart = perf?.now?.() || 0;
  const rpcResult = await client.query(
    'SELECT public.registrar_venta_pos_v2($1::jsonb, $2::jsonb) AS response',
    [JSON.stringify(rpcPayload), JSON.stringify(rpcActor)]
  );
  perf?.add?.('rpc_v2_call_ms', rpcCallStart);
  const afterRpcStart = perf?.now?.() || 0;

  const postRpcResponseStart = perf?.now?.() || 0;
  const response = rpcResult.rows?.[0]?.response;
  if (!isPlainObject(response) || response.ticket_ready !== true) {
    throw {
      httpStatus: 500,
      code: 'VENTAS_RPC_V2_RESPONSE_INVALID',
      publicMessage: 'La venta fue procesada por RPC V2, pero la respuesta del ticket no es valida.'
    };
  }

  const idFactura = parseOptionalPositiveInt(response.id_factura);
  if (!idFactura) {
    throw {
      httpStatus: 500,
      code: 'VENTAS_RPC_V2_FACTURA_INVALIDA',
      publicMessage: 'La venta fue procesada por RPC V2, pero no devolvio factura valida.'
    };
  }

  const responsePayload = {
    ...response,
    fidelizacion: null
  };
  perf?.add?.('post_rpc_response_ms', postRpcResponseStart);
  perf?.add?.('post_rpc_total_ms', afterRpcStart);
  perf?.add?.('rpc_v2_total_ms', rpcTotalStart);

  return {
    response: responsePayload,
    afterRpcStart,
    fidelizacionJob: {
      idFactura,
      idPedido: parseOptionalPositiveInt(response.id_pedido),
      idCliente: venta.id_cliente,
      idSucursal: venta.id_sucursal,
      idUsuarioEjecutor: venta.id_usuario,
      montoFactura: venta.total
    }
  };
};

const createPedidoPendienteWithRpcV1Transaction = async ({ client, pedidoPendiente, perf }) => {
  const rpcTotalStart = perf?.now?.() || 0;
  const rpcPayloadBuildStart = perf?.now?.() || 0;
  const rpcPayload = buildPedidoPendienteRpcPayload(pedidoPendiente);
  const rpcActor = {
    id_usuario: pedidoPendiente.id_usuario,
    id_sucursal: pedidoPendiente.id_sucursal,
    id_caja: pedidoPendiente.id_caja,
    id_sesion_caja: pedidoPendiente.id_sesion_caja
  };
  perf?.add?.('pedido_pendiente_rpc_payload_build_ms', rpcPayloadBuildStart);

  const rpcCallStart = perf?.now?.() || 0;
  const rpcResult = await client.query(
    'SELECT public.registrar_pedido_pendiente_pos_v1($1::jsonb, $2::jsonb) AS response',
    [JSON.stringify(rpcPayload), JSON.stringify(rpcActor)]
  );
  perf?.add?.('pedido_pendiente_rpc_call_ms', rpcCallStart);
  perf?.add?.('pedido_pendiente_rpc_total_ms', rpcTotalStart);

  const response = rpcResult.rows?.[0]?.response;
  if (!isPlainObject(response) || !parseOptionalPositiveInt(response.id_pedido)) {
    throw {
      httpStatus: 500,
      code: 'PEDIDO_PENDIENTE_RPC_RESPONSE_INVALID',
      publicMessage: 'El pedido fue procesado por RPC, pero la respuesta no es valida.'
    };
  }

  return response;
};

const getNextTableId = async (client, tableName, idField, lock = true) => {
  if (lock) {
    await client.query(`LOCK TABLE ${tableName} IN EXCLUSIVE MODE`);
  }
  const result = await client.query(
    `SELECT COALESCE(MAX(${idField}), 0)::int + 1 AS next_id FROM ${tableName}`
  );
  return Number(result.rows?.[0]?.next_id ?? 0) || 1;
};

const fetchDiscountCatalogById = async (client, idDescuentoCatalogo) => {
  if (!idDescuentoCatalogo) return null;

  const result = await client.query(
    `
      SELECT
        dc.id_descuento_catalogo,
        dc.nombre_descuento,
        dc.valor_descuento,
        dc.estado,
        dc.alcance,
        dc.id_producto,
        dc.id_receta,
        dc.id_combo,
        dc.id_sucursal,
        dc.fecha_inicio,
        dc.fecha_fin,
        dc.id_tipo_descuento,
        td.nombre_tipo_descuento,
        td.estado AS tipo_estado,
        COALESCE(dcp.productos_ids, ARRAY[]::int[]) AS productos_ids,
        COALESCE(dcr.recetas_ids, ARRAY[]::int[]) AS recetas_ids,
        COALESCE(dcc.combos_ids, ARRAY[]::int[]) AS combos_ids
      FROM descuentos_catalogos dc
      INNER JOIN tipo_descuentos td
        ON td.id_tipo_descuento = dc.id_tipo_descuento
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(DISTINCT rel.id_producto ORDER BY rel.id_producto)::int[] AS productos_ids
        FROM descuentos_catalogos_productos rel
        WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
      ) dcp ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(DISTINCT rel.id_receta ORDER BY rel.id_receta)::int[] AS recetas_ids
        FROM descuentos_catalogos_recetas rel
        WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
      ) dcr ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(DISTINCT rel.id_combo ORDER BY rel.id_combo)::int[] AS combos_ids
        FROM descuentos_catalogos_combos rel
        WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
      ) dcc ON true
      WHERE dc.id_descuento_catalogo = $1
      LIMIT 1
    `,
    [idDescuentoCatalogo]
  );

  return result.rows[0] || null;
};

const resolveDiscountTypeKey = (value) => {
  const normalized = normalizeTextKey(value).toUpperCase();
  if (normalized.includes('PORCENTAJE')) return DESCUENTO_TIPO_KEYS.PORCENTAJE;
  if (normalized.includes('MONTO_FIJO') || normalized.includes('MONTO')) {
    return DESCUENTO_TIPO_KEYS.MONTO_FIJO;
  }
  return null;
};

const fetchDiscountCatalogMapByIds = async (client, ids, { perf = null } = {}) => {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => parseOptionalPositiveInt(id))
    .filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const rows = await fetchCachedVentasStaticRows(
    buildVentasStaticCacheKey('discount_catalogs', uniqueIds),
    async () => {
      const result = await client.query(
        `
          SELECT
            dc.id_descuento_catalogo,
            dc.nombre_descuento,
            dc.valor_descuento,
            dc.estado,
            dc.alcance,
            dc.id_producto,
            dc.id_receta,
            dc.id_combo,
            dc.id_sucursal,
            dc.fecha_inicio,
            dc.fecha_fin,
            dc.id_tipo_descuento,
            td.nombre_tipo_descuento,
            td.estado AS tipo_estado,
            COALESCE(dcp.productos_ids, ARRAY[]::int[]) AS productos_ids,
            COALESCE(dcr.recetas_ids, ARRAY[]::int[]) AS recetas_ids,
            COALESCE(dcc.combos_ids, ARRAY[]::int[]) AS combos_ids
          FROM descuentos_catalogos dc
          INNER JOIN tipo_descuentos td
            ON td.id_tipo_descuento = dc.id_tipo_descuento
          LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(DISTINCT rel.id_producto ORDER BY rel.id_producto)::int[] AS productos_ids
            FROM descuentos_catalogos_productos rel
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
          ) dcp ON true
          LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(DISTINCT rel.id_receta ORDER BY rel.id_receta)::int[] AS recetas_ids
            FROM descuentos_catalogos_recetas rel
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
          ) dcr ON true
          LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(DISTINCT rel.id_combo ORDER BY rel.id_combo)::int[] AS combos_ids
            FROM descuentos_catalogos_combos rel
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
          ) dcc ON true
          WHERE dc.id_descuento_catalogo = ANY($1::int[])
          ORDER BY dc.id_descuento_catalogo ASC
        `,
        [uniqueIds]
      );
      return result.rows;
    },
    perf
  );

  return new Map(rows.map((row) => [Number(row.id_descuento_catalogo), row]));
};
const computeDiscountValue = ({ subtotalBruto, valorDescuento, tipoDescuentoKey }) => {
  const safeSubtotal = roundMoney(Math.max(0, subtotalBruto));
  const safeValor = roundMoney(Math.max(0, Number(valorDescuento || 0)));
  if (safeSubtotal <= 0 || safeValor <= 0) return 0;

  if (tipoDescuentoKey === DESCUENTO_TIPO_KEYS.PORCENTAJE) {
    return roundMoney(Math.min(safeSubtotal, (safeSubtotal * safeValor) / 100));
  }

  return roundMoney(Math.min(safeSubtotal, safeValor));
};

const validateCatalogDiscountAvailability = ({
  discountCatalog,
  idSucursal,
  subtotalObjetivo,
  alcanceEsperado = null,
  line = null
}) => {
  if (!discountCatalog) {
    return { ok: false, status: 400, code: 'VENTAS_DESCUENTO_CATALOGO_NO_EXISTE', message: 'El descuento enviado no existe.' };
  }
  if (!parseBooleanish(discountCatalog.estado)) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_INACTIVO', message: 'El descuento seleccionado esta inactivo.' };
  }
  if (!parseBooleanish(discountCatalog.tipo_estado)) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_INACTIVO', message: 'El tipo de descuento seleccionado esta inactivo.' };
  }

  const alcance = normalizeDescuentoAlcance(discountCatalog.alcance || DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA);
  if (!alcance) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ALCANCE_INVALIDO', message: 'El descuento tiene alcance invalido.' };
  }
  if (alcanceEsperado && alcance !== alcanceEsperado) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ITEM_NO_APLICA', message: 'El descuento no aplica al item seleccionado.' };
  }

  const startsAt = parseOptionalDateTime(discountCatalog.fecha_inicio);
  const endsAt = parseOptionalDateTime(discountCatalog.fecha_fin);
  const now = new Date();
  if (startsAt && now < startsAt) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_VENCIDO', message: 'El descuento aun no esta vigente.' };
  }
  if (endsAt && now > endsAt) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_VENCIDO', message: 'El descuento ya vencio.' };
  }

  const idSucursalDescuento = parseOptionalPositiveInt(discountCatalog.id_sucursal);
  if (idSucursalDescuento && Number(idSucursalDescuento) !== Number(idSucursal)) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_SUCURSAL_NO_VALIDA', message: 'El descuento no aplica para la sucursal de la venta.' };
  }

  const tipoDescuentoKey = resolveDiscountTypeKey(discountCatalog.nombre_tipo_descuento);
  if (!tipoDescuentoKey) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ALCANCE_INVALIDO', message: 'El tipo de descuento seleccionado no es soportado.' };
  }

  const subtotalBase = roundMoney(Math.max(0, Number(subtotalObjetivo || 0)));
  const montoCalculado = computeDiscountValue({
    subtotalBruto: subtotalBase,
    valorDescuento: discountCatalog.valor_descuento,
    tipoDescuentoKey
  });
  if (montoCalculado < 0) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_MONTO_INVALIDO', message: 'El descuento tiene un monto invalido.' };
  }
  if (montoCalculado > subtotalBase) {
    return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_SUPERA_SUBTOTAL', message: 'El descuento supera el subtotal permitido.' };
  }

  if (line) {
    const productosIds = coercePositiveIntArray(discountCatalog.productos_ids);
    const recetasIds = coercePositiveIntArray(discountCatalog.recetas_ids);
    const combosIds = coercePositiveIntArray(discountCatalog.combos_ids);
    if (
      alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO &&
      !(productosIds.length > 0
        ? productosIds.includes(Number(line.id_producto || 0))
        : Number(discountCatalog.id_producto || 0) === Number(line.id_producto || 0))
    ) {
      return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ITEM_NO_APLICA', message: 'El descuento de producto no aplica a esta linea.' };
    }
    if (
      alcance === DESCUENTO_ALCANCE_KEYS.RECETA &&
      !(recetasIds.length > 0
        ? recetasIds.includes(Number(line.id_receta || 0))
        : Number(discountCatalog.id_receta || 0) === Number(line.id_receta || 0))
    ) {
      return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ITEM_NO_APLICA', message: 'El descuento de receta no aplica a esta linea.' };
    }
    if (
      alcance === DESCUENTO_ALCANCE_KEYS.COMBO &&
      !(combosIds.length > 0
        ? combosIds.includes(Number(line.id_combo || 0))
        : Number(discountCatalog.id_combo || 0) === Number(line.id_combo || 0))
    ) {
      return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ITEM_NO_APLICA', message: 'El descuento de combo no aplica a esta linea.' };
    }
  }

  return {
    ok: true,
    alcance,
    tipoDescuentoKey,
    montoCalculado
  };
};

const aggregateProductoQuantities = (normalizedItems) => {
  const totals = new Map();
  for (const item of normalizedItems) {
    if (item.kind !== 'PRODUCTO') continue;
    const key = Number(item.id_producto);
    const prev = totals.get(key) || 0;
    totals.set(key, prev + Number(item.cantidad || 0));
  }
  return totals;
};

const resolveVentaContextForCreate = async (client, req, payload = {}) => {
  const idSucursalTarget = parseOptionalPositiveInt(payload.idSucursalTarget);
  const idEstadoPedidoRequested = parseOptionalPositiveInt(payload.idEstadoPedidoRequested);
  const idCliente = parseOptionalPositiveInt(payload.idCliente);
  const metodoPagoInput = String(payload.metodoPagoInput || '').trim();
  const estadoEnCocinaAliases = [...(ESTADO_PEDIDO_CODES.EN_COCINA || new Set())];

  const result = await client.query(
    `
      WITH input AS (
        SELECT
          $1::int AS id_sucursal_target,
          $2::int AS id_estado_pedido_requested,
          $3::int AS id_cliente,
          $4::text AS metodo_pago_input,
          $5::text[] AS estado_en_cocina_aliases
      ),
      sucursal AS (
        SELECT s.id_sucursal
        FROM sucursales s
        INNER JOIN input i ON i.id_sucursal_target = s.id_sucursal
        WHERE COALESCE(s.estado, true) = true
        LIMIT 1
      ),
      estado_solicitado AS (
        SELECT ep.id_estado_pedido
        FROM estados_pedido ep
        INNER JOIN input i ON i.id_estado_pedido_requested = ep.id_estado_pedido
        WHERE i.id_estado_pedido_requested IS NOT NULL
        LIMIT 1
      ),
      estado_cocina AS (
        SELECT ep.id_estado_pedido
        FROM estados_pedido ep
        CROSS JOIN input i
        WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(ep.descripcion, '')), '\\s+', '_', 'g')) = ANY(i.estado_en_cocina_aliases)
        ORDER BY ep.id_estado_pedido
        LIMIT 1
      ),
      cliente AS (
        SELECT c.id_cliente
        FROM clientes c
        INNER JOIN input i ON i.id_cliente = c.id_cliente
        WHERE i.id_cliente IS NOT NULL
        LIMIT 1
      ),
      metodo AS (
        SELECT
          mp.id_metodo_pago,
          mp.codigo,
          mp.nombre,
          COALESCE(mp.afecta_efectivo, false) AS afecta_efectivo
        FROM cat_metodos_pago mp
        CROSS JOIN input i
        WHERE COALESCE(mp.estado, true) = true
          AND (
            UPPER(TRIM(mp.codigo)) = UPPER(i.metodo_pago_input)
            OR LOWER(TRIM(mp.nombre)) = LOWER(i.metodo_pago_input)
          )
        LIMIT 1
      )
      SELECT
        (SELECT id_sucursal FROM sucursal) AS id_sucursal,
        (SELECT id_estado_pedido FROM estado_solicitado) AS id_estado_pedido_solicitado,
        (SELECT id_estado_pedido FROM estado_cocina) AS id_estado_pedido_cocina,
        (SELECT id_cliente FROM cliente) AS id_cliente,
        (SELECT row_to_json(m) FROM metodo m) AS metodo_pago
    `,
    [
      idSucursalTarget,
      idEstadoPedidoRequested,
      idCliente,
      metodoPagoInput,
      estadoEnCocinaAliases
    ]
  );

  const row = result.rows?.[0] || {};
  return {
    idSucursal: parseOptionalPositiveInt(row.id_sucursal),
    requestedEstadoPedido: parseOptionalPositiveInt(row.id_estado_pedido_solicitado),
    estadoPedidoEnCocina: parseOptionalPositiveInt(row.id_estado_pedido_cocina),
    cliente: idCliente && row.id_cliente ? { id_cliente: parseOptionalPositiveInt(row.id_cliente) } : null,
    metodoPago: row.metodo_pago || null
  };
};
const resolveCajaSession = async ({
  client,
  idSucursal,
  idUsuario,
  idSesionCaja = null,
  isSuperAdmin = false
}) => {
  if (!idSucursal || !idUsuario) {
    return { ok: false, reason: 'MISSING_CONTEXT' };
  }

  const requestedSessionId = parseOptionalPositiveInt(idSesionCaja);
  const params = [idSucursal, idUsuario];
  let requestedFilter = '';

  if (requestedSessionId) {
    params.push(requestedSessionId);
    requestedFilter = `AND cs.id_sesion_caja = $${params.length}`;
  }

  const result = await client.query(
    isSuperAdmin
      ? `
        WITH estado_abierta AS (
          SELECT id_estado_sesion_caja
          FROM cat_cajas_sesiones_estados
          WHERE UPPER(TRIM(codigo)) = 'ABIERTA'
          LIMIT 1
        ),
        session_match AS (
          SELECT
            cs.id_caja,
            cs.id_sesion_caja,
            cs.id_sucursal,
            csp.id_participacion_caja,
            crp.codigo AS rol_participacion,
            NULL::bigint AS id_caja_usuario_autorizado
          FROM estado_abierta ea
          INNER JOIN cajas_sesiones cs
            ON cs.id_estado_sesion_caja = ea.id_estado_sesion_caja
          INNER JOIN cajas c
            ON c.id_caja = cs.id_caja
           AND c.id_sucursal = cs.id_sucursal
           AND COALESCE(c.estado, true) = true
          INNER JOIN cajas_sesiones_participantes csp
            ON csp.id_sesion_caja = cs.id_sesion_caja
           AND csp.id_usuario = $2
           AND COALESCE(csp.activo, true) = true
          INNER JOIN cat_cajas_roles_participacion crp
            ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
          WHERE cs.id_sucursal = $1
            AND UPPER(TRIM(crp.codigo)) IN ('RESPONSABLE', 'AUXILIAR')
            ${requestedFilter}
          ORDER BY cs.id_sesion_caja DESC
          LIMIT 1
        )
        SELECT
          (SELECT id_estado_sesion_caja FROM estado_abierta) AS id_estado_abierta,
          sm.id_caja,
          sm.id_sesion_caja,
          sm.id_sucursal,
          sm.id_participacion_caja,
          sm.rol_participacion,
          sm.id_caja_usuario_autorizado
        FROM (SELECT 1) keep_row
        LEFT JOIN session_match sm ON true
      `
      : `
        WITH estado_abierta AS (
          SELECT id_estado_sesion_caja
          FROM cat_cajas_sesiones_estados
          WHERE UPPER(TRIM(codigo)) = 'ABIERTA'
          LIMIT 1
        ),
        session_match AS (
          SELECT
            cs.id_caja,
            cs.id_sesion_caja,
            cs.id_sucursal,
            csp.id_participacion_caja,
            crp.codigo AS rol_participacion,
            cua.id_caja_usuario_autorizado
          FROM estado_abierta ea
          INNER JOIN cajas_sesiones cs
            ON cs.id_estado_sesion_caja = ea.id_estado_sesion_caja
          INNER JOIN cajas c
            ON c.id_caja = cs.id_caja
           AND c.id_sucursal = cs.id_sucursal
           AND COALESCE(c.estado, true) = true
          INNER JOIN cajas_sesiones_participantes csp
            ON csp.id_sesion_caja = cs.id_sesion_caja
           AND csp.id_usuario = $2
           AND COALESCE(csp.activo, true) = true
          INNER JOIN cat_cajas_roles_participacion crp
            ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
          INNER JOIN cajas_usuarios_autorizados cua
            ON cua.id_caja = cs.id_caja
           AND cua.id_sucursal = cs.id_sucursal
           AND cua.id_usuario = csp.id_usuario
           AND COALESCE(cua.estado, true) = true
           AND (
             (UPPER(TRIM(crp.codigo)) = 'RESPONSABLE' AND COALESCE(cua.puede_responsable, false) = true)
             OR (UPPER(TRIM(crp.codigo)) = 'AUXILIAR' AND COALESCE(cua.puede_auxiliar, false) = true)
           )
          WHERE cs.id_sucursal = $1
            ${requestedFilter}
          ORDER BY cs.id_sesion_caja DESC
          LIMIT 1
        )
        SELECT
          (SELECT id_estado_sesion_caja FROM estado_abierta) AS id_estado_abierta,
          sm.id_caja,
          sm.id_sesion_caja,
          sm.id_sucursal,
          sm.id_participacion_caja,
          sm.rol_participacion,
          sm.id_caja_usuario_autorizado
        FROM (SELECT 1) keep_row
        LEFT JOIN session_match sm ON true
      `,
    params
  );

  const row = result.rows?.[0] || {};
  const idEstadoAbierta = Number(row.id_estado_abierta || 0) || null;
  if (!idEstadoAbierta) {
    return { ok: false, reason: 'OPEN_STATE_NOT_FOUND' };
  }

  if (!row.id_sesion_caja) {
    if (requestedSessionId) {
      const sessionExistsResult = await client.query(
        `
          SELECT
            cs.id_sesion_caja,
            cs.id_sucursal,
            cs.id_estado_sesion_caja,
            COALESCE(c.estado, true) AS caja_activa,
            EXISTS (
              SELECT 1
              FROM cajas_sesiones_participantes csp
              WHERE csp.id_sesion_caja = cs.id_sesion_caja
                AND csp.id_usuario = $2
                AND COALESCE(csp.activo, true) = true
            ) AS has_active_participation
          FROM cajas_sesiones cs
          LEFT JOIN cajas c
            ON c.id_caja = cs.id_caja
           AND c.id_sucursal = cs.id_sucursal
          WHERE cs.id_sesion_caja = $1
          LIMIT 1
        `,
        [requestedSessionId, idUsuario]
      );

      const sessionRow = sessionExistsResult.rows?.[0];
      if (!sessionRow) return { ok: false, reason: 'SESSION_NOT_FOUND' };
      if (Number(sessionRow.id_sucursal || 0) !== Number(idSucursal)) {
        return { ok: false, reason: 'SESSION_SCOPE_MISMATCH' };
      }
      if (Number(sessionRow.id_estado_sesion_caja || 0) !== Number(idEstadoAbierta)) {
        return { ok: false, reason: 'SESSION_NOT_OPEN' };
      }
      if (!Boolean(sessionRow.caja_activa)) {
        return { ok: false, reason: 'CAJA_NOT_ACTIVE' };
      }
      if (!Boolean(sessionRow.has_active_participation)) {
        return { ok: false, reason: 'SESSION_PARTICIPATION_REQUIRED' };
      }
      return { ok: false, reason: 'SESSION_AUTHORIZATION_REQUIRED' };
    }

    return { ok: false, reason: 'NO_ACTIVE_SESSION' };
  }

  return {
    ok: true,
    data: {
      id_caja: row.id_caja,
      id_sesion_caja: row.id_sesion_caja,
      id_sucursal: row.id_sucursal,
      id_participacion_caja: row.id_participacion_caja,
      rol_participacion: row.rol_participacion,
      id_caja_usuario_autorizado: row.id_caja_usuario_autorizado
    }
  };
};
const pedidosColumnCache = new Map();
const hasPedidosColumn = async (client, columnName) => {
  const key = String(columnName || '').trim().toLowerCase();
  if (!key) return false;
  if (pedidosColumnCache.has(key)) return pedidosColumnCache.get(key);

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pedidos'
        AND column_name = $1
      LIMIT 1
    `,
    [key]
  );
  const exists = result.rowCount > 0;
  pedidosColumnCache.set(key, exists);
  return exists;
};

const resolvePedidoTransitionTargetCode = (currentCode, requestedCode) => {
  if (!currentCode) return null;

  if (currentCode === 'PENDIENTE') {
    if (requestedCode === 'EN_COCINA') return 'EN_COCINA';
    return null;
  }

  if (currentCode === 'EN_COCINA') {
    if (requestedCode === 'LISTO_PARA_ENTREGA' || requestedCode === 'EN_PREPARACION') {
      return requestedCode;
    }
    if (requestedCode === 'COMPLETADO' || requestedCode === 'NO_ENTREGADO') return requestedCode;
    return null;
  }

  if (currentCode === 'EN_PREPARACION') {
    if (requestedCode === 'LISTO_PARA_ENTREGA') return 'LISTO_PARA_ENTREGA';
    if (requestedCode === 'COMPLETADO' || requestedCode === 'NO_ENTREGADO') return requestedCode;
    return null;
  }

  if (currentCode === 'LISTO_PARA_ENTREGA') {
    if (requestedCode === 'COMPLETADO') return 'COMPLETADO';
    if (requestedCode === 'NO_ENTREGADO') return 'NO_ENTREGADO';
    return null;
  }

  return null;
};

const isPedidoKdsVencido = (pedido) => {
  const startedAt = pedido?.kds_started_at ? new Date(pedido.kds_started_at) : null;
  const expectedMinutes = Number(pedido?.kds_expected_minutes ?? 0);
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) return false;
  if (!Number.isFinite(expectedMinutes) || expectedMinutes <= 0) return false;
  const expireAtMs = startedAt.getTime() + (expectedMinutes * 60 * 1000);
  return Date.now() >= expireAtMs;
};

const expirePendingPublicOrders = async ({ client, allowedSucursalIds = [] }) => {
  const hasEstadoPago = await hasPedidosColumn(client, 'estado_pago');
  const hasValidacionVence = await hasPedidosColumn(client, 'validacion_pago_vence_at');
  if (!hasEstadoPago || !hasValidacionVence) {
    return { applied: false, expiredCount: 0 };
  }

  const idEstadoPendiente = await resolveEstadoPedidoIdByCode(client, 'PENDIENTE');
  if (!idEstadoPendiente) return { applied: false, expiredCount: 0 };

  const idEstadoCancelado =
    (await resolveEstadoPedidoIdByCode(client, 'CANCELADO')) || idEstadoPendiente;

  const hasCanceladoPorTimeoutAt = await hasPedidosColumn(client, 'cancelado_por_timeout_at');

  const params = [
    idEstadoPendiente,
    PEDIDO_ESTADO_PAGO.PENDIENTE_VALIDACION,
    PEDIDO_ESTADO_PAGO.CANCELADO_TIMEOUT,
    idEstadoCancelado
  ];

  let sucursalClause = '';
  if (Array.isArray(allowedSucursalIds) && allowedSucursalIds.length > 0) {
    params.push(allowedSucursalIds);
    sucursalClause = `AND p.id_sucursal = ANY($${params.length}::int[])`;
  }

  const timeoutSetSql = hasCanceladoPorTimeoutAt
    ? 'cancelado_por_timeout_at = NOW(),'
    : '';

  const updateResult = await client.query(
    `
      UPDATE pedidos p
      SET
        estado_pago = $3,
        id_estado_pedido = $4,
        ${timeoutSetSql}
        fecha_hora_pedido = p.fecha_hora_pedido
      WHERE p.origen_pedido = 'MENU'
        AND p.id_estado_pedido = $1
        AND UPPER(TRIM(COALESCE(p.estado_pago, ''))) = $2
        AND p.validacion_pago_vence_at IS NOT NULL
        AND p.validacion_pago_vence_at <= NOW()
        ${sucursalClause}
      RETURNING p.id_pedido
    `,
    params
  );

  return {
    applied: true,
    expiredCount: updateResult.rowCount
  };
};

const allocateDiscounts = (lineSubtotals, totalDiscount) => {
  if (!totalDiscount || totalDiscount <= 0) {
    return lineSubtotals.map(() => 0);
  }

  const subtotal = roundMoney(lineSubtotals.reduce((sum, value) => sum + value, 0));
  if (subtotal <= 0) {
    return lineSubtotals.map(() => 0);
  }

  let remaining = roundMoney(totalDiscount);

  return lineSubtotals.map((lineSubtotal, index) => {
    if (index === lineSubtotals.length - 1) {
      return remaining;
    }

    const proportional = roundMoney((lineSubtotal / subtotal) * totalDiscount);
    remaining = roundMoney(remaining - proportional);
    return proportional;
  });
};

const buildInvalidComplementResult = ({ item, nombreItem, allowed = [], reason }) => {
  if (process.env.NODE_ENV === 'development' && isVentasPerfEnabled()) {
    console.warn('[ventas:complemento-invalido]', {
      tipo_item: item?.kind || null,
      id_producto: parseOptionalPositiveInt(item?.id_producto),
      id_receta: parseOptionalPositiveInt(item?.id_receta),
      id_combo: parseOptionalPositiveInt(item?.id_combo),
      nombre_item: nombreItem || null,
      complementos_solicitados: Array.isArray(item?.complementos) ? item.complementos : [],
      complementos_permitidos: allowed,
      motivo: reason
    });
  }
  return {
    ok: false,
    status: 400,
    code: 'VENTAS_COMPLEMENTO_INVALIDO',
    message: `Revisa los complementos de ${nombreItem || 'este item'}. Uno o mas ya no estan disponibles para este item.`
  };
};

const resolveLineComplementos = ({ item, receta, combo, context, nombreItem }) => {
  if (item.kind === 'PRODUCTO') {
    if (Array.isArray(item.complementos) && item.complementos.length > 0) {
      return buildInvalidComplementResult({ item, nombreItem, reason: 'PRODUCTO_NO_PERMITE_COMPLEMENTOS' });
    }
    return {
      ok: true,
      metadata: {
        requiere_complementos: false,
        tipo_complemento: null,
        minimo_complementos: 0,
        maximo_complementos: 0,
        complementos_disponibles: []
      },
      selected: []
    };
  }

  let metadata;
  if (item.kind === 'RECETA') {
    metadata = resolveRecetaComplementMetadata({
      receta,
      quantity: item.cantidad,
      allowedSauces: context.saucesByRecipe.get(Number(item.id_receta || 0)) || [],
      rules: context.rulesByRecipe.get(Number(item.id_receta || 0)) || [],
      fallbackSauces: context.fallbackSauces
    });
  } else {
    metadata = resolveComboComplementMetadata({
      combo,
      quantity: item.cantidad,
      components: context.comboComponentsByCombo.get(Number(item.id_combo || 0)) || [],
      saucesByRecipe: context.saucesByRecipe,
      rulesByRecipe: context.rulesByRecipe,
      fallbackSauces: context.fallbackSauces
    });
  }

  const selectedIds = Array.isArray(item.complementos) ? item.complementos : [];
  const allowedMap = new Map(
    (Array.isArray(metadata.complementos_disponibles) ? metadata.complementos_disponibles : [])
      .map((entry) => [Number(entry?.id_complemento || entry?.id_salsa || 0), entry])
      .filter(([id]) => id > 0)
  );

  const selected = [];
  const selectedSet = new Set();
  for (const idRaw of selectedIds) {
    const id = Number(idRaw || 0);
    const found = allowedMap.get(id);
    if (!found || found.disponible === false) {
      return buildInvalidComplementResult({
        item,
        nombreItem,
        allowed: [...allowedMap.keys()],
        reason: !found ? 'COMPLEMENTO_NO_PERMITIDO' : 'COMPLEMENTO_NO_DISPONIBLE'
      });
    }
    if (selectedSet.has(id)) {
      return buildInvalidComplementResult({
        item,
        nombreItem,
        allowed: [...allowedMap.keys()],
        reason: 'COMPLEMENTO_DUPLICADO'
      });
    }
    selectedSet.add(id);
    selected.push({ id_complemento: id, id_salsa: id, nombre: String(found.nombre || 'Salsa').trim() });
  }

  const min = Math.max(0, Number(metadata.minimo_complementos || 0));
  const max = Math.max(min, Number(metadata.maximo_complementos || 0));
  const complementosIncompletos = min > 0 && selected.length < min;
  if (max > 0 && selected.length > max) {
    return { ok: false, message: `No puedes seleccionar mas de ${max} complemento(s) para este item.` };
  }
  if (!metadata.requiere_complementos && allowedMap.size === 0 && selected.length > 0) {
    return buildInvalidComplementResult({
      item,
      nombreItem,
      allowed: [...allowedMap.keys()],
      reason: 'ITEM_NO_PERMITE_COMPLEMENTOS'
    });
  }

  return {
    ok: true,
    metadata: {
      ...metadata,
      complementos_incompletos_autorizados: Boolean(item.complementos_incompletos_autorizados),
      complementos_recomendados: min,
      complementos_seleccionados: selected.length,
      complementos_incompletos: complementosIncompletos
    },
    selected
  };
};

const buildExtraLineKey = (kind, idItem, idExtra) =>
  `${String(kind || '').trim().toUpperCase()}:${Number(idItem || 0)}:${Number(idExtra || 0)}`;

const itemHasRequestedExtras = (item) =>
  Array.isArray(item?.extras) && item.extras.some((extra) => parseOptionalPositiveInt(extra?.id_extra));

const buildAllowedExtrasMap = async (client, { normalizedItems = [], idSucursal = null, perf = null, allowedExtrasSchema = null } = {}) => {
  const recetaIds = [...new Set(
    normalizedItems
      .filter((item) => item.kind === 'RECETA')
      .map((item) => Number(item.id_receta || 0))
      .filter((id) => id > 0)
  )];
  const comboIds = [...new Set(
    normalizedItems
      .filter((item) => item.kind === 'COMBO')
      .map((item) => Number(item.id_combo || 0))
      .filter((id) => id > 0)
  )];

  const needsExtras = normalizedItems.some((item) => itemHasRequestedExtras(item));
  if (!needsExtras) return new Map();
  const requestedExtraIds = [...new Set(
    normalizedItems
      .flatMap((item) => Array.isArray(item.extras) ? item.extras : [])
      .map((extra) => Number(extra?.id_extra || 0))
      .filter((id) => id > 0)
  )];
  if (requestedExtraIds.length === 0) return new Map();
  if (recetaIds.length === 0 && comboIds.length === 0) return new Map();

  const {
    hasMenuExtras,
    hasMenuExtraReceta,
    hasMenuExtraCombo
  } = allowedExtrasSchema || await resolvePedidoPendienteAllowedExtrasSchema(client, perf);
  if (!hasMenuExtras) return new Map();
  if (!hasMenuExtraReceta && !hasMenuExtraCombo) return new Map();

  const params = [recetaIds, comboIds, parseOptionalPositiveInt(idSucursal), requestedExtraIds];
  const allowedItemSqlParts = [];
  if (hasMenuExtraReceta && recetaIds.length > 0) {
    allowedItemSqlParts.push(`
      SELECT
        'RECETA'::text AS tipo,
        mer.id_receta AS id_item,
        mer.id_extra,
        COALESCE(mer.orden, 0) AS orden
      FROM typed_params p
      INNER JOIN public.menu_extra_receta mer
        ON mer.id_receta = ANY(p.receta_ids)
       AND mer.id_extra = ANY(p.extra_ids)
      WHERE COALESCE(mer.estado, true) = true
    `);
  }
  if (hasMenuExtraCombo && comboIds.length > 0) {
    allowedItemSqlParts.push(`
      SELECT
        'COMBO'::text AS tipo,
        mec.id_combo AS id_item,
        mec.id_extra,
        0 AS orden
      FROM typed_params p
      INNER JOIN public.menu_extra_combo mec
        ON mec.id_combo = ANY(p.combo_ids)
       AND mec.id_extra = ANY(p.extra_ids)
      WHERE COALESCE(mec.estado, true) = true
    `);
  }
  if (allowedItemSqlParts.length === 0) return new Map();
  const allowedItemsSql = allowedItemSqlParts.join('\nUNION ALL\n');

  const allowedExtrasQueryStart = perf?.now?.() || 0;
  let rows = [];
  try {
    const result = await client.query(
      `
        WITH typed_params AS (
          SELECT
            $1::int[] AS receta_ids,
            $2::int[] AS combo_ids,
            $3::int AS id_sucursal,
            $4::int[] AS extra_ids
        ),
        allowed_items AS (
          ${allowedItemsSql}
        )
        SELECT
          ai.tipo,
          ai.id_item,
          me.id_extra,
          me.codigo,
          me.nombre,
          me.precio_adicional,
          me.estado,
          me.id_insumo,
          me.cant,
          me.id_unidad_medida
        FROM typed_params p
        INNER JOIN allowed_items ai
          ON true
        INNER JOIN public.menu_extras me
          ON me.id_extra = ai.id_extra
         AND COALESCE(me.estado, true) = true
        ORDER BY ai.tipo, ai.id_item, ai.orden, me.nombre
      `,
      params
    );
    rows = result.rows;
  } finally {
    perf?.add?.('pedido_pendiente_allowed_extras_query_ms', allowedExtrasQueryStart);
  }

  const uniqueExtrasById = new Map();
  for (const row of rows) {
    const idExtra = parseOptionalPositiveInt(row.id_extra);
    if (idExtra && !uniqueExtrasById.has(idExtra)) uniqueExtrasById.set(idExtra, row);
  }
  const resolvedInventoryRows = await resolveExtrasInventory({
    queryRunner: client,
    extras: [...uniqueExtrasById.values()],
    idSucursal,
    mode: 'transactional'
  });
  const inventoryByExtraId = new Map(
    resolvedInventoryRows.map((row) => [Number(row.id_extra), row])
  );

  return new Map(
    rows.map((row) => {
      const inventory = inventoryByExtraId.get(Number(row.id_extra)) || {};
      return [
        buildExtraLineKey(row.tipo, row.id_item, row.id_extra),
        {
          tipo: String(row.tipo || '').trim().toUpperCase(),
          id_item: Number(row.id_item || 0),
          id_extra: Number(row.id_extra || 0),
          codigo: String(row.codigo || '').trim(),
          nombre: String(row.nombre || 'Extra').trim(),
          precio_unitario: roundMoney(row.precio_adicional),
          estado: parseBooleanish(row.estado),
          id_insumo_configurado: parseOptionalPositiveInt(inventory.id_insumo_configurado),
          id_insumo_maestro: parseOptionalPositiveInt(inventory.id_insumo_maestro),
          id_insumo_legacy: parseOptionalPositiveInt(inventory.id_insumo_legacy),
          id_insumo: inventory.usa_catalogo_maestro
            ? parseOptionalPositiveInt(inventory.id_insumo_maestro)
            : parseOptionalPositiveInt(inventory.id_insumo_legacy || inventory.id_insumo_configurado),
          cantidad_insumo: Number(inventory.cantidad_consumo_base || 0),
          id_unidad_medida: parseOptionalPositiveInt(inventory.id_unidad_base),
          stock_disponible: inventory.stock_disponible === null || inventory.stock_disponible === undefined
            ? null
            : Number(inventory.stock_disponible),
          id_almacen: parseOptionalPositiveInt(inventory.id_almacen),
          inventario_configurado: Boolean(inventory.inventario_configurado),
          disponible: Boolean(inventory.disponible),
          motivo_no_disponible: inventory.motivo_no_disponible || null,
          codigo_no_disponible: inventory.codigo_no_disponible || null,
          usa_catalogo_maestro: Boolean(inventory.usa_catalogo_maestro)
        }
      ];
    })
  );
};

const resolveLineExtras = ({ item, allowedExtrasMap }) => {
  const requested = Array.isArray(item.extras) ? item.extras : [];
  if (item.kind === 'PRODUCTO') {
    if (requested.length > 0) return { ok: false, message: 'Los productos no permiten extras.' };
    return { ok: true, selected: [], subtotal: 0 };
  }
  if (!requested.length) return { ok: true, selected: [], subtotal: 0 };

  const idItem = item.kind === 'RECETA' ? item.id_receta : item.id_combo;
  const selected = [];
  let subtotal = 0;

  for (const entry of requested) {
    const extra = allowedExtrasMap.get(buildExtraLineKey(item.kind, idItem, entry.id_extra));
    if (!extra || extra.estado !== true) {
      return { ok: false, message: 'Uno o mas extras seleccionados no son validos para este item.' };
    }
    const cantidad = Number(entry.cantidad || 0);
    if (cantidad > Number(item.cantidad || 0)) {
      return { ok: false, message: 'La cantidad de un extra no puede ser mayor que la cantidad del item.' };
    }
    if (extra.disponible !== true) {
      return {
        ok: false,
        status: 409,
        code: 'VENTAS_EXTRA_INVENTARIO_NO_DISPONIBLE',
        message: `El extra ${extra.nombre} no esta disponible en esta sucursal: ${String(extra.motivo_no_disponible || 'requiere revisar su configuracion de inventario.').toLowerCase()}`
      };
    }
    const controlsInventory = Boolean(extra.id_insumo_configurado);
    const requiredInsumo = controlsInventory ? Number(extra.cantidad_insumo || 0) * cantidad : 0;
    if (controlsInventory && (!extra.inventario_configurado || !extra.id_insumo || !extra.id_almacen || requiredInsumo <= 0)) {
      return {
        ok: false,
        status: 409,
        code: 'VENTAS_EXTRA_INVENTARIO_NO_DISPONIBLE',
        message: `El extra ${extra.nombre} no esta disponible en esta sucursal: requiere revisar su configuracion de inventario.`
      };
    }
    if (controlsInventory && Number(extra.stock_disponible ?? 0) < requiredInsumo) {
      return {
        ok: false,
        status: 409,
        code: 'VENTAS_EXTRA_INVENTARIO_NO_DISPONIBLE',
        message: `No hay existencias suficientes para el extra ${extra.nombre}.`
      };
    }
    const lineSubtotal = roundMoney(extra.precio_unitario * cantidad);
    subtotal = roundMoney(subtotal + lineSubtotal);
    selected.push({
      id_extra: extra.id_extra,
      codigo: extra.codigo,
      nombre: extra.nombre,
      cantidad,
      precio_unitario: extra.precio_unitario,
      subtotal: lineSubtotal,
      id_insumo: controlsInventory ? extra.id_insumo : null,
      cantidad_insumo: controlsInventory ? Number(extra.cantidad_insumo || 0) : null,
      cant: controlsInventory ? Number(extra.cantidad_insumo || 0) : null,
      id_unidad_medida: extra.id_unidad_medida,
      stock_disponible: extra.stock_disponible,
      id_almacen: extra.id_almacen
    });
  }

  return { ok: true, selected, subtotal };
};

const hasVentaExtras = (venta) =>
  (Array.isArray(venta?.all_lines) ? venta.all_lines : []).some(
    (line) => Array.isArray(line?.extras_detalle) && line.extras_detalle.length > 0
  );

const fetchMenuExtrasSnapshotByIds = async (client, ids = []) => {
  const extraIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => parseOptionalPositiveInt(id))
      .filter(Boolean)
  )].sort((a, b) => a - b);
  if (extraIds.length === 0) return new Map();
  if (!(await hasTable(client, 'menu_extras'))) return new Map();

  const result = await client.query(
    `
      SELECT
        id_extra,
        codigo,
        nombre,
        precio_adicional,
        id_insumo,
        cant,
        id_unidad_medida
      FROM public.menu_extras
      WHERE id_extra = ANY($1::int[])
    `,
    [extraIds]
  );

  return new Map(
    result.rows.map((row) => [
      Number(row.id_extra),
      {
        id_extra: Number(row.id_extra),
        codigo: String(row.codigo || '').trim() || null,
        nombre: String(row.nombre || '').trim() || null,
        precio_unitario: roundMoney(row.precio_adicional),
        id_insumo: parseOptionalPositiveInt(row.id_insumo),
        cant: Number(row.cant || 0) > 0 ? Number(row.cant) : null,
        id_unidad_medida: parseOptionalPositiveInt(row.id_unidad_medida)
      }
    ])
  );
};

const insertDetallePedidoExtras = async ({ client, idDetallePedido, extras = [] }) => {
  const detalleId = parseOptionalPositiveInt(idDetallePedido);
  const rows = (Array.isArray(extras) ? extras : []).filter((extra) => parseOptionalPositiveInt(extra?.id_extra) && Number(extra?.cantidad || 0) > 0);
  if (!detalleId || rows.length === 0) return;
  if (!(await hasTable(client, 'detalle_pedido_extras'))) return;

  const rowsNeedingCatalog = rows.filter((extra) => {
    const idInsumo = parseOptionalPositiveInt(extra.id_insumo);
    const hasConsumption = Number(extra.cant ?? extra.cantidad_insumo ?? 0) > 0;
    const hasUnit = Boolean(parseOptionalPositiveInt(extra.id_unidad_medida));
    return !idInsumo || !hasConsumption || !hasUnit || !String(extra.codigo || '').trim() || !String(extra.nombre || '').trim();
  });
  const catalogByExtraId = await fetchMenuExtrasSnapshotByIds(
    client,
    rowsNeedingCatalog.map((extra) => extra.id_extra)
  );

  const values = buildBatchPlaceholders(rows.length, 11);
  const params = [];
  for (const extra of rows) {
    const idExtra = Number(extra.id_extra);
    const catalog = catalogByExtraId.get(idExtra) || null;
    const codigo = String(extra.codigo || catalog?.codigo || '').trim() || null;
    const nombre = String(extra.nombre || catalog?.nombre || 'Extra').trim().slice(0, 120);
    const cantidad = Number(extra.cantidad);
    const precioUnitario = roundMoney(extra.precio_unitario ?? catalog?.precio_unitario);
    const subtotal = roundMoney(extra.subtotal ?? precioUnitario * cantidad);
    const idInsumo = parseOptionalPositiveInt(extra.id_insumo) || parseOptionalPositiveInt(catalog?.id_insumo);
    const cant = idInsumo ? Number(extra.cant ?? extra.cantidad_insumo ?? catalog?.cant ?? 0) || null : null;
    const idUnidadMedida = idInsumo ? parseOptionalPositiveInt(extra.id_unidad_medida) || parseOptionalPositiveInt(catalog?.id_unidad_medida) : null;
    params.push(
      detalleId,
      idExtra,
      codigo,
      nombre,
      cantidad,
      precioUnitario,
      subtotal,
      idInsumo || null,
      cant,
      idUnidadMedida,
      JSON.stringify({
        id_extra: idExtra,
        codigo,
        nombre,
        cantidad,
        precio_unitario: precioUnitario,
        subtotal,
        id_insumo: idInsumo || null,
        cant,
        id_unidad_medida: idUnidadMedida
      })
    );
  }
  await client.query(
    `
      INSERT INTO public.detalle_pedido_extras (
        id_detalle_pedido,
        id_extra,
        codigo_extra_snapshot,
        nombre_extra_snapshot,
        cantidad,
        precio_unitario,
        subtotal,
        id_insumo,
        cant,
        id_unidad_medida,
        origen_snapshot
      )
      VALUES ${values}
      ON CONFLICT (id_detalle_pedido, id_extra)
      DO UPDATE SET
        codigo_extra_snapshot = EXCLUDED.codigo_extra_snapshot,
        nombre_extra_snapshot = EXCLUDED.nombre_extra_snapshot,
        cantidad = EXCLUDED.cantidad,
        precio_unitario = EXCLUDED.precio_unitario,
        subtotal = EXCLUDED.subtotal,
        id_insumo = EXCLUDED.id_insumo,
        cant = EXCLUDED.cant,
        id_unidad_medida = EXCLUDED.id_unidad_medida,
        origen_snapshot = EXCLUDED.origen_snapshot,
        estado = true
    `,
    params
  );
};

const insertDetalleFacturaExtras = async ({ client, idDetalleFactura, idDetallePedido = null, extras = [] }) => {
  const detalleId = parseOptionalPositiveInt(idDetalleFactura);
  const rows = (Array.isArray(extras) ? extras : []).filter((extra) => parseOptionalPositiveInt(extra?.id_extra) && Number(extra?.cantidad || 0) > 0);
  if (!detalleId || rows.length === 0) return;
  if (!(await hasTable(client, 'detalle_factura_extras'))) return;

  const detallePedidoId = parseOptionalPositiveInt(idDetallePedido);
  const pedidoExtraIdsByExtra = new Map();
  if (detallePedidoId && (await hasTable(client, 'detalle_pedido_extras'))) {
    const extraIds = [...new Set(rows.map((extra) => Number(extra.id_extra)).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (extraIds.length > 0) {
      const pedidoExtras = await client.query(
        `
          SELECT id_extra, id_detalle_pedido_extra
          FROM public.detalle_pedido_extras
          WHERE id_detalle_pedido = $1
            AND id_extra = ANY($2::int[])
            AND COALESCE(estado, true) = true
        `,
        [detallePedidoId, extraIds]
      );
      for (const row of pedidoExtras.rows) {
        pedidoExtraIdsByExtra.set(Number(row.id_extra), parseOptionalPositiveInt(row.id_detalle_pedido_extra));
      }
    }
  }

  const values = buildBatchPlaceholders(rows.length, 7);
  const params = [];
  for (const extra of rows) {
    const idExtra = Number(extra.id_extra);
    params.push(
      detalleId,
      parseOptionalPositiveInt(extra.id_detalle_pedido_extra) || pedidoExtraIdsByExtra.get(idExtra) || null,
      idExtra,
      String(extra.nombre || 'Extra').trim().slice(0, 120),
      Number(extra.cantidad),
      roundMoney(extra.precio_unitario),
      roundMoney(extra.subtotal)
    );
  }
  await client.query(
    `
      INSERT INTO public.detalle_factura_extras (
        id_detalle_factura,
        id_detalle_pedido_extra,
        id_extra,
        nombre_extra_snapshot,
        cantidad,
        precio_unitario,
        subtotal
      )
      VALUES ${values}
      ON CONFLICT (id_detalle_factura, id_extra)
      DO UPDATE SET
        id_detalle_pedido_extra = COALESCE(EXCLUDED.id_detalle_pedido_extra, detalle_factura_extras.id_detalle_pedido_extra),
        nombre_extra_snapshot = EXCLUDED.nombre_extra_snapshot,
        cantidad = EXCLUDED.cantidad,
        precio_unitario = EXCLUDED.precio_unitario,
        subtotal = EXCLUDED.subtotal,
        estado = true
    `,
    params
  );
};

const fetchDetallePedidoExtras = async (client, detallePedidoIds = []) => {
  const ids = [...new Set((Array.isArray(detallePedidoIds) ? detallePedidoIds : [])
    .map((id) => parseOptionalPositiveInt(id))
    .filter(Boolean))];
  if (!ids.length || !(await hasTable(client, 'detalle_pedido_extras'))) return new Map();

  const result = await client.query(
    `
      SELECT
        id_detalle_pedido,
        id_detalle_pedido_extra,
        id_extra,
        nombre_extra_snapshot AS nombre,
        cantidad,
        precio_unitario,
        subtotal
      FROM public.detalle_pedido_extras
      WHERE id_detalle_pedido = ANY($1::int[])
        AND COALESCE(estado, true) = true
      ORDER BY id_detalle_pedido, id_detalle_pedido_extra
    `,
    [ids]
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const id = Number(row.id_detalle_pedido);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({
      id_detalle_pedido_extra: parseOptionalPositiveInt(row.id_detalle_pedido_extra),
      id_extra: Number(row.id_extra),
      nombre: row.nombre,
      cantidad: Number(row.cantidad),
      precio_unitario: roundMoney(row.precio_unitario),
      subtotal: roundMoney(row.subtotal)
    });
  }
  return grouped;
};

const hasCuentaDivididaPayload = (body) => Array.isArray(body?.cuenta_dividida);

const buildCuentaDivisionPlan = ({ cuentaDividida, lines, expectedTotal, allowPartial = false }) => {
  if (!Array.isArray(cuentaDividida)) return null;
  if (!cuentaDividida.length) {
    throw {
      httpStatus: 400,
      code: 'CUENTA_DIVIDIDA_VACIA',
      publicMessage: 'cuenta_dividida debe incluir al menos una subcuenta.'
    };
  }

  const normalizedLines = Array.isArray(lines) ? lines : [];
  const lineByCartKey = new Map();
  const lineByDetallePedidoId = new Map();
  normalizedLines.forEach((line, index) => {
    const cartKey = normalizeCartKey(line?.cart_key);
    if (cartKey && !lineByCartKey.has(cartKey)) lineByCartKey.set(cartKey, index);
    const idDetallePedido = parseOptionalPositiveInt(line?.id_detalle_pedido);
    if (idDetallePedido && !lineByDetallePedidoId.has(idDetallePedido)) lineByDetallePedidoId.set(idDetallePedido, index);
  });

  const assigned = new Set();
  const divisions = cuentaDividida.map((division, divisionIndex) => {
    if (!isPlainObject(division)) {
      throw {
        httpStatus: 400,
        code: 'CUENTA_DIVIDIDA_INVALIDA',
        publicMessage: 'Cada subcuenta debe ser un objeto valido.'
      };
    }

    const etiqueta = normalizePedidoText(division.etiqueta, 80) || `Persona ${divisionIndex + 1}`;
    const orden = parsePositiveInt(division.orden) || (divisionIndex + 1);
    const items = Array.isArray(division.items) ? division.items : [];
    if (!items.length) {
      throw {
        httpStatus: 400,
        code: 'CUENTA_DIVIDIDA_SUBCUENTA_VACIA',
        publicMessage: 'No se permiten subcuentas vacias.'
      };
    }

    const itemPlans = items.map((item) => {
      if (!isPlainObject(item)) {
        throw {
          httpStatus: 400,
          code: 'CUENTA_DIVIDIDA_ITEM_INVALIDO',
          publicMessage: 'Cada item de subcuenta debe ser un objeto valido.'
        };
      }

      const explicitIndex = Number.parseInt(String(item.line_index ?? ''), 10);
      const cartKey = normalizeCartKey(item.cart_key);
      const idDetallePedido = parseOptionalPositiveInt(item.id_detalle_pedido);
      const lineIndex = Number.isInteger(explicitIndex) && explicitIndex >= 0
        ? explicitIndex
        : idDetallePedido
          ? lineByDetallePedidoId.get(idDetallePedido)
          : cartKey
            ? lineByCartKey.get(cartKey)
            : null;
      if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= normalizedLines.length) {
        throw {
          httpStatus: 400,
          code: 'CUENTA_DIVIDIDA_ITEM_NO_ENCONTRADO',
          publicMessage: 'Una linea asignada a subcuenta no existe en la venta.'
        };
      }
      if (assigned.has(lineIndex)) {
        throw {
          httpStatus: 400,
          code: 'CUENTA_DIVIDIDA_ITEM_DUPLICADO',
          publicMessage: 'Una linea no puede pertenecer a dos subcuentas.'
        };
      }
      assigned.add(lineIndex);

      const line = normalizedLines[lineIndex];
      return {
        line_index: lineIndex,
        cart_key: cartKey || normalizeCartKey(line?.cart_key),
        line
      };
    });

    const subtotalBase = roundMoney(itemPlans.reduce((sum, item) => sum + Number(item.line?.base_sub_total ?? item.line?.sub_total ?? 0), 0));
    const subtotalExtras = roundMoney(itemPlans.reduce((sum, item) => sum + Number(item.line?.subtotal_extras || 0), 0));
    const descuentoTotal = roundMoney(itemPlans.reduce((sum, item) => sum + Number(item.line?.descuento || 0), 0));
    const isvTotal = 0;
    const total = roundMoney(itemPlans.reduce((sum, item) => sum + Number(item.line?.total_linea || 0), 0));

    return {
      etiqueta,
      orden,
      subtotal_base: subtotalBase,
      subtotal_extras: subtotalExtras,
      descuento_total: descuentoTotal,
      isv_total: isvTotal,
      total,
      items: itemPlans
    };
  });

  if (!allowPartial && assigned.size !== normalizedLines.length) {
    throw {
      httpStatus: 400,
      code: 'CUENTA_DIVIDIDA_LINEAS_INCOMPLETAS',
      publicMessage: 'Todas las lineas deben estar asignadas cuando se divide la cuenta.'
    };
  }

  const totalDivisiones = roundMoney(divisions.reduce((sum, division) => sum + Number(division.total || 0), 0));
  if (!allowPartial && Math.abs(totalDivisiones - roundMoney(expectedTotal)) > 0.05) {
    throw {
      httpStatus: 409,
      code: 'CUENTA_DIVIDIDA_TOTAL_NO_CUADRA',
      publicMessage: 'La suma de subcuentas no coincide con el total.'
    };
  }

  return { divisions, total: totalDivisiones };
};

const normalizeComplementosFromMenuConfig = (configuracionMenu) => {
  const config = isPlainObject(configuracionMenu) ? configuracionMenu : null;
  const selected = Array.isArray(config?.complementos)
    ? config.complementos
    : Array.isArray(config?.componentes?.seleccion)
      ? config.componentes.seleccion
      : [];
  return selected.map((entry) => ({
    id_complemento: Number(entry?.id_complemento || entry?.id_salsa || 0),
    id_salsa: Number(entry?.id_salsa || entry?.id_complemento || 0),
    nombre: String(entry?.nombre || 'Complemento').trim()
  })).filter((entry) => entry.id_complemento > 0);
};

const buildComplementSnapshotFromMenuConfig = (configuracionMenu) => {
  const seleccion = normalizeComplementosFromMenuConfig(configuracionMenu);
  if (seleccion.length === 0) return null;
  return {
    tipo: VENTA_COMPLEMENTO_TIPO_SALSAS,
    seleccion
  };
};

const buildCuentaDivisionItemSnapshot = (line, refs = {}) => ({
  tipo_item: normalizeTipoItem(line?.kind || line?.tipo_item),
  id_producto: parseOptionalPositiveInt(line?.id_producto),
  id_receta: parseOptionalPositiveInt(line?.id_receta),
  id_combo: parseOptionalPositiveInt(line?.id_combo),
  id_detalle_factura: parseOptionalPositiveInt(refs.id_detalle_factura),
  id_detalle_pedido: parseOptionalPositiveInt(refs.id_detalle_pedido),
  nombre_item_snapshot: String(line?.nombre_item || 'Item').trim().slice(0, 160),
  cantidad: Number(line?.cantidad || 0),
  precio_unitario: roundMoney(line?.precio_unitario),
  subtotal_base: roundMoney(line?.base_sub_total ?? line?.sub_total),
  subtotal_extras: roundMoney(line?.subtotal_extras),
  descuento_total: roundMoney(line?.descuento),
  isv_total: 0,
  total_linea: roundMoney(line?.total_linea),
  extras_snapshot: Array.isArray(line?.extras_detalle) ? line.extras_detalle : [],
  complementos_snapshot: Array.isArray(line?.complementos_detalle)
    ? line.complementos_detalle
    : normalizeComplementosFromMenuConfig(line?.configuracion_menu),
  origen_snapshot: {
    cart_key: normalizeCartKey(line?.cart_key),
    nombre_item: line?.nombre_item || null,
    observacion: line?.observacion || null,
    descuento_linea: roundMoney(line?.descuento_linea),
    descuento_global: roundMoney(line?.descuento_global)
  }
});

const persistCuentaDividida = async ({
  client,
  plan,
  idFactura = null,
  idPedido = null,
  lineRefs = [],
  estadoInicial = 'PENDIENTE'
}) => {
  if (!plan?.divisions?.length) return [];

  const persisted = [];
  for (const division of plan.divisions) {
    const isPagada = String(estadoInicial || '').trim().toUpperCase() === 'PAGADA';
    const divisionResult = await client.query(
      `
        INSERT INTO public.ventas_cuenta_divisiones (
          id_factura,
          id_pedido,
          etiqueta,
          orden,
          subtotal_base,
          subtotal_extras,
          descuento_total,
          isv_total,
          total,
          monto_pagado,
          monto_pendiente,
          estado
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id_cuenta_division
      `,
      [
        idFactura || null,
        idPedido || null,
        division.etiqueta,
        division.orden,
        division.subtotal_base,
        division.subtotal_extras,
        division.descuento_total,
        division.isv_total,
        division.total,
        isPagada ? division.total : 0,
        isPagada ? 0 : division.total,
        isPagada ? 'PAGADA' : 'PENDIENTE'
      ]
    );
    const idCuentaDivision = Number(divisionResult.rows?.[0]?.id_cuenta_division || 0);
    const persistedDivision = { ...division, id_cuenta_division: idCuentaDivision };
    persisted.push(persistedDivision);

    const itemValues = [];
    const itemParams = [];
    for (const item of division.items) {
      const refs = lineRefs[item.line_index] || {};
      const snapshot = buildCuentaDivisionItemSnapshot(item.line, refs);
      const offset = itemParams.length;
      itemParams.push(
        idCuentaDivision,
        snapshot.id_detalle_factura,
        snapshot.id_detalle_pedido,
        snapshot.tipo_item,
        snapshot.id_producto,
        snapshot.id_receta,
        snapshot.id_combo,
        snapshot.nombre_item_snapshot,
        snapshot.cantidad,
        snapshot.precio_unitario,
        snapshot.subtotal_base,
        snapshot.subtotal_extras,
        snapshot.descuento_total,
        snapshot.isv_total,
        snapshot.total_linea,
        JSON.stringify(snapshot.extras_snapshot),
        JSON.stringify(snapshot.complementos_snapshot),
        JSON.stringify(snapshot.origen_snapshot)
      );
      itemValues.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}::jsonb, $${offset + 17}::jsonb, $${offset + 18}::jsonb)`);
    }

    if (itemValues.length) {
      await client.query(
        `
          INSERT INTO public.ventas_cuenta_division_items (
            id_cuenta_division,
            id_detalle_factura,
            id_detalle_pedido,
            tipo_item,
            id_producto,
            id_receta,
            id_combo,
            nombre_item_snapshot,
            cantidad,
            precio_unitario,
            subtotal_base,
            subtotal_extras,
            descuento_total,
            isv_total,
            total_linea,
            extras_snapshot,
            complementos_snapshot,
            origen_snapshot
          )
          VALUES ${itemValues.join(', ')}
        `,
        itemParams
      );
    }
  }

  return persisted;
};

const insertCuentaDivisionCobros = async ({
  client,
  idFactura,
  idSesionCaja,
  idCaja,
  idSucursal,
  idUsuario,
  idMetodoPago,
  referencia,
  observacion = null,
  divisions = []
}) => {
  for (const division of Array.isArray(divisions) ? divisions : []) {
    const idCuentaDivision = parseOptionalPositiveInt(division.id_cuenta_division);
    const monto = roundMoney(division.total);
    if (!idCuentaDivision || monto <= 0) continue;
    await client.query(
      `
        INSERT INTO public.facturas_cobros (
          id_factura,
          id_sesion_caja,
          id_caja,
          id_sucursal,
          id_usuario_ejecutor,
          id_metodo_pago,
          monto,
          referencia,
          observacion,
          id_cuenta_division,
          fecha_cobro,
          fecha_creacion
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (NOW() AT TIME ZONE 'America/Tegucigalpa'), (NOW() AT TIME ZONE 'America/Tegucigalpa'))
      `,
      [
        idFactura,
        idSesionCaja,
        idCaja,
        idSucursal,
        idUsuario,
        idMetodoPago,
        monto,
        referencia,
        observacion,
        idCuentaDivision
      ]
    );
  }
};

const hydrateVentaLines = async (client, normalizedItems, perf = null, options = {}) => {
  const validateProductStock = options?.validateProductStock !== false;
  const productoIds = [
    ...new Set(
      normalizedItems
        .filter((item) => item.kind === 'PRODUCTO')
        .map((item) => item.id_producto)
    )
  ];
  const comboIds = [
    ...new Set(
      normalizedItems
        .filter((item) => item.kind === 'COMBO')
        .map((item) => item.id_combo)
    )
  ];
  const recetaIds = [
    ...new Set(
      normalizedItems
        .filter((item) => item.kind === 'RECETA')
        .map((item) => item.id_receta)
    )
  ];

  const catalogosStart = perf?.now?.() || 0;
  const { productoMap, comboMap, recetaMap } = await fetchVentaCatalogMaps(client, {
    productoIds,
    comboIds,
    recetaIds,
    lockProductos: validateProductStock === true,
    idSucursal: options?.idSucursal
  });
  perf?.add?.('totals_catalogos_ms', catalogosStart);
  if (productoIds.length > 0) perf?.add?.('totals_productos_ms', catalogosStart);
  if (comboIds.length > 0) perf?.add?.('totals_combos_ms', catalogosStart);
  if (recetaIds.length > 0) perf?.add?.('totals_recetas_ms', catalogosStart);

  const needsAllowedExtrasSchema = normalizedItems.some((item) =>
    (item.kind === 'RECETA' || item.kind === 'COMBO') && itemHasRequestedExtras(item)
  );
  const allowedExtrasSchema = needsAllowedExtrasSchema
    ? await resolvePedidoPendienteAllowedExtrasSchema(client, perf)
    : null;

  const [complementContext, allowedExtrasMap] = await Promise.all([
    buildVentaComplementContext({
      client,
      normalizedItems,
      perf,
      recetaMap,
      comboMap
    }),
    (async () => {
      const extrasStart = perf?.now?.() || 0;
      try {
        return await buildAllowedExtrasMap(client, {
          normalizedItems,
          idSucursal: options?.idSucursal,
          perf,
          allowedExtrasSchema
        });
      } finally {
        perf?.add?.('totals_extras_ms', extrasStart);
        perf?.add?.('validation_extras_ms', extrasStart);
      }
    })()
  ]);

  const totalsItemsStart = perf?.now?.() || 0;
  if (validateProductStock) {
    const productoQtyById = aggregateProductoQuantities(normalizedItems);
    for (const [idProducto, requestedQty] of productoQtyById.entries()) {
      const producto = productoMap.get(idProducto);
      if (!producto) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Producto no encontrado: ${idProducto}` }
        };
      }

      const availableQty = Number(producto.cantidad ?? 0);
      if (availableQty < requestedQty) {
        return {
          ok: false,
          status: 409,
          body: {
            error: true,
            message: `Stock insuficiente para ${producto.nombre_producto || `producto ${idProducto}`}. Disponible: ${availableQty}, solicitado: ${requestedQty}.`
          }
        };
      }
    }
  }

  const lines = [];
  const subTotals = [];

  for (const item of normalizedItems) {
    if (item.kind === 'PRODUCTO') {
      const producto = productoMap.get(item.id_producto);
      if (!producto) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Producto no encontrado: ${item.id_producto}` }
        };
      }

      if (!parseBooleanish(producto.estado)) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Producto inactivo en la venta: ${item.id_producto}` }
        };
      }

      const precioUnitario = roundMoney(producto.precio);
      if (!Number.isFinite(precioUnitario) || precioUnitario <= 0) {
        return {
          ok: false,
          status: 409,
          body: {
            error: true,
            code: VENTA_MONTO_COBRO_INVALIDO_CODE,
            message: VENTA_MONTO_COBRO_INVALIDO_MESSAGE
          }
        };
      }
      const subTotal = roundMoney(precioUnitario * item.cantidad);
      const idAlmacen = Number(producto.id_almacen ?? 0) || null;
      if (!idAlmacen) {
        return {
          ok: false,
          status: 409,
          body: {
            error: true,
            message: `El producto ${producto.nombre_producto || item.id_producto} no tiene almacen asignado para descontar inventario.`
          }
        };
      }

      const complementosResult = resolveLineComplementos({
        item,
        receta: null,
        combo: null,
        context: complementContext,
        nombreItem: producto.nombre_producto || 'Producto'
      });
      if (!complementosResult.ok) {
        return {
          ok: false,
          status: complementosResult.status || 400,
          body: {
            error: true,
            code: complementosResult.code || undefined,
            message: complementosResult.message
          }
        };
      }
      const extrasResult = resolveLineExtras({ item, allowedExtrasMap });
      if (!extrasResult.ok) {
        return {
          ok: false,
          status: extrasResult.status || 400,
          body: { error: true, code: extrasResult.code || undefined, message: extrasResult.message }
        };
      }
      lines.push({
        kind: 'PRODUCTO',
        cart_key: item.cart_key,
        requiere_cocina: false,
        id_producto: item.id_producto,
        id_combo: null,
        id_receta: null,
        id_descuento_catalogo_linea: item.id_descuento_catalogo_linea ?? null,
        id_almacen: idAlmacen,
        nombre_item: producto.nombre_producto,
        cantidad: item.cantidad,
        precio_unitario: precioUnitario,
        sub_total: subTotal,
        base_sub_total: subTotal,
        subtotal_extras: 0,
        observacion: item.observacion,
        complementos_metadata: complementosResult.metadata,
        complementos_detalle: complementosResult.selected,
        extras_detalle: []
      });
      subTotals.push(subTotal);
      continue;
    }

    if (item.kind === 'COMBO') {
      const combo = comboMap.get(item.id_combo);
      if (!combo) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Combo no encontrado: ${item.id_combo}` }
        };
      }

      if (!parseBooleanish(combo.estado)) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Combo inactivo en la venta: ${item.id_combo}` }
        };
      }

      const precioUnitario = roundMoney(combo.precio);
      const subTotal = roundMoney(precioUnitario * item.cantidad);

      const complementosResult = resolveLineComplementos({
        item,
        receta: null,
        combo,
        context: complementContext,
        nombreItem: combo.descripcion || 'Combo'
      });
      if (!complementosResult.ok) {
        return {
          ok: false,
          status: complementosResult.status || 400,
          body: {
            error: true,
            code: complementosResult.code || undefined,
            message: complementosResult.message
          }
        };
      }
      const extrasResult = resolveLineExtras({ item, allowedExtrasMap });
      if (!extrasResult.ok) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: extrasResult.message }
        };
      }
      lines.push({
        kind: 'COMBO',
        cart_key: item.cart_key,
        requiere_cocina: true,
        id_producto: null,
        id_combo: item.id_combo,
        id_receta: null,
        id_descuento_catalogo_linea: item.id_descuento_catalogo_linea ?? null,
        id_almacen: null,
        nombre_item: combo.descripcion || `Combo #${item.id_combo}`,
        cantidad: item.cantidad,
        precio_unitario: precioUnitario,
        sub_total: subTotal,
        base_sub_total: subTotal,
        subtotal_extras: extrasResult.subtotal,
        observacion: item.observacion,
        complementos_metadata: complementosResult.metadata,
        complementos_detalle: complementosResult.selected,
        extras_detalle: extrasResult.selected
      });
      subTotals.push(subTotal);
      continue;
    }

    const receta = recetaMap.get(item.id_receta);
    if (!receta) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: `Receta no encontrada: ${item.id_receta}` }
      };
    }

    if (!parseBooleanish(receta.estado)) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: `Receta inactiva en la venta: ${item.id_receta}` }
      };
    }

    const precioUnitario = roundMoney(receta.precio);
    const subTotal = roundMoney(precioUnitario * item.cantidad);

    const complementosResult = resolveLineComplementos({
      item,
      receta,
      combo: null,
      context: complementContext,
      nombreItem: receta.nombre_receta || 'Receta'
    });
    if (!complementosResult.ok) {
      return {
        ok: false,
        status: complementosResult.status || 400,
        body: {
          error: true,
          code: complementosResult.code || undefined,
          message: complementosResult.message
        }
      };
    }
    const extrasResult = resolveLineExtras({ item, allowedExtrasMap });
    if (!extrasResult.ok) {
      return {
        ok: false,
        status: extrasResult.status || 400,
        body: { error: true, code: extrasResult.code || undefined, message: extrasResult.message }
      };
    }
    lines.push({
      kind: 'RECETA',
      cart_key: item.cart_key,
      requiere_cocina: true,
      id_producto: null,
      id_combo: null,
      id_receta: item.id_receta,
      id_descuento_catalogo_linea: item.id_descuento_catalogo_linea ?? null,
      id_almacen: null,
      nombre_item: receta.nombre_receta || `Receta #${item.id_receta}`,
      cantidad: item.cantidad,
      precio_unitario: precioUnitario,
      sub_total: subTotal,
      base_sub_total: subTotal,
      subtotal_extras: extrasResult.subtotal,
      observacion: item.observacion,
      complementos_metadata: complementosResult.metadata,
      complementos_detalle: complementosResult.selected,
      extras_detalle: extrasResult.selected
    });
    subTotals.push(subTotal);
  }

  perf?.add?.('totals_items_ms', totalsItemsStart);
  return { ok: true, data: { lines, subTotals } };
};

const normalizePedidoCatalogCode = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

const PEDIDO_PENDIENTE_STATIC_CATALOG_CACHE_DEFAULT_TTL_MS = 30000;
const pedidoPendienteStaticCatalogCache = new Map();
const PEDIDO_PENDIENTE_STATIC_CATALOG_LOOKUPS = new Set([
  'cat_pedidos_canales|id_canal_pedido',
  'cat_pedidos_modalidades_entrega|id_modalidad_entrega',
  'cat_pedidos_estados_pago|id_estado_pago_pedido',
  'cat_pedidos_motivos_pago_pendiente|id_motivo_pago_pendiente',
  'cat_delivery_estados|id_estado_delivery',
  'estados_pedido|id_estado_pedido'
]);

const getPedidoPendienteStaticCatalogCacheTtlMs = () => {
  const ttl = Number(process.env.VENTAS_CATALOG_CACHE_TTL_MS);
  return Number.isFinite(ttl) && ttl > 0 ? Math.round(ttl) : PEDIDO_PENDIENTE_STATIC_CATALOG_CACHE_DEFAULT_TTL_MS;
};

const clonePedidoPendienteStaticCatalogValue = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...value };
};

const buildPedidoPendienteStaticCatalogCacheKey = ({ tableName, idColumn, code }) => {
  const normalizedTableName = String(tableName || '').trim().toLowerCase();
  const normalizedIdColumn = String(idColumn || '').trim().toLowerCase();
  const normalizedCode = normalizePedidoCatalogCode(code);
  if (!normalizedTableName || !normalizedIdColumn || !normalizedCode) return null;
  const lookupKey = `${normalizedTableName}|${normalizedIdColumn}`;
  if (!PEDIDO_PENDIENTE_STATIC_CATALOG_LOOKUPS.has(lookupKey)) return null;
  return {
    lookupKey,
    cacheKey: `${lookupKey}|${normalizedCode}`,
    normalizedCode
  };
};

const readPedidoPendienteStaticCatalogCache = (spec, now = Date.now()) => {
  if (!spec?.cacheKey) return null;
  const cached = pedidoPendienteStaticCatalogCache.get(spec.cacheKey);
  if (cached && cached.expiresAt > now) {
    return clonePedidoPendienteStaticCatalogValue(cached.value);
  }
  if (cached) pedidoPendienteStaticCatalogCache.delete(spec.cacheKey);
  return null;
};

const writePedidoPendienteStaticCatalogCache = (spec, value, now = Date.now()) => {
  if (!spec?.cacheKey || !value) return;
  pedidoPendienteStaticCatalogCache.set(spec.cacheKey, {
    value: clonePedidoPendienteStaticCatalogValue(value),
    expiresAt: now + getPedidoPendienteStaticCatalogCacheTtlMs()
  });
};

const buildPedidoPendienteStaticCatalogSpec = ({ key, tableName, idColumn, code }) => {
  const cacheParts = buildPedidoPendienteStaticCatalogCacheKey({ tableName, idColumn, code });
  if (!cacheParts) return null;
  return {
    key,
    tableName,
    idColumn,
    code: cacheParts.normalizedCode,
    cacheKey: cacheParts.cacheKey
  };
};

const buildPedidoPendienteStaticCatalogSpecs = ({ canal, modalidad, motivoPagoPendiente, includeDelivery }) => [
  buildPedidoPendienteStaticCatalogSpec({
    key: 'canalCatalog',
    tableName: 'cat_pedidos_canales',
    idColumn: 'id_canal_pedido',
    code: canal
  }),
  buildPedidoPendienteStaticCatalogSpec({
    key: 'modalidadCatalog',
    tableName: 'cat_pedidos_modalidades_entrega',
    idColumn: 'id_modalidad_entrega',
    code: modalidad
  }),
  buildPedidoPendienteStaticCatalogSpec({
    key: 'estadoPagoCatalog',
    tableName: 'cat_pedidos_estados_pago',
    idColumn: 'id_estado_pago_pedido',
    code: PEDIDO_PENDIENTE_ESTADO_PAGO
  }),
  buildPedidoPendienteStaticCatalogSpec({
    key: 'motivoPagoCatalog',
    tableName: 'cat_pedidos_motivos_pago_pendiente',
    idColumn: 'id_motivo_pago_pendiente',
    code: motivoPagoPendiente
  }),
  includeDelivery
    ? buildPedidoPendienteStaticCatalogSpec({
      key: 'deliveryEstadoCatalog',
      tableName: 'cat_delivery_estados',
      idColumn: 'id_estado_delivery',
      code: PEDIDO_PENDIENTE_ESTADO_DELIVERY
    })
    : null,
  buildPedidoPendienteStaticCatalogSpec({
    key: 'idEstadoPedido',
    tableName: 'estados_pedido',
    idColumn: 'id_estado_pedido',
    code: 'EN_COCINA'
  })
].filter(Boolean);

const fetchPedidoPendienteStaticCatalogSpecs = async (client, specs) => {
  const missingSpecs = Array.isArray(specs) ? specs : [];
  if (missingSpecs.length === 0) return new Map();

  const params = [];
  const selects = [];
  for (const spec of missingSpecs) {
    if (spec.tableName === 'estados_pedido') continue;
    params.push(spec.code);
    const paramIndex = params.length;
    selects.push(`
      SELECT
        '${spec.key}'::text AS catalog_key,
        catalog_row.${spec.idColumn}::int AS id,
        catalog_row.codigo::text AS code,
        NULL::text AS descripcion
      FROM (
        SELECT ${spec.idColumn}, codigo
        FROM public.${spec.tableName}
        WHERE UPPER(TRIM(codigo)) = $${paramIndex}
          AND COALESCE(estado, true) = true
        LIMIT 1
      ) catalog_row
    `);
  }

  const needsEstadoPedido = missingSpecs.some((spec) => spec.tableName === 'estados_pedido');
  if (needsEstadoPedido) {
    selects.push(`
      SELECT
        'idEstadoPedido'::text AS catalog_key,
        estado_row.id_estado_pedido::int AS id,
        NULL::text AS code,
        estado_row.descripcion::text AS descripcion
      FROM (
        SELECT id_estado_pedido, descripcion
        FROM public.estados_pedido
        ORDER BY id_estado_pedido
      ) estado_row
    `);
  }

  if (selects.length === 0) return new Map();
  const result = await client.query(
    `
      ${selects.join('\nUNION ALL\n')}
      ORDER BY catalog_key, id
    `,
    params
  );

  const fetched = new Map();
  const specsByKey = new Map(missingSpecs.map((spec) => [spec.key, spec]));
  for (const row of result.rows) {
    const key = String(row.catalog_key || '').trim();
    if (!key || fetched.has(key) || key === 'idEstadoPedido') continue;
    const spec = specsByKey.get(key);
    const id = parseOptionalPositiveInt(row.id);
    if (!spec || !id) continue;
    fetched.set(key, {
      id,
      codigo: String(row.code || spec.code).trim().toUpperCase()
    });
  }

  if (needsEstadoPedido) {
    const estadoPedidoAliases = ESTADO_PEDIDO_CODES.EN_COCINA || new Set();
    const estadoPedidoRow = result.rows.find((row) =>
      String(row.catalog_key || '').trim() === 'idEstadoPedido'
      && estadoPedidoAliases.has(normalizeTextKey(row.descripcion))
    );
    const idEstadoPedido = parseOptionalPositiveInt(estadoPedidoRow?.id);
    if (idEstadoPedido) fetched.set('idEstadoPedido', idEstadoPedido);
  }

  return fetched;
};

const resolvePedidoPendienteStaticCatalogs = async ({ client, canal, modalidad, motivoPagoPendiente, includeDelivery }) => {
  const specs = buildPedidoPendienteStaticCatalogSpecs({ canal, modalidad, motivoPagoPendiente, includeDelivery });
  const now = Date.now();
  const resolved = {
    canalCatalog: null,
    modalidadCatalog: null,
    estadoPagoCatalog: null,
    motivoPagoCatalog: null,
    deliveryEstadoCatalog: null,
    idEstadoPedido: null
  };
  const missingSpecs = [];

  for (const spec of specs) {
    const cached = readPedidoPendienteStaticCatalogCache(spec, now);
    if (cached) {
      resolved[spec.key] = cached;
      continue;
    }
    missingSpecs.push(spec);
  }

  const fetched = await fetchPedidoPendienteStaticCatalogSpecs(client, missingSpecs);
  for (const spec of missingSpecs) {
    const value = fetched.get(spec.key) || null;
    if (!value) continue;
    resolved[spec.key] = clonePedidoPendienteStaticCatalogValue(value);
    writePedidoPendienteStaticCatalogCache(spec, value, now);
  }

  return resolved;
};

const normalizePedidoText = (value, maxLength = 200) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const normalizeTelefonoDigits = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits || null;
};

const buildPedidoPendienteItemsBody = (body) => {
  const items = Array.isArray(body?.items) ? body.items : [];
  const descuentosLinea = Array.isArray(body?.descuentos_linea) ? body.descuentos_linea : [];
  if (!descuentosLinea.length) return items;

  const descuentosLineaByCartKey = new Map();
  for (const descuentoLinea of descuentosLinea) {
    if (!isPlainObject(descuentoLinea)) continue;
    const cartKey = String(descuentoLinea.cart_key || '').trim();
    const idDescuentoCatalogo = parseOptionalPositiveInt(descuentoLinea.id_descuento_catalogo);
    if (!cartKey || !idDescuentoCatalogo) continue;
    descuentosLineaByCartKey.set(cartKey, idDescuentoCatalogo);
  }
  const useLegacyIndexFallback = descuentosLineaByCartKey.size === 0;

  return items.map((item, index) => {
    if (!isPlainObject(item)) return item;
    if (parseOptionalPositiveInt(item.id_descuento_catalogo)) return item;

    const itemCartKey = String(item.cart_key || '').trim();
    const descuentoByCartKey = itemCartKey ? descuentosLineaByCartKey.get(itemCartKey) : null;
    if (descuentoByCartKey) {
      return { ...item, id_descuento_catalogo: descuentoByCartKey };
    }

    // Compatibilidad con clientes legacy que enviaban un arreglo posicional sin cart_key.
    if (!useLegacyIndexFallback) return item;
    const descuentoLinea = descuentosLinea[index];
    if (!isPlainObject(descuentoLinea)) return item;
    const idDescuentoCatalogo = parseOptionalPositiveInt(descuentoLinea.id_descuento_catalogo);
    if (!idDescuentoCatalogo) return item;
    if (process.env.NODE_ENV === 'development') {
      console.warn('[pedido_pendiente:descuento_linea_legacy_index]', {
        index,
        has_item_cart_key: Boolean(itemCartKey),
        has_discount_cart_key: Boolean(String(descuentoLinea.cart_key || '').trim())
      });
    }
    return { ...item, id_descuento_catalogo: idDescuentoCatalogo };
  });
};

const buildPedidoPendienteDiscountErrorBody = (validation) => ({
  error: true,
  code: validation.code,
  message: validation.code === 'VENTAS_DESCUENTO_ITEM_NO_APLICA'
    ? 'El descuento seleccionado ya no aplica a uno de los items del pedido. Revisa los descuentos del carrito.'
    : validation.message
});

const mapPedidoPendienteSessionStatus = (reason) => reason === 'SESSION_SCOPE_MISMATCH' ? 403 : 409;

const buildPedidoPendientePayload = async ({ client, body, userId, sucursalScope, canApplyDiscount, perf = null }) => {
  if (!isPlainObject(body)) return { ok: false, status: 400, body: { error: true, message: 'Payload invalido para crear pedido pendiente.' } };
  if (!userId) return { ok: false, status: 401, body: { error: true, message: 'No se pudo resolver el usuario autenticado.' } };

  const idCliente = parseOptionalPositiveInt(body.id_cliente);
  const idSucursalRequested = parseOptionalPositiveInt(body.id_sucursal);
  const idSesionCajaRequested = parseOptionalPositiveInt(body.id_sesion_caja);
  if (!idSucursalRequested) return { ok: false, status: 400, body: { error: true, message: 'id_sucursal es obligatorio.' } };

  const isSuperAdmin = Boolean(sucursalScope?.isSuperAdmin);
  const allowedSucursalIds = Array.isArray(sucursalScope?.allowedSucursalIds) ? sucursalScope.allowedSucursalIds.map((id) => parseOptionalPositiveInt(id)).filter(Boolean) : [];
  const userSucursalId = parseOptionalPositiveInt(sucursalScope?.userSucursalId);
  const effectiveAllowedSucursalIds = allowedSucursalIds.length > 0 ? allowedSucursalIds : userSucursalId ? [userSucursalId] : [];
  if (!isSuperAdmin && !effectiveAllowedSucursalIds.includes(idSucursalRequested)) {
    return { ok: false, status: 403, body: { error: true, message: 'No puedes operar pedidos de otra sucursal.' } };
  }

  const idSucursal = await resolveSucursalId(client, idSucursalRequested);
  if (!idSucursal) return { ok: false, status: 409, body: { error: true, message: 'La sucursal seleccionada no esta disponible.' } };

  const contexto = isPlainObject(body.contexto) ? body.contexto : {};
  const canal = normalizePedidoCatalogCode(contexto.canal);
  const modalidad = normalizePedidoCatalogCode(contexto.modalidad);
  if (!PEDIDO_PENDIENTE_CANALES.has(canal)) return { ok: false, status: 400, body: { error: true, message: 'contexto.canal debe ser LOCAL, TELEFONO o WHATSAPP.' } };
  if (!PEDIDO_PENDIENTE_MODALIDADES.has(modalidad)) return { ok: false, status: 400, body: { error: true, message: 'contexto.modalidad debe ser CONSUMO_LOCAL, RECOGER o DELIVERY.' } };

  const contacto = isPlainObject(body.contacto) ? body.contacto : {};
  let cliente = null;
  if (idCliente) {
    cliente = await fetchClienteInfo(client, idCliente);
    if (!cliente) return { ok: false, status: 400, body: { error: true, message: 'id_cliente no existe.' } };
  }

  const nombreContacto = normalizePedidoText(contacto.nombre_contacto, 120) || (cliente ? normalizeClienteNombre(cliente).slice(0, 120) : null);
  const telefonoContacto = normalizePedidoText(contacto.telefono_contacto, 40);
  const telefonoNormalizado = normalizeTelefonoDigits(contacto.telefono_contacto);
  if (!idCliente && !nombreContacto) return { ok: false, status: 400, body: { error: true, message: 'contacto.nombre_contacto es obligatorio cuando id_cliente es null.' } };
  if ((modalidad === 'RECOGER' || canal === 'TELEFONO' || canal === 'WHATSAPP') && !telefonoContacto) {
    return { ok: false, status: 400, body: { error: true, message: 'contacto.telefono_contacto es obligatorio para este canal o modalidad.' } };
  }

  const pagoPendiente = isPlainObject(body.pago_pendiente) ? body.pago_pendiente : {};
  const motivoPagoPendiente = normalizePedidoCatalogCode(pagoPendiente.motivo);
  if (!motivoPagoPendiente) return { ok: false, status: 400, body: { error: true, message: 'pago_pendiente.motivo es obligatorio.' } };

  let delivery = null;
  let costoEnvio = 0;
  if (modalidad === 'DELIVERY') {
    if (!isPlainObject(body.delivery)) return { ok: false, status: 400, body: { error: true, message: 'delivery es obligatorio cuando modalidad es DELIVERY.' } };
    const hasCostoEnvioInput = body.delivery.costo_envio !== null &&
      body.delivery.costo_envio !== undefined &&
      String(body.delivery.costo_envio).trim() !== '';
    if (hasCostoEnvioInput) {
      costoEnvio = parseNonNegativeNumber(body.delivery.costo_envio);
      if (costoEnvio === null) return { ok: false, status: 400, body: { error: true, message: 'delivery.costo_envio debe ser numerico mayor o igual a 0.' } };
    }
    delivery = {
      costo_envio: costoEnvio,
      nombre_receptor: normalizePedidoText(body.delivery.nombre_receptor, 120),
      telefono_receptor: normalizePedidoText(body.delivery.telefono_receptor, 40),
      direccion_entrega: normalizePedidoText(body.delivery.direccion_entrega, 250),
      referencia_entrega: normalizePedidoText(body.delivery.referencia_entrega, 250),
      observacion_delivery: normalizePedidoText(body.delivery.observacion_delivery, 250)
    };
    const missingDeliveryField = ['nombre_receptor', 'telefono_receptor', 'direccion_entrega', 'referencia_entrega'].find((field) => !delivery[field]);
    if (missingDeliveryField) return { ok: false, status: 400, body: { error: true, message: 'delivery.' + missingDeliveryField + ' es obligatorio.' } };
  }

  const staticCatalogsStart = perf?.now?.() || 0;
  let staticCatalogs = null;
  try {
    staticCatalogs = await resolvePedidoPendienteStaticCatalogs({
      client,
      canal,
      modalidad,
      motivoPagoPendiente,
      includeDelivery: modalidad === 'DELIVERY'
    });
  } finally {
    perf?.add?.('pedido_pendiente_static_catalogs_ms', staticCatalogsStart);
  }
  const {
    canalCatalog,
    modalidadCatalog,
    estadoPagoCatalog,
    motivoPagoCatalog,
    deliveryEstadoCatalog,
    idEstadoPedido
  } = staticCatalogs || {};
  if (!canalCatalog || !modalidadCatalog || !estadoPagoCatalog || !motivoPagoCatalog || (modalidad === 'DELIVERY' && !deliveryEstadoCatalog)) {
    return { ok: false, status: 409, body: { error: true, message: 'No se encontraron catalogos requeridos para crear el pedido pendiente.' } };
  }

  const validationItemsStart = perf?.now?.() || 0;
  const normalizedItemsResult = normalizeVentaItems(buildPedidoPendienteItemsBody(body));
  perf?.add?.('validation_items_ms', validationItemsStart);
  if (!normalizedItemsResult.ok) return { ok: false, status: 400, body: { error: true, message: normalizedItemsResult.message } };
  const hydrateLinesStart = perf?.now?.() || 0;
  const hydratedResult = await hydrateVentaLines(client, normalizedItemsResult.data, perf, {
    idSucursal,
    validateProductStock: false
  });
  perf?.add?.('pedido_pendiente_hydrate_lines_ms', hydrateLinesStart);
  if (!hydratedResult.ok) return hydratedResult;

  const { lines, subTotals } = hydratedResult.data;
  const subtotalBaseBruto = roundMoney(lines.reduce((sum, line) => sum + Number(line.base_sub_total ?? line.sub_total ?? 0), 0));
  const subtotalExtras = roundMoney(lines.reduce((sum, line) => sum + Number(line.subtotal_extras || 0), 0));
  const subtotalBruto = roundMoney(subtotalBaseBruto + subtotalExtras);
  const idDescuentoCatalogo = parseOptionalPositiveInt(body.id_descuento_catalogo);
  const descuentoLegacyInput = parseNonNegativeNumber(body.descuento ?? 0);
  if (body.id_descuento_catalogo !== undefined && body.id_descuento_catalogo !== null && !idDescuentoCatalogo) return { ok: false, status: 400, body: { error: true, message: 'id_descuento_catalogo debe ser un entero mayor a 0.' } };
  if (body.descuento !== undefined && descuentoLegacyInput === null) return { ok: false, status: 400, body: { error: true, message: 'descuento debe ser un numero mayor o igual a 0.' } };

  let descuentoGlobalTotal = 0;
  let appliedDiscountCatalog = null;
  const hasGlobalCatalogDiscount = Boolean(idDescuentoCatalogo);
  const hasLegacyDiscount = Number(descuentoLegacyInput || 0) > 0;
  const hasLineDiscountAttempt = lines.some((line) => Number(line.id_descuento_catalogo_linea || 0) > 0);
  const hasDiscountAttempt = hasGlobalCatalogDiscount || hasLegacyDiscount || hasLineDiscountAttempt;
  if (hasDiscountAttempt && !canApplyDiscount) return { ok: false, status: 403, body: { error: true, code: 'VENTAS_DESCUENTO_NO_AUTORIZADO', message: 'No tienes permiso para aplicar descuentos en ventas.' } };

  const totalsDescuentosStart = perf?.now?.() || 0;
  const discountCatalogIds = [
    idDescuentoCatalogo,
    ...lines.map((line) => parseOptionalPositiveInt(line.id_descuento_catalogo_linea))
  ].filter(Boolean);
  const discountCatalogMap = await fetchDiscountCatalogMapByIds(client, discountCatalogIds, { perf });
  const descuentosLineaMap = new Map();
  const descuentosCatalogoLineaMap = new Map();
  if (hasLineDiscountAttempt) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const idDescuentoLinea = parseOptionalPositiveInt(line.id_descuento_catalogo_linea);
      if (!idDescuentoLinea) continue;
      const discountCatalog = discountCatalogMap.get(idDescuentoLinea) || null;
      const validatedLineDiscount = validateCatalogDiscountAvailability({ discountCatalog, idSucursal, subtotalObjetivo: line.base_sub_total ?? line.sub_total, alcanceEsperado: line.kind, line });
      if (!validatedLineDiscount.ok) {
        return {
          ok: false,
          status: validatedLineDiscount.status,
          body: buildPedidoPendienteDiscountErrorBody(validatedLineDiscount)
        };
      }
      descuentosLineaMap.set(index, validatedLineDiscount.montoCalculado);
      descuentosCatalogoLineaMap.set(index, Number(discountCatalog.id_descuento_catalogo));
    }
  }

  const descuentoLineasTotal = roundMoney([...descuentosLineaMap.values()].reduce((sum, value) => sum + Number(value || 0), 0));
  const subtotalBaseDespuesLinea = roundMoney(Math.max(subtotalBaseBruto - descuentoLineasTotal, 0));

  if (idDescuentoCatalogo) {
    const discountCatalog = discountCatalogMap.get(idDescuentoCatalogo) || null;
    const validatedGlobalDiscount = validateCatalogDiscountAvailability({ discountCatalog, idSucursal, subtotalObjetivo: subtotalBaseDespuesLinea, alcanceEsperado: DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA });
    if (!validatedGlobalDiscount.ok) {
      return {
        ok: false,
        status: validatedGlobalDiscount.status,
        body: buildPedidoPendienteDiscountErrorBody(validatedGlobalDiscount)
      };
    }
    descuentoGlobalTotal = validatedGlobalDiscount.montoCalculado;
    appliedDiscountCatalog = { id_descuento_catalogo: Number(discountCatalog.id_descuento_catalogo) };
  } else if (hasLegacyDiscount) {
    if (descuentoLegacyInput > subtotalBaseDespuesLinea) return { ok: false, status: 400, body: { error: true, message: 'El descuento no puede ser mayor al subtotal.' } };
    descuentoGlobalTotal = roundMoney(descuentoLegacyInput);
  }
  perf?.add?.('totals_descuentos_ms', totalsDescuentosStart);
  perf?.add?.('validation_descuentos_ms', totalsDescuentosStart);

  const descuentosGlobalesPorLinea = allocateDiscounts(
    lines.map((line, index) => roundMoney((line.base_sub_total ?? line.sub_total) - roundMoney(descuentosLineaMap.get(index) || 0))),
    descuentoGlobalTotal
  );

  const finalizedLines = lines.map((line, index) => ({
    ...line,
    id_descuento_catalogo: descuentosCatalogoLineaMap.get(index) || appliedDiscountCatalog?.id_descuento_catalogo || null,
    id_descuento_catalogo_linea_aplicado: descuentosCatalogoLineaMap.get(index) || null,
    id_descuento_catalogo_global: appliedDiscountCatalog?.id_descuento_catalogo ?? null,
    descuento_linea: roundMoney(descuentosLineaMap.get(index) || 0),
    descuento_global: roundMoney(descuentosGlobalesPorLinea[index] || 0),
    descuento: roundMoney(roundMoney(descuentosLineaMap.get(index) || 0) + roundMoney(descuentosGlobalesPorLinea[index] || 0)),
    total_linea: roundMoney((line.base_sub_total ?? line.sub_total) - roundMoney(descuentosLineaMap.get(index) || 0) - roundMoney(descuentosGlobalesPorLinea[index] || 0) + roundMoney(line.subtotal_extras || 0))
  }));

  const descuentoTotal = roundMoney(finalizedLines.reduce((sum, line) => sum + Number(line.descuento || 0), 0));
  const subtotal = roundMoney(finalizedLines.reduce((sum, line) => sum + line.total_linea, 0));
  const isv = 0;
  const total = roundMoney(subtotal + costoEnvio);
  if (!idEstadoPedido) return { ok: false, status: 409, body: { error: true, message: 'No existe el estado EN_COCINA en estados_pedido.' } };

  const sessionActiva = await resolveCajaSession({ client, idSucursal, idUsuario: userId, idSesionCaja: idSesionCajaRequested, isSuperAdmin });
  if (!sessionActiva.ok) {
    return {
      ok: false,
      status: mapPedidoPendienteSessionStatus(sessionActiva.reason),
      body: {
        error: true,
        code: sessionActiva.reason || 'NO_ACTIVE_SESSION',
        message: sessionActiva.reason === 'SESSION_SCOPE_MISMATCH' ? 'La caja seleccionada no pertenece a la sucursal del pedido.' : 'Debe abrir o participar en una sesion de caja activa para crear pedidos pendientes.'
      }
    };
  }

  return {
    ok: true,
    data: {
      id_cliente: idCliente,
      id_sucursal: idSucursal,
      id_usuario: userId,
      id_estado_pedido: idEstadoPedido,
      id_caja: Number(sessionActiva.data.id_caja),
      id_sesion_caja: Number(sessionActiva.data.id_sesion_caja),
      canal,
      modalidad,
      id_canal_pedido: canalCatalog.id,
      id_modalidad_entrega: modalidadCatalog.id,
      id_estado_pago_pedido: estadoPagoCatalog.id,
      id_motivo_pago_pendiente: motivoPagoCatalog.id,
      id_estado_delivery: deliveryEstadoCatalog?.id || null,
      contacto: {
        nombre_contacto: nombreContacto || 'Cliente registrado',
        telefono_contacto: telefonoContacto,
        telefono_normalizado: telefonoNormalizado,
        dni: normalizePedidoText(contacto.dni, 30),
        rtn: normalizePedidoText(contacto.rtn, 30),
        correo: normalizePedidoText(contacto.correo, 120)
      },
      observacion_contexto: normalizePedidoText(contexto.observacion_contexto, 250),
      observacion_pago: normalizePedidoText(pagoPendiente.observacion_pago, 250),
      delivery,
      descripcion_pedido: buildKitchenDescriptionSummary(finalizedLines, contexto.observacion_contexto),
      descripcion_envio: modalidad === 'DELIVERY' ? (delivery.direccion_entrega + ' | Ref: ' + delivery.referencia_entrega).slice(0, 250) : modalidad,
      pedido_lines: finalizedLines,
      subtotal_bruto: subtotalBruto,
      descuento: descuentoTotal,
      descuento_lineas: descuentoLineasTotal,
      descuento_global: descuentoGlobalTotal,
      id_descuento_catalogo: appliedDiscountCatalog?.id_descuento_catalogo ?? null,
      subtotal,
      isv,
      costo_envio: costoEnvio,
      total
    }
  };
};
const buildPedidoFacturaSnapshot = (row, quantity, tipoItem, precioUnitario, subTotal, totalDetalle) => {
  const snapshot = {
    tipo_item: tipoItem,
    nombre_item: row.nombre_item || null,
    id_producto: parseOptionalPositiveInt(row.id_producto),
    id_receta: parseOptionalPositiveInt(row.id_receta),
    id_combo: parseOptionalPositiveInt(row.id_combo),
    id_detalle_pedido: parseOptionalPositiveInt(row.id_detalle_pedido),
    cantidad: Number(quantity || 1),
    precio_unitario: roundMoney(precioUnitario),
    sub_total: roundMoney(subTotal),
    total_detalle: roundMoney(totalDetalle),
    subtotal_extras: roundMoney(row.subtotal_extras),
    descuento: roundMoney(roundMoney(subTotal) - roundMoney(totalDetalle)),
    descuento_linea: roundMoney(row.descuento_linea),
    descuento_global: roundMoney(row.descuento_global),
    id_descuento_catalogo_linea: row.id_descuento_catalogo_linea || null,
    id_descuento_catalogo_global: row.id_descuento_catalogo_global || null,
    observacion: row.observacion || null,
    extras: Array.isArray(row.extras_detalle) ? row.extras_detalle : [],
    origen: 'PEDIDO_PENDIENTE'
  };
  const componentSnapshot = buildComplementSnapshotFromMenuConfig(row.configuracion_menu);
  if (componentSnapshot && !snapshot.componentes && !snapshot.complementos) {
    snapshot.componentes = componentSnapshot;
  }
  return snapshot;
};

const prepareDetalleFacturaDesdePedido = (row, idPedido) => {
  const idProducto = parseOptionalPositiveInt(row.id_producto);
  const idReceta = parseOptionalPositiveInt(row.id_receta);
  const idCombo = parseOptionalPositiveInt(row.id_combo);
  const tipoItem = normalizeTipoItem(idCombo ? 'COMBO' : idReceta ? 'RECETA' : idProducto ? 'PRODUCTO' : 'ITEM');
  const subTotal = roundMoney(row.sub_total_pedido);
  const totalDetalle = roundMoney(row.total_pedido ?? row.sub_total_pedido);
  const precioBase = roundMoney(row.precio_unitario || (subTotal > 0 ? subTotal : totalDetalle));
  const cantidad = inferKitchenItemQuantity(subTotal, precioBase);
  const precioUnitario = precioBase > 0 ? precioBase : roundMoney(subTotal / Math.max(cantidad, 1));
  const idDetallePedido = parseOptionalPositiveInt(row.id_detalle_pedido);
  const snapshot = buildPedidoFacturaSnapshot(row, cantidad, tipoItem, precioUnitario, subTotal, totalDetalle);

  return {
    idPedido,
    idProducto,
    idReceta,
    idCombo,
    tipoItem,
    subTotal,
    totalDetalle,
    cantidad,
    precioUnitario,
    idDetallePedido,
    idDescuento: parseOptionalPositiveInt(row.id_descuento),
    snapshot
  };
};

const insertDetalleFacturaOrigenSnapshot = async ({ client, idDetalleFactura, idDetallePedido, tipoItem, idProducto, idReceta, idCombo, snapshot }) => {
  if (!idDetalleFactura) return;
  await client.query(
    `
      INSERT INTO public.detalle_facturas_origen (
        id_detalle_factura,
        id_detalle_pedido,
        tipo_item,
        id_producto,
        id_receta,
        id_combo,
        origen_snapshot
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (id_detalle_factura)
      DO UPDATE SET
        id_detalle_pedido = EXCLUDED.id_detalle_pedido,
        tipo_item = EXCLUDED.tipo_item,
        id_producto = EXCLUDED.id_producto,
        id_receta = EXCLUDED.id_receta,
        id_combo = EXCLUDED.id_combo,
        origen_snapshot = EXCLUDED.origen_snapshot
    `,
    [
      idDetalleFactura,
      idDetallePedido || null,
      tipoItem,
      idProducto || null,
      idReceta || null,
      idCombo || null,
      JSON.stringify(snapshot)
    ]
  );
};

const insertDetalleFacturaDesdePedido = async ({ client, idFactura, idPedido, row }) => {
  const prepared = prepareDetalleFacturaDesdePedido(row, idPedido);

  const detalleFacturaResult = await client.query(
    `
      INSERT INTO detalle_facturas (
        id_factura,
        id_producto,
        id_descuento,
        cantidad,
        precio_unitario,
        sub_total,
        total_detalle,
        id_pedido,
        id_detalle_pedido,
        tipo_item,
        id_receta,
        id_combo,
        origen_snapshot
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      RETURNING id_detalle_factura
    `,
    [
      idFactura,
      prepared.idProducto,
      prepared.idDescuento,
      prepared.cantidad,
      prepared.precioUnitario,
      prepared.subTotal,
      prepared.totalDetalle,
      idPedido,
      prepared.idDetallePedido,
      prepared.tipoItem,
      prepared.idReceta,
      prepared.idCombo,
      JSON.stringify(prepared.snapshot)
    ]
  );

  const idDetalleFactura = Number(detalleFacturaResult.rows?.[0]?.id_detalle_factura || 0);
  await insertDetalleFacturaOrigenSnapshot({
    client,
    idDetalleFactura,
    idDetallePedido: prepared.idDetallePedido,
    tipoItem: prepared.tipoItem,
    idProducto: prepared.idProducto,
    idReceta: prepared.idReceta,
    idCombo: prepared.idCombo,
    snapshot: prepared.snapshot
  });
  return { totalDetalle: prepared.totalDetalle, subTotal: prepared.subTotal };
};

const insertDetalleFacturasDesdePedidoBatch = async ({ client, idFactura, idPedido, rows = [] }) => {
  const preparedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => prepareDetalleFacturaDesdePedido(row, idPedido))
    .filter((prepared) => prepared.idDetallePedido);
  if (!preparedRows.length) return { totalDetalle: 0, subTotal: 0, inserted: [] };

  const values = [];
  const params = [];
  preparedRows.forEach((prepared) => {
    const offset = params.length;
    params.push(
      idFactura,
      prepared.idProducto,
      prepared.idDescuento,
      prepared.cantidad,
      prepared.precioUnitario,
      prepared.subTotal,
      prepared.totalDetalle,
      idPedido,
      prepared.idDetallePedido,
      prepared.tipoItem,
      prepared.idReceta,
      prepared.idCombo,
      JSON.stringify(prepared.snapshot)
    );
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}::jsonb)`);
  });

  const detalleFacturaResult = await client.query(
    `
      INSERT INTO detalle_facturas (
        id_factura,
        id_producto,
        id_descuento,
        cantidad,
        precio_unitario,
        sub_total,
        total_detalle,
        id_pedido,
        id_detalle_pedido,
        tipo_item,
        id_receta,
        id_combo,
        origen_snapshot
      )
      VALUES ${values.join(', ')}
      RETURNING id_detalle_factura, id_detalle_pedido
    `,
    params
  );

  const detalleFacturaByPedidoId = new Map(
    detalleFacturaResult.rows.map((row) => [
      parseOptionalPositiveInt(row.id_detalle_pedido),
      Number(row.id_detalle_factura || 0)
    ])
  );

  const origenValues = [];
  const origenParams = [];
  for (const prepared of preparedRows) {
    const idDetalleFactura = detalleFacturaByPedidoId.get(prepared.idDetallePedido);
    if (!idDetalleFactura) continue;
    const offset = origenParams.length;
    origenParams.push(
      idDetalleFactura,
      prepared.idDetallePedido,
      prepared.tipoItem,
      prepared.idProducto,
      prepared.idReceta,
      prepared.idCombo,
      JSON.stringify(prepared.snapshot)
    );
    origenValues.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb)`);
  }

  if (origenValues.length) {
    await client.query(
      `
        INSERT INTO public.detalle_facturas_origen (
          id_detalle_factura,
          id_detalle_pedido,
          tipo_item,
          id_producto,
          id_receta,
          id_combo,
          origen_snapshot
        )
        VALUES ${origenValues.join(', ')}
        ON CONFLICT (id_detalle_factura)
        DO UPDATE SET
          id_detalle_pedido = EXCLUDED.id_detalle_pedido,
          tipo_item = EXCLUDED.tipo_item,
          id_producto = EXCLUDED.id_producto,
          id_receta = EXCLUDED.id_receta,
          id_combo = EXCLUDED.id_combo,
          origen_snapshot = EXCLUDED.origen_snapshot
      `,
      origenParams
    );
  }

  return {
    totalDetalle: roundMoney(preparedRows.reduce((sum, prepared) => sum + Number(prepared.totalDetalle || 0), 0)),
    subTotal: roundMoney(preparedRows.reduce((sum, prepared) => sum + Number(prepared.subTotal || 0), 0)),
    inserted: detalleFacturaResult.rows
  };
};

const insertDetalleFacturaDelivery = async ({ client, idFactura, idPedido, costoEnvio }) => {
  const costo = roundMoney(costoEnvio);
  if (costo <= 0) return 0;

  const snapshot = {
    tipo_item: 'ITEM',
    nombre_item: 'Costo de envio',
    concepto: 'Costo de envio',
    cantidad: 1,
    precio_unitario: costo,
    sub_total: costo,
    total_detalle: costo,
    origen: 'DELIVERY',
    costo_envio: costo
  };

  const detalleFacturaResult = await client.query(
    `
      INSERT INTO detalle_facturas (
        id_factura,
        id_producto,
        id_descuento,
        cantidad,
        precio_unitario,
        sub_total,
        total_detalle,
        id_pedido,
        id_detalle_pedido,
        tipo_item,
        id_receta,
        id_combo,
        origen_snapshot
      )
      VALUES ($1, NULL, NULL, 1, $2, $2, $2, $3, NULL, 'ITEM', NULL, NULL, $4::jsonb)
      RETURNING id_detalle_factura
    `,
    [idFactura, costo, idPedido, JSON.stringify(snapshot)]
  );

  const idDetalleFactura = Number(detalleFacturaResult.rows?.[0]?.id_detalle_factura || 0);
  await insertDetalleFacturaOrigenSnapshot({
    client,
    idDetalleFactura,
    idDetallePedido: null,
    tipoItem: 'ITEM',
    idProducto: null,
    idReceta: null,
    idCombo: null,
    snapshot
  });
  return costo;
};

const updatePedidoLegacyPagoConfirmado = async ({ client, idPedido, userId }) => {
  const assignments = [];
  const params = [idPedido];

  if (await hasColumn(client, 'pedidos', 'estado_pago')) {
    params.push(PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO);
    assignments.push('estado_pago = $' + params.length);
  }
  if (await hasColumn(client, 'pedidos', 'pago_confirmado_at')) {
    assignments.push("pago_confirmado_at = (NOW() AT TIME ZONE 'America/Tegucigalpa')");
  }
  if (await hasColumn(client, 'pedidos', 'id_usuario_pago_confirmado')) {
    params.push(userId);
    assignments.push('id_usuario_pago_confirmado = $' + params.length);
  }

  if (!assignments.length) return;
  await client.query('UPDATE pedidos SET ' + assignments.join(', ') + ' WHERE id_pedido = $1', params);
};

const buildVentaPayload = async ({ client, body, userId, sucursalScope, canApplyDiscount, perf = null }) => {
  const payloadBuildStart = perf?.now?.() || 0;
  if (!isPlainObject(body)) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'Payload invalido para crear venta.' }
    };
  }

  if (body.pagos !== undefined || Array.isArray(body.metodo_pago)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'Los pagos mixtos todavia no estan habilitados. Use metodo_pago unico.'
      }
    };
  }

  const validationItemsStart = perf?.now?.() || 0;
  const normalizedItemsResult = normalizeVentaItems(body.items);
  perf?.add?.('validation_items_ms', validationItemsStart);
  if (!normalizedItemsResult.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: normalizedItemsResult.message }
    };
  }

  const idCliente = parseOptionalPositiveInt(body.id_cliente);
  const idSucursalRequested = parseOptionalPositiveInt(body.id_sucursal);
  const idSesionCajaRequested = parseOptionalPositiveInt(body.id_sesion_caja);
  const idEstadoPedidoRequested = parseOptionalPositiveInt(body.id_estado_pedido);
  const idDescuentoCatalogo = parseOptionalPositiveInt(body.id_descuento_catalogo);
  const descuentoLegacyInput = parseNonNegativeNumber(body.descuento ?? 0);
  const efectivoEntregadoInput = parseNonNegativeNumber(body.efectivo_entregado);
  const metodoPagoInput = String(body.metodo_pago || 'EFECTIVO').trim();
  const referenciaPagoInput =
    body.referencia_pago === undefined || body.referencia_pago === null
      ? null
      : String(body.referencia_pago).trim() || null;

  if (body.id_descuento_catalogo !== undefined && body.id_descuento_catalogo !== null && !idDescuentoCatalogo) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'id_descuento_catalogo debe ser un entero mayor a 0.' }
    };
  }

  if (body.descuento !== undefined && descuentoLegacyInput === null) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'descuento debe ser un numero mayor o igual a 0.' }
    };
  }

  if (body.efectivo_entregado !== undefined && efectivoEntregadoInput === null) {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'efectivo_entregado debe ser un numero mayor o igual a 0.'
      }
    };
  }

  if (!metodoPagoInput) {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'metodo_pago es obligatorio.'
      }
    };
  }

  perf?.add?.('payload_build_ms', payloadBuildStart);
  const authContextStart = perf?.now?.() || 0;

  if (!userId) {
    return {
      ok: false,
      status: 401,
      body: {
        error: true,
        message: 'No se pudo resolver el usuario autenticado para la venta.'
      }
    };
  }

  const isSuperAdmin = Boolean(sucursalScope?.isSuperAdmin);
  const userSucursalId = parseOptionalPositiveInt(sucursalScope?.userSucursalId);

  let idSucursalTarget = null;
  if (isSuperAdmin) {
    if (!idSucursalRequested) {
      return {
        ok: false,
        status: 400,
        body: {
          error: true,
          message: 'id_sucursal es obligatorio para super_admin al registrar ventas.'
        }
      };
    }
    idSucursalTarget = idSucursalRequested;
  } else {
    if (!userSucursalId) {
      return {
        ok: false,
        status: 403,
        body: {
          error: true,
          message: 'El empleado no tiene sucursal asignada.'
        }
      };
    }
    idSucursalTarget = userSucursalId;
  }

  const payloadContextCombinedStart = perf?.now?.() || 0;
  const ventaContext = await resolveVentaContextForCreate(client, null, {
    idSucursalTarget,
    idEstadoPedidoRequested,
    idCliente,
    metodoPagoInput
  });
  perf?.add?.('auth_payload_context_combined_ms', payloadContextCombinedStart);

  const idSucursal = ventaContext.idSucursal;
  if (!idSucursal) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        message: 'La sucursal operativa del usuario no esta disponible o se encuentra inactiva.'
      }
    };
  }

  const requestedEstadoPedido = ventaContext.requestedEstadoPedido;
  if (idEstadoPedidoRequested && !requestedEstadoPedido) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'id_estado_pedido no existe.' }
    };
  }

  if (idCliente && !ventaContext.cliente) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'id_cliente no existe.' }
    };
  }

  const metodoPago = ventaContext.metodoPago;
  const metodoPagoAfectaEfectivo = parseBooleanish(metodoPago?.afecta_efectivo);
  if (!metodoPago) {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'El metodo de pago seleccionado no esta disponible.'
      }
    };
  }

  if (!metodoPagoAfectaEfectivo && !referenciaPagoInput) {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'referencia_pago es obligatoria para pagos con tarjeta o transferencia.'
      }
    };
  }
  perf?.add?.('auth_context_ms', authContextStart);
  perf?.add?.('auth_payload_context_ms', authContextStart);
  const totalsStart = perf?.now?.() || 0;

  const hydratedResult = await hydrateVentaLines(client, normalizedItemsResult.data, perf, { idSucursal });
  if (!hydratedResult.ok) return hydratedResult;

  const { lines } = hydratedResult.data;
  const subtotalBaseBruto = roundMoney(lines.reduce((sum, line) => sum + Number(line.base_sub_total ?? line.sub_total ?? 0), 0));
  const subtotalExtras = roundMoney(lines.reduce((sum, line) => sum + Number(line.subtotal_extras || 0), 0));
  const subtotalBruto = roundMoney(subtotalBaseBruto + subtotalExtras);
  let descuentoGlobalTotal = 0;
  let appliedDiscountCatalog = null;
  const hasGlobalCatalogDiscount = Boolean(idDescuentoCatalogo);
  const hasLegacyDiscount = Number(descuentoLegacyInput || 0) > 0;
  const hasLineDiscountAttempt = lines.some((line) => Number(line.id_descuento_catalogo_linea || 0) > 0);
  const hasDiscountAttempt = hasGlobalCatalogDiscount || hasLegacyDiscount || hasLineDiscountAttempt;

  if (hasDiscountAttempt && !canApplyDiscount) {
    return {
      ok: false,
      status: 403,
      body: {
        error: true,
        code: 'VENTAS_DESCUENTO_NO_AUTORIZADO',
        message: 'No tienes permiso para aplicar descuentos en ventas.'
      }
    };
  }

  const totalsDescuentosStart = perf?.now?.() || 0;
  const discountCatalogIds = [
    idDescuentoCatalogo,
    ...lines.map((line) => parseOptionalPositiveInt(line.id_descuento_catalogo_linea))
  ].filter(Boolean);
  const discountCatalogMap = await fetchDiscountCatalogMapByIds(client, discountCatalogIds, { perf });
  const descuentosLineaMap = new Map();
  const descuentosCatalogoLineaMap = new Map();

  if (hasLineDiscountAttempt) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const idDescuentoLinea = parseOptionalPositiveInt(line.id_descuento_catalogo_linea);
      if (!idDescuentoLinea) continue;

      const discountCatalog = discountCatalogMap.get(idDescuentoLinea) || null;
      const expectedScope = line.kind;
      const validatedLineDiscount = validateCatalogDiscountAvailability({
        discountCatalog,
        idSucursal,
        subtotalObjetivo: line.base_sub_total ?? line.sub_total,
        alcanceEsperado: expectedScope,
        line
      });
      if (!validatedLineDiscount.ok) {
        return {
          ok: false,
          status: validatedLineDiscount.status,
          body: {
            error: true,
            code: validatedLineDiscount.code,
            message: validatedLineDiscount.message
          }
        };
      }

      descuentosLineaMap.set(index, validatedLineDiscount.montoCalculado);
      descuentosCatalogoLineaMap.set(index, Number(discountCatalog.id_descuento_catalogo));
    }
  }

  const descuentoLineasTotal = roundMoney([...descuentosLineaMap.values()].reduce((sum, value) => sum + Number(value || 0), 0));
  const subtotalBaseDespuesLinea = roundMoney(Math.max(subtotalBaseBruto - descuentoLineasTotal, 0));

  if (idDescuentoCatalogo) {
    const discountCatalog = discountCatalogMap.get(idDescuentoCatalogo) || null;
    const validatedGlobalDiscount = validateCatalogDiscountAvailability({
      discountCatalog,
      idSucursal,
      subtotalObjetivo: subtotalBaseDespuesLinea,
      alcanceEsperado: DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA
    });
    if (!validatedGlobalDiscount.ok) {
      return {
        ok: false,
        status: validatedGlobalDiscount.status,
        body: {
          error: true,
          code: validatedGlobalDiscount.code,
          message: validatedGlobalDiscount.message
        }
      };
    }

    descuentoGlobalTotal = validatedGlobalDiscount.montoCalculado;
    appliedDiscountCatalog = {
      id_descuento_catalogo: Number(discountCatalog.id_descuento_catalogo),
      id_tipo_descuento: Number(discountCatalog.id_tipo_descuento),
      tipo_descuento_key: validatedGlobalDiscount.tipoDescuentoKey,
      alcance: validatedGlobalDiscount.alcance
    };
  } else if (hasLegacyDiscount) {
    if (descuentoLegacyInput > subtotalBaseDespuesLinea) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: 'El descuento no puede ser mayor al subtotal.' }
      };
    }
    descuentoGlobalTotal = roundMoney(descuentoLegacyInput);
  }

  perf?.add?.('totals_descuentos_ms', totalsDescuentosStart);
  perf?.add?.('validation_descuentos_ms', totalsDescuentosStart);
  const totalsBuildStart = perf?.now?.() || 0;

  const descuentosGlobalesPorLinea = allocateDiscounts(
    lines.map((line, index) => roundMoney((line.base_sub_total ?? line.sub_total) - roundMoney(descuentosLineaMap.get(index) || 0))),
    descuentoGlobalTotal
  );

  const finalizedLines = lines.map((line, index) => ({
    ...line,
    id_descuento_catalogo: descuentosCatalogoLineaMap.get(index) || appliedDiscountCatalog?.id_descuento_catalogo || null,
    id_descuento_catalogo_linea_aplicado: descuentosCatalogoLineaMap.get(index) || null,
    id_descuento_catalogo_global: appliedDiscountCatalog?.id_descuento_catalogo ?? null,
    descuento_linea: roundMoney(descuentosLineaMap.get(index) || 0),
    descuento_global: roundMoney(descuentosGlobalesPorLinea[index] || 0),
    descuento: roundMoney(roundMoney(descuentosLineaMap.get(index) || 0) + roundMoney(descuentosGlobalesPorLinea[index] || 0)),
    total_linea: roundMoney((line.base_sub_total ?? line.sub_total) - roundMoney(descuentosLineaMap.get(index) || 0) - roundMoney(descuentosGlobalesPorLinea[index] || 0) + roundMoney(line.subtotal_extras || 0))
  }));

  const descuentoTotal = roundMoney(finalizedLines.reduce((sum, line) => sum + Number(line.descuento || 0), 0));
  perf?.add?.('totals_build_ms', totalsBuildStart);
  const totalsImpuestosStart = perf?.now?.() || 0;

  const subtotal = roundMoney(finalizedLines.reduce((sum, line) => sum + line.total_linea, 0));
  const isv = 0;
  const total = subtotal;
  const efectivoEntregado = metodoPagoAfectaEfectivo
    ? efectivoEntregadoInput === null
      ? total
      : efectivoEntregadoInput
    : null;

  if (metodoPagoAfectaEfectivo && efectivoEntregado < total) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'efectivo_entregado no puede ser menor al total.' }
    };
  }

  perf?.add?.('totals_impuestos_ms', totalsImpuestosStart);
  perf?.add?.('totals_ms', totalsStart);
  const cajaContextStart = perf?.now?.() || 0;
  const sesionCajaStart = perf?.now?.() || 0;
  const cajaSesionCombinedStart = perf?.now?.() || 0;

  const sessionActiva = await resolveCajaSession({
    client,
    idSucursal,
    idUsuario: userId,
    idSesionCaja: idSesionCajaRequested,
    isSuperAdmin: Boolean(sucursalScope?.isSuperAdmin)
  });
  perf?.add?.('auth_sesion_caja_ms', sesionCajaStart);
  perf?.add?.('auth_caja_sesion_combined_ms', cajaSesionCombinedStart);
  if (!sessionActiva.ok) {
    return {
      ok: false,
      status:
        sessionActiva.reason === 'SESSION_NOT_FOUND'
          ? 404
          : ['SESSION_NOT_OPEN', 'OPEN_STATE_NOT_FOUND', 'CAJA_NOT_ACTIVE'].includes(sessionActiva.reason)
          ? 409
          : 403,
      body: { error: true, message: sessionActiva.reason === 'SESSION_SCOPE_MISMATCH' ? 'La caja seleccionada no pertenece a la sucursal de la venta.' : 'Debe abrir o tener una sesi�n de caja activa permitida para procesar ventas.', code: sessionActiva.reason || 'NO_ACTIVE_SESSION' }
    };
  }
  const { id_caja: idCaja, id_sesion_caja: idSesionCaja } = sessionActiva.data;
  const kitchenLines = finalizedLines.filter((line) => line.requiere_cocina);
  // Fase 4.2: toda venta nueva debe pasar por cocina, incluyendo PRODUCTO directo.
  const requiresPedido = finalizedLines.length > 0;
  const pedidoLines = finalizedLines;
  const directLines = [];
  const pedidoSubtotal = roundMoney(
    pedidoLines.reduce((sum, line) => sum + line.total_linea, 0)
  );
  const pedidoIsv = 0;
  const pedidoTotal = pedidoSubtotal;

  let idEstadoPedido = null;
  if (requiresPedido) {
    idEstadoPedido = requestedEstadoPedido || ventaContext.estadoPedidoEnCocina;

    if (!idEstadoPedido) {
      return {
        ok: false,
        status: 409,
        body: {
          error: true,
          message:
            'No existe el estado EN_COCINA en estados_pedido. Aplica el seed del KDS antes de facturar items de cocina.'
        }
      };
    }
  }

  perf?.add?.('auth_context_ms', cajaContextStart);
  perf?.add?.('auth_caja_ms', cajaContextStart);

  return {
    ok: true,
    data: {
      metodo_pago: metodoPago.nombre,
      id_metodo_pago: Number(metodoPago.id_metodo_pago),
      metodo_pago_codigo: metodoPago.codigo,
      metodo_pago_afecta_efectivo: metodoPagoAfectaEfectivo,
      descripcion_pedido: buildKitchenDescriptionSummary(
        kitchenLines,
        typeof body.descripcion_pedido === 'string' ? body.descripcion_pedido : null
      ),
      descripcion_envio:
        typeof body.descripcion_envio === 'string' ? body.descripcion_envio.trim() : null,
      descuento: descuentoTotal,
      descuento_lineas: descuentoLineasTotal,
      descuento_global: descuentoGlobalTotal,
      id_descuento_catalogo: appliedDiscountCatalog?.id_descuento_catalogo ?? null,
      subtotal_bruto: subtotalBruto,
      subtotal,
      isv,
      total,
      efectivo_entregado: metodoPagoAfectaEfectivo ? efectivoEntregado : null,
      cambio: metodoPagoAfectaEfectivo ? roundMoney(efectivoEntregado - total) : 0,
      referencia_pago: metodoPagoAfectaEfectivo ? null : referenciaPagoInput,
      id_caja: idCaja,
      id_sesion_caja: idSesionCaja,
      id_cliente: idCliente,
      id_sucursal: idSucursal,
      id_estado_pedido: idEstadoPedido,
      id_usuario: userId,
      all_lines: finalizedLines,
      direct_lines: directLines,
      pedido_lines: pedidoLines,
      requires_pedido: requiresPedido,
      pedido_subtotal: pedidoSubtotal,
      pedido_isv: pedidoIsv,
      pedido_total: pedidoTotal
    }
  };
};

const normalizeDescuentoObjetivosPayload = (payload, alcance) => {
  const objetivos = isPlainObject(payload?.objetivos) ? payload.objetivos : {};
  const productos = coercePositiveIntArray(objetivos.productos);
  const recetas = coercePositiveIntArray(objetivos.recetas);
  const combos = coercePositiveIntArray(objetivos.combos);
  const legacyProducto = parseOptionalPositiveInt(payload?.id_producto);
  const legacyReceta = parseOptionalPositiveInt(payload?.id_receta);
  const legacyCombo = parseOptionalPositiveInt(payload?.id_combo);

  if (alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO && productos.length === 0 && legacyProducto) {
    productos.push(legacyProducto);
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.RECETA && recetas.length === 0 && legacyReceta) {
    recetas.push(legacyReceta);
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.COMBO && combos.length === 0 && legacyCombo) {
    combos.push(legacyCombo);
  }

  return {
    productos: alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO ? coercePositiveIntArray(productos) : [],
    recetas: alcance === DESCUENTO_ALCANCE_KEYS.RECETA ? coercePositiveIntArray(recetas) : [],
    combos: alcance === DESCUENTO_ALCANCE_KEYS.COMBO ? coercePositiveIntArray(combos) : []
  };
};

const validateDescuentoCatalogoPayload = async (client, payload, options = {}) => {
  const mode = options.mode || 'create';
  if (!isPlainObject(payload)) {
    return { ok: false, status: 400, message: 'Payload invalido para descuentos_catalogos.' };
  }

  const nombre = String(payload.nombre_descuento || '').trim();
  const descripcion =
    payload.descripcion === undefined || payload.descripcion === null
      ? null
      : String(payload.descripcion).trim() || null;
  const valorDescuento = parseNonNegativeNumber(payload.valor_descuento);
  const tipoResult = parseRequiredPositiveInt(payload.id_tipo_descuento, 'id_tipo_descuento');
  const alcance = normalizeDescuentoAlcance(payload.alcance || DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA);
  const idSucursal = parseOptionalPositiveInt(payload.id_sucursal);
  const fechaInicio = payload.fecha_inicio ? String(payload.fecha_inicio).trim() : null;
  const fechaFin = payload.fecha_fin ? String(payload.fecha_fin).trim() : null;

  if (!nombre) {
    return { ok: false, status: 400, message: 'nombre_descuento es obligatorio.' };
  }
  if (valorDescuento === null || valorDescuento <= 0) {
    return { ok: false, status: 400, message: 'valor_descuento debe ser mayor a 0.' };
  }
  if (!tipoResult.ok) {
    return { ok: false, status: 400, message: tipoResult.message };
  }
  if (!alcance) {
    return { ok: false, status: 400, message: 'alcance invalido.' };
  }

  const objetivos = normalizeDescuentoObjetivosPayload(payload, alcance);
  const objetivosCount = objetivos.productos.length + objetivos.recetas.length + objetivos.combos.length;
  if (alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO && objetivos.productos.length === 0) {
    return { ok: false, status: 400, message: 'Selecciona al menos un producto para alcance PRODUCTO.' };
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.RECETA && objetivos.recetas.length === 0) {
    return { ok: false, status: 400, message: 'Selecciona al menos una receta para alcance RECETA.' };
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.COMBO && objetivos.combos.length === 0) {
    return { ok: false, status: 400, message: 'Selecciona al menos un combo para alcance COMBO.' };
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA && objetivosCount > 0) {
    return { ok: false, status: 400, message: 'FACTURA_COMPLETA no permite objetivos de producto, receta o combo.' };
  }
  if (fechaInicio && parseOptionalDateTime(fechaInicio) === null) {
    return { ok: false, status: 400, message: 'fecha_inicio invalida.' };
  }
  if (fechaFin && parseOptionalDateTime(fechaFin) === null) {
    return { ok: false, status: 400, message: 'fecha_fin invalida.' };
  }
  if (fechaInicio && fechaFin && new Date(fechaFin) < new Date(fechaInicio)) {
    return { ok: false, status: 400, message: 'fecha_fin no puede ser menor a fecha_inicio.' };
  }

  const tipoResultRow = await client.query(
    `
      SELECT id_tipo_descuento, estado
      FROM tipo_descuentos
      WHERE id_tipo_descuento = $1
      LIMIT 1
    `,
    [tipoResult.value]
  );

  if (tipoResultRow.rowCount === 0) {
    return { ok: false, status: 400, message: 'id_tipo_descuento no existe.' };
  }

  if (!parseBooleanish(tipoResultRow.rows[0].estado)) {
    return { ok: false, status: 409, message: 'El tipo de descuento seleccionado esta inactivo.' };
  }

  const estadoParsed = parseBooleanInput(payload.estado ?? true);
  if (!estadoParsed.ok) {
    return { ok: false, status: 400, message: 'estado debe ser booleano.' };
  }

  return {
    ok: true,
    data: {
      nombre_descuento: nombre,
      descripcion,
      valor_descuento: valorDescuento,
      alcance,
      id_sucursal: idSucursal,
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      id_tipo_descuento: tipoResult.value,
      estado: estadoParsed.value,
      objetivos,
      mode
    }
  };
};

const buildDescuentoCatalogoRpcPayload = ({ idDescuentoCatalogo = null, data, idUsuario }) => ({
  id_descuento_catalogo: idDescuentoCatalogo || null,
  nombre_descuento: data.nombre_descuento,
  descripcion: data.descripcion,
  valor_descuento: data.valor_descuento,
  id_tipo_descuento: data.id_tipo_descuento,
  estado: data.estado,
  id_usuario: idUsuario || null,
  alcance: data.alcance,
  id_sucursal: data.id_sucursal,
  fecha_inicio: data.fecha_inicio,
  fecha_fin: data.fecha_fin,
  objetivos: data.objetivos || { productos: [], recetas: [], combos: [] }
});

const upsertDescuentoCatalogoConObjetivos = async ({ client, payload, actor }) => {
  const result = await client.query(
    'SELECT public.upsert_descuento_catalogo_con_objetivos($1::jsonb, $2::jsonb) AS response',
    [JSON.stringify(payload), JSON.stringify(actor)]
  );
  const response = result.rows?.[0]?.response || {};
  if (response?.error) {
    return {
      ok: false,
      status: Number(response.status || response.statusCode || 400) || 400,
      body: {
        error: true,
        code: response.code || 'DESCUENTO_CATALOGO_UPSERT_ERROR',
        message: response.message || 'No se pudo guardar el descuento de catalogo.'
      }
    };
  }
  return { ok: true, response };
};

const buildDescuentoObjetivoLabel = (row) => {
  const alcance = normalizeDescuentoAlcance(row?.alcance) || DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA;
  if (alcance === DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA) return 'Factura completa';

  const objetivos = row?.objetivos || {};
  const key = alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO
    ? 'productos'
    : alcance === DESCUENTO_ALCANCE_KEYS.RECETA
      ? 'recetas'
      : 'combos';
  const rows = parseJsonArrayValue(objetivos[key]);
  if (rows.length === 1) {
    return rows[0]?.nombre_producto || rows[0]?.nombre_receta || rows[0]?.nombre_combo || `${alcance} seleccionado`;
  }
  if (rows.length > 1) {
    const label = alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO ? 'productos' : alcance === DESCUENTO_ALCANCE_KEYS.RECETA ? 'recetas' : 'combos';
    return `${rows.length} ${label} seleccionados`;
  }
  return '--';
};

const normalizeDescuentoCatalogoRow = (row) => {
  const productos = parseJsonArrayValue(row?.productos);
  const recetas = parseJsonArrayValue(row?.recetas);
  const combos = parseJsonArrayValue(row?.combos);
  const objetivos = { productos, recetas, combos };
  const normalized = {
    ...row,
    objetivos,
    objetivos_count: {
      productos: productos.length,
      recetas: recetas.length,
      combos: combos.length,
      total: productos.length + recetas.length + combos.length
    }
  };
  normalized.objetivo = buildDescuentoObjetivoLabel(normalized);
  return normalized;
};

router.get('/ventas/catalogos/categorias', listCategoriasCatalogoHandler);
router.get('/ventas/catalogos/extras-permitidos', listExtrasPermitidosCatalogoHandler);
router.get('/ventas/catalogos/productos', listProductosCatalogoHandler);
router.get('/ventas/catalogos/clientes', listClientesCatalogoHandler);
router.get('/ventas/catalogos/combos', listCombosCatalogoHandler);
router.get('/ventas/catalogos/recetas', listRecetasCatalogoHandler);

router.get('/ventas/catalogos/tipos-descuento', listTiposDescuentoCatalogoHandler);

router.get('/ventas/catalogos/tipo-departamento', listTipoDepartamentoCatalogoHandler);

router.get('/ventas/catalogos/descuentos', checkPermission(VENTAS_DESCUENTOS_PERMISSIONS), listDescuentosCatalogoHandler);

router.get('/ventas/descuentos-catalogos', checkPermission(VENTAS_DESCUENTOS_PERMISSIONS), async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const params = [];
    let whereSql = '';

    if (q) {
      params.push(`%${q}%`);
      whereSql = `
        WHERE (
          dc.id_descuento_catalogo::text ILIKE $1
          OR COALESCE(dc.nombre_descuento, '') ILIKE $1
          OR COALESCE(dc.descripcion, '') ILIKE $1
          OR COALESCE(td.nombre_tipo_descuento, '') ILIKE $1
        )
      `;
    }

    const result = await pool.query(
      `
        SELECT
          dc.id_descuento_catalogo,
          dc.nombre_descuento,
          dc.descripcion,
          dc.valor_descuento,
          dc.alcance,
          dc.id_producto,
          dc.id_receta,
          dc.id_combo,
          dc.id_sucursal,
          dc.fecha_inicio,
          dc.fecha_fin,
          dc.id_tipo_descuento,
          td.nombre_tipo_descuento,
          p.nombre_producto,
          r.nombre_receta,
          COALESCE(cb.nombre_combo, cb.descripcion) AS nombre_combo,
          COALESCE(objp.productos, '[]'::jsonb) AS productos,
          COALESCE(objr.recetas, '[]'::jsonb) AS recetas,
          COALESCE(objc.combos, '[]'::jsonb) AS combos,
          s.nombre_sucursal,
          dc.estado,
          dc.fecha_creacion,
          dc.id_usuario
        FROM descuentos_catalogos dc
        INNER JOIN tipo_descuentos td ON td.id_tipo_descuento = dc.id_tipo_descuento
        LEFT JOIN productos p ON p.id_producto = dc.id_producto
        LEFT JOIN recetas r ON r.id_receta = dc.id_receta
        LEFT JOIN combos cb ON cb.id_combo = dc.id_combo
        LEFT JOIN sucursales s ON s.id_sucursal = dc.id_sucursal
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id_producto', x.id_producto, 'nombre_producto', x.nombre_producto) ORDER BY x.nombre_producto), '[]'::jsonb) AS productos
          FROM (
            SELECT DISTINCT p2.id_producto, p2.nombre_producto
            FROM descuentos_catalogos_productos rel
            INNER JOIN productos p2 ON p2.id_producto = rel.id_producto
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT p2.id_producto, p2.nombre_producto
            FROM productos p2
            WHERE p2.id_producto = dc.id_producto
              AND NOT EXISTS (SELECT 1 FROM descuentos_catalogos_productos rel WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo)
          ) x
        ) objp ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id_receta', x.id_receta, 'nombre_receta', x.nombre_receta) ORDER BY x.nombre_receta), '[]'::jsonb) AS recetas
          FROM (
            SELECT DISTINCT r2.id_receta, r2.nombre_receta
            FROM descuentos_catalogos_recetas rel
            INNER JOIN recetas r2 ON r2.id_receta = rel.id_receta
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT r2.id_receta, r2.nombre_receta
            FROM recetas r2
            WHERE r2.id_receta = dc.id_receta
              AND NOT EXISTS (SELECT 1 FROM descuentos_catalogos_recetas rel WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo)
          ) x
        ) objr ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id_combo', x.id_combo, 'nombre_combo', x.nombre_combo) ORDER BY x.nombre_combo), '[]'::jsonb) AS combos
          FROM (
            SELECT DISTINCT cb2.id_combo, COALESCE(cb2.nombre_combo, cb2.descripcion) AS nombre_combo
            FROM descuentos_catalogos_combos rel
            INNER JOIN combos cb2 ON cb2.id_combo = rel.id_combo
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT cb2.id_combo, COALESCE(cb2.nombre_combo, cb2.descripcion) AS nombre_combo
            FROM combos cb2
            WHERE cb2.id_combo = dc.id_combo
              AND NOT EXISTS (SELECT 1 FROM descuentos_catalogos_combos rel WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo)
          ) x
        ) objc ON true
        ${whereSql}
        ORDER BY dc.id_descuento_catalogo DESC
      `,
      params
    );

    res.status(200).json((result.rows || []).map(normalizeDescuentoCatalogoRow));
  } catch (err) {
    console.error('Error al listar descuentos_catalogos:', err.message);
    sendVentasInternalError(res);
  }
});

router.get('/ventas/descuentos-catalogos/:id', checkPermission(VENTAS_DESCUENTOS_PERMISSIONS), async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: true, message: 'ID de descuento catalogo invalido.' });
    }

    const result = await pool.query(
      `
        SELECT
          dc.id_descuento_catalogo,
          dc.nombre_descuento,
          dc.descripcion,
          dc.valor_descuento,
          dc.alcance,
          dc.id_producto,
          dc.id_receta,
          dc.id_combo,
          dc.id_sucursal,
          dc.fecha_inicio,
          dc.fecha_fin,
          dc.id_tipo_descuento,
          td.nombre_tipo_descuento,
          p.nombre_producto,
          r.nombre_receta,
          COALESCE(cb.nombre_combo, cb.descripcion) AS nombre_combo,
          COALESCE(objp.productos, '[]'::jsonb) AS productos,
          COALESCE(objr.recetas, '[]'::jsonb) AS recetas,
          COALESCE(objc.combos, '[]'::jsonb) AS combos,
          s.nombre_sucursal,
          dc.estado,
          dc.fecha_creacion,
          dc.id_usuario
        FROM descuentos_catalogos dc
        INNER JOIN tipo_descuentos td ON td.id_tipo_descuento = dc.id_tipo_descuento
        LEFT JOIN productos p ON p.id_producto = dc.id_producto
        LEFT JOIN recetas r ON r.id_receta = dc.id_receta
        LEFT JOIN combos cb ON cb.id_combo = dc.id_combo
        LEFT JOIN sucursales s ON s.id_sucursal = dc.id_sucursal
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id_producto', x.id_producto, 'nombre_producto', x.nombre_producto) ORDER BY x.nombre_producto), '[]'::jsonb) AS productos
          FROM (
            SELECT DISTINCT p2.id_producto, p2.nombre_producto
            FROM descuentos_catalogos_productos rel
            INNER JOIN productos p2 ON p2.id_producto = rel.id_producto
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT p2.id_producto, p2.nombre_producto
            FROM productos p2
            WHERE p2.id_producto = dc.id_producto
              AND NOT EXISTS (SELECT 1 FROM descuentos_catalogos_productos rel WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo)
          ) x
        ) objp ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id_receta', x.id_receta, 'nombre_receta', x.nombre_receta) ORDER BY x.nombre_receta), '[]'::jsonb) AS recetas
          FROM (
            SELECT DISTINCT r2.id_receta, r2.nombre_receta
            FROM descuentos_catalogos_recetas rel
            INNER JOIN recetas r2 ON r2.id_receta = rel.id_receta
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT r2.id_receta, r2.nombre_receta
            FROM recetas r2
            WHERE r2.id_receta = dc.id_receta
              AND NOT EXISTS (SELECT 1 FROM descuentos_catalogos_recetas rel WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo)
          ) x
        ) objr ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id_combo', x.id_combo, 'nombre_combo', x.nombre_combo) ORDER BY x.nombre_combo), '[]'::jsonb) AS combos
          FROM (
            SELECT DISTINCT cb2.id_combo, COALESCE(cb2.nombre_combo, cb2.descripcion) AS nombre_combo
            FROM descuentos_catalogos_combos rel
            INNER JOIN combos cb2 ON cb2.id_combo = rel.id_combo
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT cb2.id_combo, COALESCE(cb2.nombre_combo, cb2.descripcion) AS nombre_combo
            FROM combos cb2
            WHERE cb2.id_combo = dc.id_combo
              AND NOT EXISTS (SELECT 1 FROM descuentos_catalogos_combos rel WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo)
          ) x
        ) objc ON true
        WHERE dc.id_descuento_catalogo = $1
        LIMIT 1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Descuento de catalogo no encontrado.' });
    }

    return res.status(200).json(normalizeDescuentoCatalogoRow(result.rows[0]));
  } catch (err) {
    console.error('Error al obtener descuento_catalogo por id:', err.message);
    return sendVentasInternalError(res);
  }
});

router.post('/ventas/descuentos-catalogos', checkPermission(VENTAS_DESCUENTOS_WRITE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const validated = await validateDescuentoCatalogoPayload(client, req.body, { mode: 'create' });
    if (!validated.ok) {
      return res.status(validated.status).json({ error: true, message: validated.message });
    }
    const scope = await resolveRequestUserSucursalScope(req, client);
    const actorUserId = parseOptionalPositiveInt(scope.idUsuario) || parseOptionalPositiveInt(req.user?.id_usuario);
    const rpcPayload = buildDescuentoCatalogoRpcPayload({
      data: validated.data,
      idUsuario: actorUserId
    });
    const rpcResult = await upsertDescuentoCatalogoConObjetivos({
      client,
      payload: rpcPayload,
      actor: { id_usuario: actorUserId || null }
    });
    if (!rpcResult.ok) return res.status(rpcResult.status).json(rpcResult.body);
    const response = rpcResult.response || {};
    return res.status(201).json({
      message: 'Descuento de catalogo creado exitosamente.',
      id_descuento_catalogo: response.id_descuento_catalogo || response.id || response.data?.id_descuento_catalogo || null,
      response
    });
  } catch (err) {
    console.error('Error al crear descuentos_catalogos:', err.message);
    return sendVentasInternalError(res);
  } finally {
    client.release();
  }
});

router.put('/ventas/descuentos-catalogos/:id', checkPermission(VENTAS_DESCUENTOS_WRITE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: true, message: 'ID de descuento catalogo invalido.' });
    }

    const existing = await client.query(
      'SELECT id_descuento_catalogo FROM descuentos_catalogos WHERE id_descuento_catalogo = $1 LIMIT 1',
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Descuento de catalogo no encontrado.' });
    }

    const validated = await validateDescuentoCatalogoPayload(client, req.body, { mode: 'update' });
    if (!validated.ok) {
      return res.status(validated.status).json({ error: true, message: validated.message });
    }
    const scope = await resolveRequestUserSucursalScope(req, client);
    const actorUserId = parseOptionalPositiveInt(scope.idUsuario) || parseOptionalPositiveInt(req.user?.id_usuario);
    const rpcPayload = buildDescuentoCatalogoRpcPayload({
      idDescuentoCatalogo: id,
      data: validated.data,
      idUsuario: actorUserId
    });
    const rpcResult = await upsertDescuentoCatalogoConObjetivos({
      client,
      payload: rpcPayload,
      actor: { id_usuario: actorUserId || null }
    });
    if (!rpcResult.ok) return res.status(rpcResult.status).json(rpcResult.body);
    return res.status(200).json({
      message: 'Descuento de catalogo actualizado correctamente.',
      id_descuento_catalogo: id,
      response: rpcResult.response
    });
  } catch (err) {
    console.error('Error al actualizar descuentos_catalogos:', err.message);
    return sendVentasInternalError(res);
  } finally {
    client.release();
  }
});

router.patch('/ventas/descuentos-catalogos/:id/estado', checkPermission(VENTAS_DESCUENTOS_WRITE_PERMISSIONS), async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: true, message: 'ID de descuento catalogo invalido.' });
    }

    const parsedEstado = parseBooleanInput(req.body?.estado);
    if (!parsedEstado.ok) {
      return res.status(400).json({ error: true, message: 'estado debe ser booleano.' });
    }

    const result = await pool.query(
      `
        UPDATE descuentos_catalogos
        SET estado = $1
        WHERE id_descuento_catalogo = $2
        RETURNING id_descuento_catalogo
      `,
      [parsedEstado.value, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Descuento de catalogo no encontrado.' });
    }

    return res.status(200).json({
      message: `Descuento de catalogo ${parsedEstado.value ? 'activado' : 'inactivado'} correctamente.`,
      id_descuento_catalogo: result.rows[0].id_descuento_catalogo
    });
  } catch (err) {
    console.error('Error al cambiar estado de descuentos_catalogos:', err.message);
    return sendVentasInternalError(res);
  }
});

router.get('/ventas', checkPermission(['VENTAS_VER']), async (req, res) => {
  try {
    const filters = [];
    const params = [];
    const shouldIncludeMetric = (value) => {
      const normalized = String(value ?? '').trim().toLowerCase();
      return !['0', 'false', 'no', 'off'].includes(normalized);
    };
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replaceAll('$IDX', `$${params.length}`));
    };

    const page = parseBoundedPositiveInt(req.query.page, {
      fallback: VENTAS_DEFAULT_PAGE,
      min: 1
    });
    const pageSize = parseBoundedPositiveInt(req.query.pageSize, {
      fallback: VENTAS_DEFAULT_PAGE_SIZE,
      min: 1,
      max: VENTAS_MAX_PAGE_SIZE
    });
    const offset = (page - 1) * pageSize;
    const includeSummary = shouldIncludeMetric(req.query.includeSummary ?? req.query.include_summary);
    const includePaginationTotals = shouldIncludeMetric(
      req.query.includePaginationTotals ?? req.query.include_pagination_totals
    );

    const scope = await resolveVentasHistoryScope(req);
    if (!scope.allowedSucursalIds.length) {
      return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
    }

    const searchFromQ = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const searchFromSearch = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const search = searchFromQ || searchFromSearch || '';
    const codigoVenta = typeof req.query.codigoVenta === 'string' ? req.query.codigoVenta.trim() : '';
    const metodoPago = typeof req.query.metodoPago === 'string' ? req.query.metodoPago.trim() : '';
    const cliente = typeof req.query.cliente === 'string' ? req.query.cliente.trim() : '';
    const estado = typeof req.query.estado === 'string' ? req.query.estado.trim() : '';

    const fechaDesde = parseOptionalDateInput(req.query.fechaDesde);
    const fechaHasta = parseOptionalDateInput(req.query.fechaHasta);
    if (fechaDesde === '__INVALID_DATE__' || fechaHasta === '__INVALID_DATE__') {
      return res.status(400).json({
        error: true,
        code: 'VENTAS_FECHA_INVALIDA',
        message: 'fechaDesde y fechaHasta deben tener formato YYYY-MM-DD.'
      });
    }

    const idEstadoPedido = parseOptionalPositiveInt(req.query.id_estado_pedido);
    const idCliente = parseOptionalPositiveInt(req.query.id_cliente);
    const idSucursalRaw = req.query.idSucursal ?? req.query.id_sucursal;
    const idSucursalRequested = parseOptionalPositiveInt(idSucursalRaw);

    let idSucursalEffective = null;
    if (scope.isSuperAdmin) {
      idSucursalEffective = idSucursalRequested;
      if (idSucursalEffective && !scope.allowedSucursalIds.includes(idSucursalEffective)) {
        return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
      }
    } else {
      idSucursalEffective = scope.userSucursalId;
      if (!idSucursalEffective) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal vinculada.' });
      }
    }

    if (idSucursalEffective) {
      pushFilter('COALESCE(p.id_sucursal, f.id_sucursal) = $IDX', idSucursalEffective);
    } else {
      pushFilter('COALESCE(p.id_sucursal, f.id_sucursal) = ANY($IDX::int[])', scope.allowedSucursalIds);
    }

    if (scope.limitedToLast72Hours) {
      filters.push(`f.fecha_hora_facturacion IS NOT NULL`);
      filters.push(`f.fecha_hora_facturacion >= ${VENTAS_LIMIT_72H_CUTOFF_SQL}`);
    }

    if (search) {
      const qLike = `%${search}%`;
      pushFilter(
        `
          (
            f.id_factura::text ILIKE $IDX
            OR COALESCE(f.id_pedido::text, '') ILIKE $IDX
            OR COALESCE(f.codigo_venta, '') ILIKE $IDX
            OR COALESCE(ep.descripcion, '${VENTA_DIRECTA_LABEL}') ILIKE $IDX
            OR COALESCE(s.nombre_sucursal, '') ILIKE $IDX
            OR COALESCE(u.nombre_usuario, '') ILIKE $IDX
            OR COALESCE(NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''), emp.nombre_empresa, 'Consumidor final') ILIKE $IDX
          )
        `,
        qLike
      );
    }

    if (codigoVenta) {
      pushFilter('COALESCE(f.codigo_venta, \'\') ILIKE $IDX', `%${codigoVenta}%`);
    }

    if (metodoPago) {
      pushFilter(
        `
          EXISTS (
            SELECT 1
            FROM facturas_cobros fc_q
            INNER JOIN cat_metodos_pago cmp_q
              ON cmp_q.id_metodo_pago = fc_q.id_metodo_pago
            WHERE fc_q.id_factura = f.id_factura
              AND (
                cmp_q.nombre ILIKE $IDX
                OR COALESCE(cmp_q.codigo, '') ILIKE $IDX
              )
          )
        `,
        `%${metodoPago}%`
      );
    }

    if (cliente) {
      pushFilter(
        `
          COALESCE(
            NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
            emp.nombre_empresa,
            'Consumidor final'
          ) ILIKE $IDX
        `,
        `%${cliente}%`
      );
    }

    if (estado) {
      const estadoFilter = getVentaEstadoFilter(estado);
      if (estadoFilter) {
        if (Object.prototype.hasOwnProperty.call(estadoFilter, 'value')) {
          pushFilter(estadoFilter.fragment, estadoFilter.value);
        } else {
          filters.push(estadoFilter.fragment);
        }
      } else {
        pushFilter('COALESCE(ep.descripcion, $IDX) ILIKE $IDX', `%${estado}%`);
      }
    }

    if (idEstadoPedido) {
      pushFilter('p.id_estado_pedido = $IDX', idEstadoPedido);
    }

    if (idCliente) {
      pushFilter('COALESCE(p.id_cliente, f.id_cliente) = $IDX', idCliente);
    }

    if (fechaDesde) {
      pushFilter('(f.fecha_hora_facturacion)::date >= $IDX::date', fechaDesde);
    }
    if (fechaHasta) {
      pushFilter('(f.fecha_hora_facturacion)::date <= $IDX::date', fechaHasta);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const baseJoinClause = `
      FROM facturas f
      LEFT JOIN pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN sucursales s ON s.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
      LEFT JOIN direcciones ds ON ds.id_direccion = s.id_direccion
      LEFT JOIN telefonos ts ON ts.id_telefono = s.id_telefono
      LEFT JOIN correos csuc ON csuc.id_correo = s.id_correo
      LEFT JOIN clientes c ON c.id_cliente = COALESCE(p.id_cliente, f.id_cliente)
      LEFT JOIN personas per ON per.id_persona = c.id_persona
      LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
      LEFT JOIN usuarios u ON u.id_usuario = COALESCE(p.id_usuario, f.id_usuario)
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      ${baseJoinClause}
      ${whereClause}
    `;

    const summaryQuery = `
      SELECT
        COUNT(*)::int AS ventas,
        COALESCE(
          SUM(
            COALESCE(
              df_info.subtotal_neto,
              p.total,
              0
            )
          ),
          0
        )::numeric(14,2) AS total_vendido,
        COALESCE(
          SUM(
            CASE
              WHEN p.id_pedido IS NULL THEN 1
              WHEN LOWER(COALESCE(ep.descripcion, '')) IN (
                'completada',
                'completado',
                'finalizada',
                'finalizado',
                'pagada',
                'pagado',
                'cerrada',
                'cerrado',
                'lista',
                'listo'
              ) THEN 1
              ELSE 0
            END
          ),
          0
        )::int AS completadas
      ${baseJoinClause}
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(df.total_detalle), 0)::numeric(12,2) AS subtotal_neto
        FROM detalle_facturas df
        WHERE df.id_factura = f.id_factura
      ) df_info ON true
      ${whereClause}
    `;

    const dataQuery = `
      SELECT
        f.id_factura,
        f.codigo_venta,
        f.fecha_operacion,
        f.id_pedido,
        p.descripcion_pedido,
        p.descripcion_envio,
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion) AS fecha_hora_pedido,
        COALESCE(p.sub_total, df_info.subtotal_neto, 0) AS sub_total,
        0::numeric(12,2) AS isv,
        COALESCE(
          df_info.subtotal_neto,
          p.total,
          0
        ) AS total,
        p.id_estado_pedido,
        CASE
          WHEN p.id_pedido IS NULL THEN '${VENTA_DIRECTA_LABEL}'
          ELSE ep.descripcion
        END AS estado_pedido,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        s.nombre_sucursal,
        ds.direccion AS sucursal_direccion,
        ts.telefono AS sucursal_telefono,
        csuc.direccion_correo AS sucursal_correo,
        COALESCE(p.id_cliente, f.id_cliente) AS id_cliente,
        COALESCE(
          NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
          emp.nombre_empresa,
          'Consumidor final'
        ) AS cliente_nombre,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        u.nombre_usuario,
        f.id_caja,
        f.efectivo_entregado,
        f.cambio,
        f.fecha_hora_facturacion,
        0::numeric(12,2) AS isv_15,
        0::numeric(12,2) AS isv_18,
        fc_info.metodo_pago,
        CASE
          WHEN f.id_pedido IS NOT NULL THEN COALESCE(dp_info.total_items, 0)
          ELSE COALESCE(df_info.total_items, 0)
        END AS total_items,
        COALESCE(df_info.descuento_total, 0) AS descuento_total,
        COALESCE(cuenta_info.divisiones_count, 0)::int AS cuenta_dividida_divisiones,
        COALESCE(rev_info.reversiones_count, 0) AS reversiones_count,
        COALESCE(rev_info.monto_reversado_total, 0) AS monto_reversado_total
      ${baseJoinClause}
      LEFT JOIN LATERAL (
        SELECT
          SUM(COALESCE(df.cantidad, 0))::int AS total_items,
          COALESCE(SUM(df.total_detalle), 0)::numeric(12,2) AS subtotal_neto,
          COALESCE(SUM(d.monto_descuento), 0)::numeric(12,2) AS descuento_total
        FROM detalle_facturas df
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = f.id_factura
      ) df_info ON true
      LEFT JOIN LATERAL (
        SELECT
          STRING_AGG(DISTINCT cmp.nombre, ', ' ORDER BY cmp.nombre) AS metodo_pago
        FROM facturas_cobros fc
        INNER JOIN cat_metodos_pago cmp
          ON cmp.id_metodo_pago = fc.id_metodo_pago
          WHERE fc.id_factura = f.id_factura
      ) fc_info ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS divisiones_count
        FROM public.ventas_cuenta_divisiones vcd
        WHERE vcd.id_pedido = f.id_pedido
      ) cuenta_info ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS reversiones_count,
          COALESCE(SUM(fr.monto_reversado), 0)::numeric(12,2) AS monto_reversado_total
        FROM public.facturas_reversiones fr
        WHERE fr.id_factura_original = f.id_factura
      ) rev_info ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN dp.id_producto IS NOT NULL THEN GREATEST(
                  1,
                  ROUND(
                    COALESCE(NULLIF(dp.sub_total_pedido, 0), dp.total_pedido, 0)
                    / NULLIF(prod_dp.precio, 0)
                  )::int
                )
                WHEN dp.id_combo IS NOT NULL THEN GREATEST(
                  1,
                  ROUND(
                    COALESCE(NULLIF(dp.sub_total_pedido, 0), dp.total_pedido, 0)
                    / NULLIF(combo_dp.precio, 0)
                  )::int
                )
                WHEN dp.id_receta IS NOT NULL THEN GREATEST(
                  1,
                  ROUND(
                    COALESCE(NULLIF(dp.sub_total_pedido, 0), dp.total_pedido, 0)
                    / NULLIF(rec_dp.precio, 0)
                  )::int
                )
                ELSE 1
              END
            ),
            0
          )::int AS total_items
        FROM detalle_pedido dp
        LEFT JOIN productos prod_dp ON prod_dp.id_producto = dp.id_producto
        LEFT JOIN combos combo_dp ON combo_dp.id_combo = dp.id_combo
        LEFT JOIN recetas rec_dp ON rec_dp.id_receta = dp.id_receta
        WHERE dp.id_pedido = f.id_pedido
          AND COALESCE(dp.estado, true) = true
      ) dp_info ON true
      ${whereClause}
      ORDER BY f.fecha_hora_facturacion DESC, f.id_factura DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const queryParams = [...params, pageSize, offset];
    const [countResult, summaryResult, result] = await Promise.all([
      includePaginationTotals ? pool.query(countQuery, params) : Promise.resolve(null),
      includeSummary ? pool.query(summaryQuery, params) : Promise.resolve(null),
      pool.query(dataQuery, queryParams)
    ]);
    const total = includePaginationTotals
      ? Number.parseInt(String(countResult?.rows?.[0]?.total ?? '0'), 10) || 0
      : null;
    const totalPages = includePaginationTotals
      ? (total > 0 ? Math.ceil(total / pageSize) : 1)
      : null;
    const summaryRow = summaryResult?.rows?.[0] || {};
    const summaryVentas = includeSummary
      ? Number.parseInt(String(summaryRow.ventas ?? '0'), 10) || 0
      : null;
    const summaryTotalVendido = includeSummary ? roundMoney(summaryRow.total_vendido) : null;
    const summaryCompletadas = includeSummary
      ? Number.parseInt(String(summaryRow.completadas ?? '0'), 10) || 0
      : null;
    const summaryPendientes = includeSummary ? Math.max(summaryVentas - summaryCompletadas, 0) : null;
    const summaryTicketPromedio = includeSummary && summaryVentas > 0
      ? roundMoney(summaryTotalVendido / summaryVentas)
      : includeSummary
        ? 0
        : null;

    const data = result.rows.map((row) => ({
      ...row,
      numero_venta: resolveVentaNumero(row),
      metodo_pago: row.metodo_pago || null
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: includePaginationTotals ? page < totalPages : null,
        hasPreviousPage: page > 1
      },
      summary: includeSummary
        ? {
          ventas: summaryVentas,
          totalVendido: summaryTotalVendido,
          ticketPromedio: summaryTicketPromedio,
          completadas: summaryCompletadas,
          pendientes: summaryPendientes
        }
        : null,
      filters: {
        scope: {
          canSelectSucursal: scope.isSuperAdmin,
          selectedSucursalId: idSucursalEffective,
          userSucursalId: scope.userSucursalId,
          limitedByRole: scope.limitedToLast72Hours,
          limitedToLast72Hours: scope.limitedToLast72Hours,
          allowedSucursalIds: scope.allowedSucursalIds
        }
      }
    });
  } catch (err) {
    console.error('Error al listar ventas:', err);
    sendVentasInternalError(res);
  }
});

router.get(
  '/ventas/dashboard-resumen',
  checkPermission([
    'DASHBOARD_VER',
    'VENTAS_VER',
    'COCINA_VER',
    'SUCURSALES_VER',
    'INVENTARIO_PRODUCTOS_VER',
    'INVENTARIO_INSUMOS_VER'
  ]),
  async (req, res) => {
    try {
      const scope = await resolveVentasHistoryScope(req);
      if (!scope.allowedSucursalIds.length) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }

      const fechaDesde = parseOptionalDateInput(req.query.fechaDesde);
      const fechaHasta = parseOptionalDateInput(req.query.fechaHasta);
      if (fechaDesde === '__INVALID_DATE__' || fechaHasta === '__INVALID_DATE__') {
        return res.status(400).json({
          error: true,
          code: 'VENTAS_FECHA_INVALIDA',
          message: 'fechaDesde y fechaHasta deben tener formato YYYY-MM-DD.'
        });
      }

      const turno = String(req.query.turno ?? req.query.turnFilter ?? 'all').trim().toLowerCase();
      if (!['all', 'manana', 'tarde', 'noche'].includes(turno)) {
        return res.status(400).json({
          error: true,
          message: 'turno debe ser all, manana, tarde o noche.'
        });
      }

      const idSucursalRaw = req.query.idSucursal ?? req.query.id_sucursal;
      const idSucursalRequested = parseOptionalPositiveInt(idSucursalRaw);

      let idSucursalEffective = null;
      if (scope.isSuperAdmin) {
        idSucursalEffective = idSucursalRequested;
        if (idSucursalEffective && !scope.allowedSucursalIds.includes(idSucursalEffective)) {
          return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
        }
      } else {
        idSucursalEffective = scope.userSucursalId;
        if (!idSucursalEffective) {
          return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal vinculada.' });
        }
      }

      const canViewSucursales = await requestHasAnyPermission(req, ['SUCURSALES_VER']);
      const canViewPedidos = await requestHasAnyPermission(req, ['VENTAS_VER', 'COCINA_VER']);
      const canViewProductos = await requestHasAnyPermission(req, ['INVENTARIO_PRODUCTOS_VER']);
      const canViewInsumos = await requestHasAnyPermission(req, ['INVENTARIO_INSUMOS_VER']);
      const canViewVentas = await requestHasAnyPermission(req, ['VENTAS_VER']);

      const appendSucursalFilter = (filters, params, columnExpr) => {
        if (idSucursalEffective) {
          params.push(idSucursalEffective);
          filters.push(`${columnExpr} = $${params.length}`);
          return;
        }

        params.push(scope.allowedSucursalIds);
        filters.push(`${columnExpr} = ANY($${params.length}::int[])`);
      };

      const summary = {
        general: {
          sucursales: null,
          pedidos: null,
          inventario: null
        },
        financial: null
      };

      if (canViewSucursales) {
        try {
          const sucursalFilters = ['1 = 1'];
          const sucursalParams = [];
          appendSucursalFilter(sucursalFilters, sucursalParams, 's.id_sucursal');

          const sucursalResult = await pool.query(
            `
              SELECT
                COUNT(*)::int AS total,
                COALESCE(
                  SUM(
                    CASE
                      WHEN COALESCE(s.estado, true) = true THEN 1
                      ELSE 0
                    END
                  ),
                  0
                )::int AS activas
              FROM public.sucursales s
              WHERE ${sucursalFilters.join(' AND ')}
            `,
            sucursalParams
          );

          summary.general.sucursales = {
            total: Number.parseInt(String(sucursalResult.rows?.[0]?.total ?? '0'), 10) || 0,
            activas: Number.parseInt(String(sucursalResult.rows?.[0]?.activas ?? '0'), 10) || 0
          };
        } catch {
          summary.general.sucursales = null;
        }
      }

      if (canViewPedidos) {
        try {
          const hasVisibleEnCocinaAt = await hasPedidosColumn(pool, 'visible_en_cocina_at');
          const pedidosOperationalDateExpr = hasVisibleEnCocinaAt
            ? `
              COALESCE(
                f.fecha_operacion::date,
                p.visible_en_cocina_at::date,
                p.fecha_hora_pedido::date
              )
            `
            : `
              COALESCE(
                f.fecha_operacion::date,
                p.fecha_hora_pedido::date
              )
            `;
          const pedidosOperationalTimestampExpr = hasVisibleEnCocinaAt
            ? `
              COALESCE(
                f.fecha_operacion::timestamp,
                p.visible_en_cocina_at,
                p.fecha_hora_pedido
              )
            `
            : `
              COALESCE(
                f.fecha_operacion::timestamp,
                p.fecha_hora_pedido
              )
            `;
          const estadoPendiente = await resolveEstadoPedidoIdByCode(pool, 'PENDIENTE');
          const estadoEnCocina = await resolveEstadoPedidoIdByCode(pool, 'EN_COCINA');
          const estadoEnPreparacion = await resolveEstadoPedidoIdByCode(pool, 'EN_PREPARACION');
          const estadoListo = await resolveEstadoPedidoIdByCode(pool, 'LISTO_PARA_ENTREGA');
          const estadoIds = [estadoPendiente, estadoEnCocina, estadoEnPreparacion, estadoListo].filter(Boolean);

          if (estadoIds.length > 0) {
            const estadoEnCocinaIds = [estadoEnCocina, estadoEnPreparacion].filter(Boolean);
            const pedidoParams = [
              estadoIds,
              estadoPendiente || 0,
              estadoEnCocinaIds,
              estadoListo || 0
            ];
            const pedidoFilters = ['p.id_estado_pedido = ANY($1::int[])'];
            appendSucursalFilter(pedidoFilters, pedidoParams, 'p.id_sucursal');
            pedidoFilters.push(`
              ${pedidosOperationalDateExpr} = (NOW() AT TIME ZONE 'America/Tegucigalpa')::date
            `);

            if (turno !== 'all') {
              const hourCondition = turno === 'manana'
                ? `EXTRACT(HOUR FROM ${pedidosOperationalTimestampExpr}) < 12`
                : turno === 'tarde'
                  ? `EXTRACT(HOUR FROM ${pedidosOperationalTimestampExpr}) >= 12
                     AND EXTRACT(HOUR FROM ${pedidosOperationalTimestampExpr}) < 18`
                  : `EXTRACT(HOUR FROM ${pedidosOperationalTimestampExpr}) >= 18`;
              pedidoFilters.push(`(${hourCondition})`);
            }

            const pedidosWhereClause = `WHERE ${pedidoFilters.join(' AND ')}`;

            const pedidosSummaryResult = await pool.query(
              `
                SELECT
                  COUNT(*)::int AS total_operacion,
                  COALESCE(SUM(CASE WHEN p.id_estado_pedido = $2 THEN 1 ELSE 0 END), 0)::int AS pendientes_pago,
                  COALESCE(SUM(CASE WHEN p.id_estado_pedido = ANY($3::int[]) THEN 1 ELSE 0 END), 0)::int AS en_cocina,
                  COALESCE(SUM(CASE WHEN p.id_estado_pedido = $4 THEN 1 ELSE 0 END), 0)::int AS listos_entrega
                FROM public.pedidos p
                LEFT JOIN LATERAL (
                  SELECT f.*
                  FROM public.facturas f
                  WHERE f.id_pedido = p.id_pedido
                    AND f.id_sucursal = p.id_sucursal
                  ORDER BY
                    f.fecha_operacion DESC NULLS LAST,
                    f.fecha_hora_facturacion DESC NULLS LAST,
                    f.id_factura DESC
                  LIMIT 1
                ) f ON TRUE
                ${pedidosWhereClause}
              `,
              pedidoParams
            );

            const ordersFlowResult = await pool.query(
              `
                SELECT
                  TO_CHAR(
                    DATE_TRUNC('hour', ${pedidosOperationalTimestampExpr}),
                    'HH24:00'
                  ) AS hour,
                  COUNT(*)::int AS pedidos
                FROM public.pedidos p
                LEFT JOIN LATERAL (
                  SELECT f.*
                  FROM public.facturas f
                  WHERE f.id_pedido = p.id_pedido
                    AND f.id_sucursal = p.id_sucursal
                  ORDER BY
                    f.fecha_operacion DESC NULLS LAST,
                    f.fecha_hora_facturacion DESC NULLS LAST,
                    f.id_factura DESC
                  LIMIT 1
                ) f ON TRUE
                ${pedidosWhereClause}
                GROUP BY 1
                ORDER BY 1
              `,
              pedidoParams
            );

            const pedidosRow = pedidosSummaryResult.rows?.[0] || {};
            summary.general.pedidos = {
              totalOperacion: Number.parseInt(String(pedidosRow.total_operacion ?? '0'), 10) || 0,
              pendientesPago: Number.parseInt(String(pedidosRow.pendientes_pago ?? '0'), 10) || 0,
              enCocina: Number.parseInt(String(pedidosRow.en_cocina ?? '0'), 10) || 0,
              listosEntrega: Number.parseInt(String(pedidosRow.listos_entrega ?? '0'), 10) || 0,
              flujoHorario: ordersFlowResult.rows.map((row) => ({
                hour: row.hour,
                pedidos: Number.parseInt(String(row.pedidos ?? '0'), 10) || 0
              }))
            };
          }
        } catch {
          summary.general.pedidos = null;
        }
      }

      if (canViewProductos || canViewInsumos) {
        try {
          const inventoryBlocks = [];
          const inventoryParams = [];

          if (canViewProductos) {
            const filters = ['COALESCE(p.estado, true) = true'];
            appendSucursalFilter(filters, inventoryParams, 'a.id_sucursal');
            inventoryBlocks.push(`
              SELECT
                COALESCE(SUM(CASE WHEN COALESCE(p.cantidad, 0) <= 0 THEN 1 ELSE 0 END), 0)::int AS agotados,
                COALESCE(SUM(CASE WHEN COALESCE(p.cantidad, 0) > 0 AND COALESCE(p.cantidad, 0) <= COALESCE(p.stock_minimo, 0) THEN 1 ELSE 0 END), 0)::int AS stock_bajo,
                COUNT(*)::int AS catalogo_activo
              FROM public.productos p
              LEFT JOIN public.almacenes a ON a.id_almacen = p.id_almacen
              WHERE ${filters.join(' AND ')}
            `);
          }

          if (canViewInsumos) {
            const filters = ['COALESCE(i.estado, true) = true'];
            appendSucursalFilter(filters, inventoryParams, 'a.id_sucursal');
            inventoryBlocks.push(`
              SELECT
                COALESCE(SUM(CASE WHEN COALESCE(i.cantidad, 0) <= 0 THEN 1 ELSE 0 END), 0)::int AS agotados,
                COALESCE(SUM(CASE WHEN COALESCE(i.cantidad, 0) > 0 AND COALESCE(i.cantidad, 0) <= COALESCE(i.stock_minimo, 0) THEN 1 ELSE 0 END), 0)::int AS stock_bajo,
                COUNT(*)::int AS catalogo_activo
              FROM public.insumos i
              LEFT JOIN public.almacenes a ON a.id_almacen = i.id_almacen
              WHERE ${filters.join(' AND ')}
            `);
          }

          if (inventoryBlocks.length > 0) {
            const inventoryResult = await pool.query(
              `
                SELECT
                  COALESCE(SUM(base.agotados), 0)::int AS agotados,
                  COALESCE(SUM(base.stock_bajo), 0)::int AS stock_bajo,
                  COALESCE(SUM(base.catalogo_activo), 0)::int AS catalogo_activo
                FROM (
                  ${inventoryBlocks.join('\nUNION ALL\n')}
                ) base
              `,
              inventoryParams
            );

            summary.general.inventario = {
              agotados: Number.parseInt(String(inventoryResult.rows?.[0]?.agotados ?? '0'), 10) || 0,
              stockBajo: Number.parseInt(String(inventoryResult.rows?.[0]?.stock_bajo ?? '0'), 10) || 0,
              catalogoActivo: Number.parseInt(String(inventoryResult.rows?.[0]?.catalogo_activo ?? '0'), 10) || 0
            };
          }
        } catch {
          summary.general.inventario = null;
        }
      }

      if (canViewVentas) {
        try {
          const filters = [];
          const params = [];
          const pushFilter = (fragment, value) => {
            params.push(value);
            filters.push(fragment.replaceAll('$IDX', `$${params.length}`));
          };

          if (idSucursalEffective) {
            pushFilter('COALESCE(p.id_sucursal, f.id_sucursal) = $IDX', idSucursalEffective);
          } else {
            pushFilter('COALESCE(p.id_sucursal, f.id_sucursal) = ANY($IDX::int[])', scope.allowedSucursalIds);
          }

          if (scope.limitedToLast72Hours) {
            filters.push(`f.fecha_hora_facturacion IS NOT NULL`);
            filters.push(`f.fecha_hora_facturacion >= ${VENTAS_LIMIT_72H_CUTOFF_SQL}`);
          }
          if (fechaDesde) {
            pushFilter('(f.fecha_hora_facturacion)::date >= $IDX::date', fechaDesde);
          }
          if (fechaHasta) {
            pushFilter('(f.fecha_hora_facturacion)::date <= $IDX::date', fechaHasta);
          }

          const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
          const financialResult = await pool.query(
            `
              SELECT
                COUNT(*)::int AS ventas,
                COALESCE(
                  SUM(
                    COALESCE(
                      df_info.subtotal_neto,
                      p.total,
                      0
                    )
                  ),
                  0
                )::numeric(14,2) AS total_vendido,
                COALESCE(
                  SUM(
                    CASE
                      WHEN p.id_pedido IS NULL THEN 1
                      WHEN LOWER(COALESCE(ep.descripcion, '')) IN (
                        'completada',
                        'completado',
                        'finalizada',
                        'finalizado',
                        'pagada',
                        'pagado',
                        'cerrada',
                        'cerrado',
                        'lista',
                        'listo'
                      ) THEN 1
                      ELSE 0
                    END
                  ),
                  0
                )::int AS completadas
              FROM facturas f
              LEFT JOIN pedidos p ON p.id_pedido = f.id_pedido
              LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
              LEFT JOIN LATERAL (
                SELECT
                  COALESCE(SUM(df.total_detalle), 0)::numeric(12,2) AS subtotal_neto
                FROM detalle_facturas df
                WHERE df.id_factura = f.id_factura
              ) df_info ON true
              ${whereClause}
            `,
            params
          );

          const financialRow = financialResult.rows?.[0] || {};
          const ventas = Number.parseInt(String(financialRow.ventas ?? '0'), 10) || 0;
          const totalVendido = roundMoney(financialRow.total_vendido);
          const completadas = Number.parseInt(String(financialRow.completadas ?? '0'), 10) || 0;
          const pendientes = Math.max(ventas - completadas, 0);

          summary.financial = {
            ventas,
            totalVendido,
            ticketPromedio: ventas > 0 ? roundMoney(totalVendido / ventas) : 0,
            completadas,
            pendientes,
            fechaDesde: fechaDesde || null,
            fechaHasta: fechaHasta || null
          };
        } catch {
          summary.financial = null;
        }
      }

      return res.status(200).json({
        success: true,
        summary,
        filters: {
          scope: {
            canSelectSucursal: scope.isSuperAdmin,
            selectedSucursalId: idSucursalEffective,
            userSucursalId: scope.userSucursalId,
            limitedByRole: scope.limitedToLast72Hours,
            limitedToLast72Hours: scope.limitedToLast72Hours,
            allowedSucursalIds: scope.allowedSucursalIds
          },
          turno
        }
      });
    } catch (err) {
      return sendVentasInternalError(res);
    }
  }
);

router.get(
  '/ventas/dashboard-flujo-pedidos',
  checkPermission(['DASHBOARD_VER', 'VENTAS_VER', 'COCINA_VER']),
  async (req, res) => {
    try {
      const scope = await resolveVentasHistoryScope(req);
      if (!scope.allowedSucursalIds.length) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }

      const fechaOperacionRaw = req.query.fechaOperacion ?? req.query.fecha_operacion;
      const fechaOperacion = parseOptionalDateInput(fechaOperacionRaw)
        || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Tegucigalpa' });
      if (fechaOperacion === '__INVALID_DATE__') {
        return res.status(400).json({
          error: true,
          code: 'VENTAS_FECHA_INVALIDA',
          message: 'fechaOperacion debe tener formato YYYY-MM-DD.'
        });
      }

      const idSucursalRaw = req.query.idSucursal ?? req.query.id_sucursal;
      const idSucursalRequested = parseOptionalPositiveInt(idSucursalRaw);

      let idSucursalEffective = null;
      if (scope.isSuperAdmin) {
        idSucursalEffective = idSucursalRequested;
        if (idSucursalEffective && !scope.allowedSucursalIds.includes(idSucursalEffective)) {
          return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
        }
      } else {
        idSucursalEffective = scope.userSucursalId;
        if (!idSucursalEffective) {
          return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal vinculada.' });
        }
      }

      const estadoPendiente = await resolveEstadoPedidoIdByCode(pool, 'PENDIENTE');
      const estadoEnCocina = await resolveEstadoPedidoIdByCode(pool, 'EN_COCINA');
      const estadoEnPreparacion = await resolveEstadoPedidoIdByCode(pool, 'EN_PREPARACION');
      const estadoListo = await resolveEstadoPedidoIdByCode(pool, 'LISTO_PARA_ENTREGA');
      const estadoIds = [estadoPendiente, estadoEnCocina, estadoEnPreparacion, estadoListo].filter(Boolean);
      const hasVisibleEnCocinaAt = await hasPedidosColumn(pool, 'visible_en_cocina_at');
      const pedidosOperationalDateExpr = hasVisibleEnCocinaAt
        ? `
          COALESCE(
            f.fecha_operacion::date,
            p.visible_en_cocina_at::date,
            p.fecha_hora_pedido::date
          )
        `
        : `
          COALESCE(
            f.fecha_operacion::date,
            p.fecha_hora_pedido::date
          )
        `;
      const pedidosOperationalTimestampExpr = hasVisibleEnCocinaAt
        ? `
          COALESCE(
            f.fecha_operacion::timestamp,
            p.visible_en_cocina_at,
            p.fecha_hora_pedido
          )
        `
        : `
          COALESCE(
            f.fecha_operacion::timestamp,
            p.fecha_hora_pedido
          )
        `;

      if (!estadoIds.length) {
        return res.status(200).json({
          success: true,
          summary: {
            fechaOperacion,
            rows: []
          }
        });
      }

      const params = [estadoIds];
      const filters = ['p.id_estado_pedido = ANY($1::int[])'];
      if (idSucursalEffective) {
        params.push(idSucursalEffective);
        filters.push(`p.id_sucursal = $${params.length}`);
      } else {
        params.push(scope.allowedSucursalIds);
        filters.push(`p.id_sucursal = ANY($${params.length}::int[])`);
      }
      params.push(fechaOperacion);
      filters.push(`
        ${pedidosOperationalDateExpr} = $${params.length}::date
      `);

      const result = await pool.query(
        `
          WITH hours AS (
            SELECT generate_series(0, 23) AS hour_num
          ),
          pedidos_agrupados AS (
            SELECT
              EXTRACT(
                HOUR FROM ${pedidosOperationalTimestampExpr}
              )::int AS hour_num,
              COUNT(*)::int AS pedidos
            FROM public.pedidos p
            LEFT JOIN LATERAL (
              SELECT f.*
              FROM public.facturas f
              WHERE f.id_pedido = p.id_pedido
                AND f.id_sucursal = p.id_sucursal
              ORDER BY
                f.fecha_operacion DESC NULLS LAST,
                f.fecha_hora_facturacion DESC NULLS LAST,
                f.id_factura DESC
              LIMIT 1
            ) f ON TRUE
            WHERE ${filters.join(' AND ')}
            GROUP BY 1
          )
          SELECT
            LPAD(hours.hour_num::text, 2, '0') || ':00' AS hour,
            COALESCE(pedidos_agrupados.pedidos, 0)::int AS pedidos
          FROM hours
          LEFT JOIN pedidos_agrupados
            ON pedidos_agrupados.hour_num = hours.hour_num
          ORDER BY hours.hour_num
        `,
        params
      );

      const totalPedidos = result.rows.reduce(
        (acc, row) => acc + (Number.parseInt(String(row?.pedidos ?? '0'), 10) || 0),
        0
      );

      return res.status(200).json({
        success: true,
        summary: {
          fechaOperacion,
          totalPedidos,
          rows: result.rows.map((row) => ({
            hour: row.hour,
            pedidos: Number.parseInt(String(row.pedidos ?? '0'), 10) || 0
          }))
        }
      });
    } catch (err) {
      return sendVentasInternalError(res);
    }
  }
);

// --- ENDPOINTS DE PEDIDOS (MENU PUBLICO) ---
// Gestion de validacion de pago y flujo operativo (Cocina/Entrega).
router.get('/ventas/pedidos-menu', checkPermission(['VENTAS_VER']), async (req, res) => {
  const client = await pool.connect();
  try {
    const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
    const hasDetallePedidoExtras = await hasTable(client, 'detalle_pedido_extras');
    const scope = await resolveRequestUserSucursalScope(req, client);
    const allowedSucursalIds = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.filter((value) => Number.isInteger(Number(value)) && Number(value) > 0).map(Number)
      : [];
    const requestedSucursalId = parseOptionalPositiveInt(req.query.id_sucursal ?? req.query.idSucursal);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    const userSucursalId = parseOptionalPositiveInt(scope.userSucursalId);
    const effectiveAllowedSucursalIds = allowedSucursalIds.length > 0
      ? allowedSucursalIds
      : userSucursalId
        ? [userSucursalId]
        : [];

    if (requestedSucursalId) {
      if (isSuperAdmin) {
        const validSucursalId = await resolveSucursalId(client, requestedSucursalId);
        if (!validSucursalId) {
          return res.status(404).json({ error: true, message: 'Sucursal no disponible.' });
        }
      } else if (!effectiveAllowedSucursalIds.includes(requestedSucursalId)) {
        return res.status(403).json({ error: true, message: 'No puedes consultar pedidos de otra sucursal.' });
      }
    } else if (!isSuperAdmin && effectiveAllowedSucursalIds.length === 0) {
      return res.status(403).json({ error: true, message: 'No tienes una sucursal asignada para consultar pedidos.' });
    }

    const effectiveSucursalIds = requestedSucursalId
      ? [requestedSucursalId]
      : isSuperAdmin
        ? []
        : effectiveAllowedSucursalIds;

    await expirePendingPublicOrders({ client, allowedSucursalIds: effectiveSucursalIds });

    const hasEstadoPago = await hasPedidosColumn(client, 'estado_pago');
    const hasValidacionVence = await hasPedidosColumn(client, 'validacion_pago_vence_at');
    const hasPagoConfirmadoAt = await hasPedidosColumn(client, 'pago_confirmado_at');
    const hasCanceladoPorTimeoutAt = await hasPedidosColumn(client, 'cancelado_por_timeout_at');
    const hasIdUsuarioPagoConfirmado = await hasPedidosColumn(client, 'id_usuario_pago_confirmado');
    const hasKdsStartedAt = await hasPedidosColumn(client, 'kds_started_at');
    const hasKdsExpectedMinutes = await hasPedidosColumn(client, 'kds_expected_minutes');
    const hasKdsExpectedRule = await hasPedidosColumn(client, 'kds_expected_rule');
    const hasVisibleEnCocinaAt = await hasPedidosColumn(client, 'visible_en_cocina_at');
    const hasPedidosContacto = await hasTable(client, 'pedidos_contacto');
    const hasPedidosContactoCorreo = hasPedidosContacto && await hasColumn(client, 'pedidos_contacto', 'correo');

    const estadoPendiente = await resolveEstadoPedidoIdByCode(client, 'PENDIENTE');
    const estadoEnCocina = await resolveEstadoPedidoIdByCode(client, 'EN_COCINA');
    const estadoEnPreparacion = await resolveEstadoPedidoIdByCode(client, 'EN_PREPARACION');
    const estadoListo = await resolveEstadoPedidoIdByCode(client, 'LISTO_PARA_ENTREGA');
    const estadoIds = [estadoPendiente, estadoEnCocina, estadoEnPreparacion, estadoListo].filter(Boolean);

    if (estadoIds.length === 0) {
      return res.status(200).json([]);
    }

    const filters = [`p.id_estado_pedido = ANY($1::int[])`];
    const params = [estadoIds];
    const search = normalizePedidoText(req.query.search ?? req.query.q, 100) || '';

    if (requestedSucursalId) {
      params.push(requestedSucursalId);
      filters.push(`p.id_sucursal = $${params.length}`);
    } else if (effectiveSucursalIds.length > 0) {
      params.push(effectiveSucursalIds);
      filters.push(`p.id_sucursal = ANY($${params.length}::int[])`);
    }

    if (search) {
      const searchOr = [];
      const codeMatch = search.match(/^(?:PED|VTA)[-\s]?0*(\d+)$/i);
      const exactId = /^\d+$/.test(search)
        ? Number.parseInt(search, 10)
        : codeMatch
          ? Number.parseInt(codeMatch[1], 10)
          : null;
      if (Number.isInteger(exactId) && exactId > 0) {
        params.push(exactId);
        searchOr.push(`p.id_pedido = $${params.length}`);
      }
      params.push(`%${search}%`);
      const likeIndex = params.length;
      searchOr.push(`('PED-' || LPAD(p.id_pedido::text, 5, '0')) ILIKE $${likeIndex}`);
      searchOr.push(`('VTA-' || LPAD(p.id_pedido::text, 5, '0')) ILIKE $${likeIndex}`);
      searchOr.push(`COALESCE(NULLIF(TRIM(f.codigo_venta), ''), '') ILIKE $${likeIndex}`);
      searchOr.push(`COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(p.id_pedido::text, 5, '0')) ILIKE $${likeIndex}`);
      searchOr.push(`COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''), '') ILIKE $${likeIndex}`);
      if (hasPedidosContacto) {
        searchOr.push(`COALESCE(pc.nombre_contacto, '') ILIKE $${likeIndex}`);
        searchOr.push(`COALESCE(pc.telefono_contacto, '') ILIKE $${likeIndex}`);
        searchOr.push(`COALESCE(pc.telefono_normalizado, '') ILIKE $${likeIndex}`);
        if (hasPedidosContactoCorreo) {
          searchOr.push(`COALESCE(pc.correo, '') ILIKE $${likeIndex}`);
        }
      }
      const searchDigits = normalizeTelefonoDigits(search);
      if (hasPedidosContacto && searchDigits) {
        params.push(`%${searchDigits}%`);
        searchOr.push(`COALESCE(pc.telefono_normalizado, '') ILIKE $${params.length}`);
      }
      filters.push(`(${searchOr.join(' OR ')})`);
    }

    // AM: Filtro operativo diario para ocultar pedidos de dias anteriores sin alterar estados/historial.
    const operationalDateExpr = `(NOW() AT TIME ZONE 'America/Tegucigalpa')::date`;
    const pedidosOperacionFechaExpr = hasVisibleEnCocinaAt
      ? `
        COALESCE(
          f.fecha_operacion::date,
          p.visible_en_cocina_at::date,
          p.fecha_hora_pedido::date
        )
      `
      : `
        COALESCE(
          f.fecha_operacion::date,
          p.fecha_hora_pedido::date
        )
      `;
    filters.push(`
      ${pedidosOperacionFechaExpr} = ${operationalDateExpr}
    `);
    const whereClause = `WHERE ${filters.join(' AND ')}`;

    const estadoPagoSelect = hasEstadoPago ? 'p.estado_pago' : `NULL::text AS estado_pago`;
    const validacionSelect = hasValidacionVence
      ? 'p.validacion_pago_vence_at'
      : 'NULL::timestamp AS validacion_pago_vence_at';
    const pagoConfirmadoAtSelect = hasPagoConfirmadoAt
      ? 'p.pago_confirmado_at'
      : 'NULL::timestamp AS pago_confirmado_at';
    const canceladoTimeoutSelect = hasCanceladoPorTimeoutAt
      ? 'p.cancelado_por_timeout_at'
      : 'NULL::timestamp AS cancelado_por_timeout_at';
    const pagoConfirmadorSelect = hasIdUsuarioPagoConfirmado
      ? 'p.id_usuario_pago_confirmado'
      : 'NULL::int AS id_usuario_pago_confirmado';
    const kdsStartedAtSelect = hasKdsStartedAt
      ? 'p.kds_started_at'
      : 'NULL::timestamptz AS kds_started_at';
    const kdsExpectedMinutesSelect = hasKdsExpectedMinutes
      ? 'p.kds_expected_minutes'
      : 'NULL::int AS kds_expected_minutes';
    const kdsExpectedRuleSelect = hasKdsExpectedRule
      ? 'p.kds_expected_rule'
      : 'NULL::text AS kds_expected_rule';
    const kdsVencidoSelect = hasKdsStartedAt && hasKdsExpectedMinutes
      ? "(p.kds_started_at IS NOT NULL AND p.kds_expected_minutes IS NOT NULL AND NOW() >= p.kds_started_at + (p.kds_expected_minutes * INTERVAL '1 minute')) AS kds_vencido"
      : 'FALSE AS kds_vencido';
    const contactoSelect = hasPedidosContacto
      ? `
          COALESCE(pc.nombre_contacto, NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''), 'Consumidor final') AS nombre_contacto,
          pc.telefono_contacto,
          pc.telefono_normalizado,
          ${hasPedidosContactoCorreo ? 'pc.correo' : 'NULL::text'} AS correo_contacto
        `
      : `
          COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''), 'Consumidor final') AS nombre_contacto,
          NULL::text AS telefono_contacto,
          NULL::text AS telefono_normalizado,
          NULL::text AS correo_contacto
        `;
    const contactoJoin = hasPedidosContacto
      ? `
        LEFT JOIN LATERAL (
          SELECT pc_inner.*
          FROM public.pedidos_contacto pc_inner
          WHERE pc_inner.id_pedido = p.id_pedido
          ORDER BY pc_inner.id_pedido_contacto DESC
          LIMIT 1
        ) pc ON true
      `
      : '';

    const result = await client.query(
      `
        SELECT
          p.id_pedido,
          p.descripcion_pedido,
          p.descripcion_envio,
          p.fecha_hora_pedido,
          p.sub_total,
          p.isv,
          p.total,
          p.id_sucursal,
          p.id_estado_pedido,
          p.origen_pedido,
          f.id_factura,
          ep.descripcion AS nombre_estado_pedido,
          ${estadoPagoSelect},
          ${hasEstadoPago ? 'p.estado_pago' : 'NULL::text'} AS estado_pago_legacy,
          UPPER(TRIM(COALESCE(ppc.estado_pago_codigo, ''))) AS estado_pago_control,
          COALESCE(ppc.monto_total, p.total, 0)::numeric(14,2) AS monto_total,
          COALESCE(ppc.monto_pagado, 0)::numeric(14,2) AS monto_pagado,
          COALESCE(ppc.monto_pendiente, 0)::numeric(14,2) AS monto_pendiente,
          (
            UPPER(TRIM(COALESCE(ppc.estado_pago_codigo, ''))) = '${PEDIDO_PENDIENTE_ESTADO_PAGO}'
            AND COALESCE(ppc.monto_pendiente, 0) > 0
            AND (
              f.id_factura IS NULL
              OR COALESCE(vcd_info.divisiones_pendientes_count, 0) > 0
            )
          ) AS puede_cobrar,
          ${validacionSelect},
          ${pagoConfirmadoAtSelect},
          ${canceladoTimeoutSelect},
          ${pagoConfirmadorSelect},
          ${kdsStartedAtSelect},
          ${kdsExpectedMinutesSelect},
          ${kdsExpectedRuleSelect},
          ${kdsVencidoSelect},
          COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(p.id_pedido::text, 5, '0')) AS codigo_venta,
          COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(p.id_pedido::text, 5, '0')) AS codigo_venta_operativo,
          'PED-' || LPAD(p.id_pedido::text, 5, '0') AS codigo_pedido,
          s.nombre_sucursal,
          fc_info.metodo_pago,
          COALESCE(vcd_info.divisiones_count, 0)::int AS cuenta_dividida_divisiones,
          pd.id_pedido_delivery IS NOT NULL AS es_delivery,
          CASE
            WHEN pd.id_pedido_delivery IS NULL THEN NULL
            ELSE cme.codigo
          END AS modalidad,
          CASE
            WHEN pd.id_pedido_delivery IS NULL THEN NULL
            ELSE cde.codigo
          END AS estado_delivery,
          CASE
            WHEN pd.id_pedido_delivery IS NULL THEN NULL
            ELSE COALESCE(pd.costo_envio, 0)::numeric(14,2)
          END AS costo_envio,
          CASE WHEN pd.id_pedido_delivery IS NULL THEN NULL ELSE pd.nombre_receptor END AS nombre_receptor,
          CASE WHEN pd.id_pedido_delivery IS NULL THEN NULL ELSE pd.telefono_receptor END AS telefono_receptor,
          CASE WHEN pd.id_pedido_delivery IS NULL THEN NULL ELSE pd.direccion_entrega END AS direccion_entrega,
          CASE WHEN pd.id_pedido_delivery IS NULL THEN NULL ELSE pd.referencia_entrega END AS referencia_entrega,
          CASE WHEN pd.id_pedido_delivery IS NULL THEN NULL ELSE pd.observacion_delivery END AS observacion_delivery,
          COALESCE(dp_info.items, '[]'::jsonb) AS items,
          u_pago.nombre_usuario AS usuario_pago_confirmado,
          per.nombre AS nombres_cliente,
          per.apellido AS apellidos_cliente,
          ${contactoSelect}
        FROM pedidos p
        INNER JOIN estados_pedido ep ON p.id_estado_pedido = ep.id_estado_pedido
        -- AM: Usa LEFT JOIN LATERAL para tomar una sola factura por pedido y evitar cards duplicadas.
        LEFT JOIN LATERAL (
          SELECT f.*
          FROM facturas f
          WHERE f.id_pedido = p.id_pedido
            AND f.id_sucursal = p.id_sucursal
          ORDER BY
            f.fecha_operacion DESC NULLS LAST,
            f.fecha_hora_facturacion DESC NULLS LAST,
            f.id_factura DESC
          LIMIT 1
        ) f ON TRUE
        LEFT JOIN sucursales s ON s.id_sucursal = p.id_sucursal
        LEFT JOIN clientes c ON p.id_cliente = c.id_cliente
        LEFT JOIN personas per ON c.id_persona = per.id_persona
        LEFT JOIN usuarios u_pago ON u_pago.id_usuario = p.id_usuario_pago_confirmado
        ${contactoJoin}
        LEFT JOIN LATERAL (
          SELECT px_inner.*
          FROM public.pedidos_contexto px_inner
          WHERE px_inner.id_pedido = p.id_pedido
          ORDER BY px_inner.id_pedido_contexto DESC
          LIMIT 1
        ) px ON true
        LEFT JOIN public.cat_pedidos_modalidades_entrega cme
          ON cme.id_modalidad_entrega = px.id_modalidad_entrega
        LEFT JOIN LATERAL (
          SELECT pd_inner.*
          FROM public.pedidos_delivery pd_inner
          WHERE pd_inner.id_pedido = p.id_pedido
          ORDER BY pd_inner.id_pedido_delivery DESC
          LIMIT 1
        ) pd ON true
        LEFT JOIN public.cat_delivery_estados cde
          ON cde.id_estado_delivery = pd.id_estado_delivery
        LEFT JOIN LATERAL (
          SELECT
            ppc_inner.*,
            cep_inner.codigo AS estado_pago_codigo
          FROM public.pedidos_pago_control ppc_inner
          INNER JOIN public.cat_pedidos_estados_pago cep_inner
            ON cep_inner.id_estado_pago_pedido = ppc_inner.id_estado_pago_pedido
          WHERE ppc_inner.id_pedido = p.id_pedido
          ORDER BY ppc_inner.id_pedido_pago_control DESC
          LIMIT 1
        ) ppc ON true
        LEFT JOIN LATERAL (
          SELECT
            STRING_AGG(DISTINCT cmp.nombre, ', ' ORDER BY cmp.nombre) AS metodo_pago
          FROM facturas_cobros fc
          INNER JOIN cat_metodos_pago cmp
            ON cmp.id_metodo_pago = fc.id_metodo_pago
          WHERE fc.id_factura = f.id_factura
        ) fc_info ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS divisiones_count,
            COUNT(*) FILTER (WHERE UPPER(TRIM(COALESCE(vcd.estado, ''))) = 'PENDIENTE')::int AS divisiones_pendientes_count
          FROM public.ventas_cuenta_divisiones vcd
          WHERE vcd.id_pedido = p.id_pedido
        ) vcd_info ON true
        LEFT JOIN LATERAL (
          SELECT
            jsonb_agg(
              jsonb_build_object(
                'id_detalle', dp.id_detalle_pedido,
                'id_detalle_pedido', dp.id_detalle_pedido,
                'tipo_item',
                  CASE
                    WHEN dp.id_producto IS NOT NULL THEN 'PRODUCTO'
                    WHEN dp.id_combo IS NOT NULL THEN 'COMBO'
                    WHEN dp.id_receta IS NOT NULL THEN 'RECETA'
                    ELSE 'ITEM'
                  END,
                'id_producto', dp.id_producto,
                'id_combo', dp.id_combo,
                'id_receta', dp.id_receta,
                'nombre_item', COALESCE(prod.nombre_producto, combo.nombre_combo, combo.descripcion, rec.nombre_receta, 'Item de pedido'),
                'nombre_producto', COALESCE(prod.nombre_producto, combo.nombre_combo, combo.descripcion, rec.nombre_receta, 'Item de pedido'),
                'cantidad',
                  CASE
                    WHEN COALESCE(prod.precio, combo.precio, rec.precio, 0) > 0
                      THEN GREATEST(1, ROUND(COALESCE(dp.sub_total_pedido, dp.total_pedido, 0) / COALESCE(prod.precio, combo.precio, rec.precio, 1))::int)
                    ELSE 1
                  END,
                'precio_unitario',
                  COALESCE(
                    prod.precio,
                    combo.precio,
                    rec.precio,
                    NULLIF(COALESCE(dp.sub_total_pedido, dp.total_pedido, 0), 0),
                    0
                  ),
                'sub_total', COALESCE(dp.sub_total_pedido, 0),
                'total_linea', COALESCE(dp.total_pedido, dp.sub_total_pedido, 0),
                'descuento', COALESCE(d.monto_descuento, 0),
                'descuento_linea', COALESCE(d.monto_descuento, 0),
                'descuento_global', 0,
                'descuento_porcentaje_linea',
                  CASE
                    WHEN COALESCE(dp.sub_total_pedido, 0) > 0 AND COALESCE(d.monto_descuento, 0) > 0
                      THEN LEAST(100, (COALESCE(d.monto_descuento, 0) / COALESCE(dp.sub_total_pedido, 1)) * 100)
                    ELSE NULL
                  END,
                'observacion', dp.observacion,
                'extras', ${hasDetallePedidoExtras
                  ? `COALESCE(extras_info.extras, '[]'::jsonb)`
                  : `'[]'::jsonb`},
                'configuracion_menu', ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu' : 'NULL::jsonb'}
              )
              ORDER BY dp.id_detalle_pedido
            ) AS items
          FROM detalle_pedido dp
          LEFT JOIN productos prod ON prod.id_producto = dp.id_producto
          LEFT JOIN combos combo ON combo.id_combo = dp.id_combo
          LEFT JOIN recetas rec ON rec.id_receta = dp.id_receta
          LEFT JOIN descuentos d ON d.id_descuento = dp.id_descuento
          ${hasDetallePedidoExtras ? `
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id_detalle_pedido_extra', dpe.id_detalle_pedido_extra,
                'id_extra', dpe.id_extra,
                'nombre', dpe.nombre_extra_snapshot,
                'nombre_extra', dpe.nombre_extra_snapshot,
                'cantidad', dpe.cantidad,
                'precio_unitario', dpe.precio_unitario,
                'precio', dpe.precio_unitario,
                'subtotal', dpe.subtotal
              )
              ORDER BY dpe.id_detalle_pedido_extra
            ) AS extras
            FROM public.detalle_pedido_extras dpe
            WHERE dpe.id_detalle_pedido = dp.id_detalle_pedido
              AND COALESCE(dpe.estado, true) = true
          ) extras_info ON true
          ` : ''}
          WHERE dp.id_pedido = p.id_pedido
            AND COALESCE(dp.estado, true) = true
        ) dp_info ON true
        ${whereClause}
        ORDER BY p.fecha_hora_pedido ASC
      `,
      params
    );

    const nowMs = Date.now();
    const rows = result.rows.map((row) => {
      const venceAt = row.validacion_pago_vence_at ? new Date(row.validacion_pago_vence_at) : null;
      const remainingMs = venceAt ? (venceAt.getTime() - nowMs) : null;
      const minutosRestantes = remainingMs === null ? null : Math.max(0, Math.ceil(remainingMs / 60000));
      return {
        ...row,
        pago_validado: String(row.estado_pago || '').toUpperCase() === PEDIDO_ESTADO_PAGO.PAGADO_CONFIRMADO,
        pago_expirado: String(row.estado_pago_legacy || row.estado_pago || '').toUpperCase() === PEDIDO_ESTADO_PAGO.CANCELADO_TIMEOUT,
        minutos_restantes_pago: minutosRestantes
      };
    });

    res.status(200).json(rows);
  } catch (error) {
    console.error('Error fetching pedidos-menu:', error);
    sendVentasInternalError(res, 'No se pudo cargar el tablero de pedidos.');
  } finally {
    client.release();
  }
});

router.post('/ventas/pedidos-menu/:id/confirmar-pago', checkPermission(['VENTAS_VER']), async (req, res) => {
  const idPedido = parsePositiveInt(req.params.id);
  if (!idPedido) {
    return res.status(400).json({ error: true, message: 'ID de pedido invalido.' });
  }

  const canConfirmPayment = await requestHasAnyPermission(req, [
    'VENTAS_VER',
    'VENTAS_CREAR',
    'VENTAS_PEDIDOS_CONFIRMAR_PAGO'
  ]);
  if (!canConfirmPayment) {
    return res.status(403).json({ error: true, message: 'No tienes permisos para confirmar pagos.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scope = await resolveRequestUserSucursalScope(req, client);
    const allowedSucursalIds = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.filter((value) => Number.isInteger(Number(value)) && Number(value) > 0).map(Number)
      : [];

    await expirePendingPublicOrders({ client, allowedSucursalIds });

    const hasEstadoPago = await hasPedidosColumn(client, 'estado_pago');
    const hasPagoConfirmadoAt = await hasPedidosColumn(client, 'pago_confirmado_at');
    const hasValidacionVence = await hasPedidosColumn(client, 'validacion_pago_vence_at');
    const hasIdUsuarioPagoConfirmado = await hasPedidosColumn(client, 'id_usuario_pago_confirmado');

    if (!hasEstadoPago) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'El esquema actual no soporta validacion de pago de pedidos.'
      });
    }

    const estadoPendiente = await resolveEstadoPedidoIdByCode(client, 'PENDIENTE');
    if (!estadoPendiente) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'No existe estado PENDIENTE para pedidos.' });
    }

    const pedidoResult = await client.query(
      `
        SELECT id_pedido, id_estado_pedido, id_sucursal, estado_pago, validacion_pago_vence_at
        FROM pedidos
        WHERE id_pedido = $1
        FOR UPDATE
      `,
      [idPedido]
    );

    if (pedidoResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Pedido no encontrado.' });
    }

    const pedido = pedidoResult.rows[0];
    const pedidoSucursalId = Number(pedido.id_sucursal || 0);
    if (
      allowedSucursalIds.length > 0 &&
      !allowedSucursalIds.includes(pedidoSucursalId)
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: true, message: 'No puedes confirmar pagos de otra sucursal.' });
    }

    if (Number(pedido.id_estado_pedido || 0) !== Number(estadoPendiente)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'Solo se puede confirmar pago de pedidos pendientes de validacion.'
      });
    }

    const estadoPagoActual = String(pedido.estado_pago || '').toUpperCase();
    if (estadoPagoActual === PEDIDO_ESTADO_PAGO.PAGADO_CONFIRMADO) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'El pago de este pedido ya fue confirmado.' });
    }

    if (estadoPagoActual === PEDIDO_ESTADO_PAGO.CANCELADO_TIMEOUT) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'El pedido ya fue cancelado por vencimiento de pago.' });
    }

    if (hasValidacionVence && pedido.validacion_pago_vence_at) {
      const venceAt = new Date(pedido.validacion_pago_vence_at).getTime();
      if (Number.isFinite(venceAt) && venceAt <= Date.now()) {
        await client.query(
          `
            UPDATE pedidos
            SET estado_pago = $2
            WHERE id_pedido = $1
          `,
          [idPedido, PEDIDO_ESTADO_PAGO.CANCELADO_TIMEOUT]
        );
        await client.query('COMMIT');
        return res.status(409).json({
          error: true,
          message: 'La ventana de validacion de pago expiro (10 minutos).'
        });
      }
    }

    const updateFields = ['estado_pago = $2'];
    const updateParams = [idPedido, PEDIDO_ESTADO_PAGO.PAGADO_CONFIRMADO];
    if (hasPagoConfirmadoAt) {
      updateFields.push('pago_confirmado_at = NOW()');
    }
    if (hasIdUsuarioPagoConfirmado) {
      const idUsuarioConfirma = parsePositiveInt(req.user?.id_usuario);
      if (idUsuarioConfirma) {
        updateParams.push(idUsuarioConfirma);
        updateFields.push(`id_usuario_pago_confirmado = $${updateParams.length}`);
      }
    }

    await client.query(
      `
        UPDATE pedidos
        SET ${updateFields.join(', ')}
        WHERE id_pedido = $1
      `,
      updateParams
    );

    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      id_pedido: idPedido,
      estado_pago: PEDIDO_ESTADO_PAGO.PAGADO_CONFIRMADO,
      message: 'Pago confirmado correctamente.'
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error confirmando pago de pedido:', error);
    return sendVentasInternalError(res, 'No se pudo confirmar el pago del pedido.');
  } finally {
    client.release();
  }
});

router.put('/ventas/pedidos-menu/:id/estado', checkPermission(['VENTAS_VER']), async (req, res) => {
  const idPedido = parsePositiveInt(req.params.id);
  if (!idPedido) {
    return res.status(400).json({ error: true, message: 'ID de pedido invalido.' });
  }

  const requestedTargetCode = String(req.body?.estado_destino || '').trim().toUpperCase();
  const requestedLegacyStateId = parseOptionalPositiveInt(req.body?.id_estado_pedido);

  if (!requestedTargetCode && !requestedLegacyStateId) {
    return res.status(400).json({
      error: true,
      message: 'Debes enviar estado_destino o id_estado_pedido para avanzar el pedido.'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scope = await resolveRequestUserSucursalScope(req, client);
    const allowedSucursalIds = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.filter((value) => Number.isInteger(Number(value)) && Number(value) > 0).map(Number)
      : [];

    await expirePendingPublicOrders({ client, allowedSucursalIds });

    const hasKdsStartedAt = await hasPedidosColumn(client, 'kds_started_at');
    const hasKdsExpectedMinutes = await hasPedidosColumn(client, 'kds_expected_minutes');

    const estadoRows = await fetchEstadoPedidoRows(client);
    const estadoCodeById = new Map(
      estadoRows.map((row) => [Number(row.id_estado_pedido), Object.entries(ESTADO_PEDIDO_CODES).find(([, aliases]) => aliases.has(normalizeTextKey(row.descripcion)))?.[0] || null])
    );
    const kdsStartedAtSelect = hasKdsStartedAt ? 'kds_started_at' : 'NULL::timestamptz AS kds_started_at';
    const kdsExpectedMinutesSelect = hasKdsExpectedMinutes ? 'kds_expected_minutes' : 'NULL::int AS kds_expected_minutes';

    const pedidoResult = await client.query(
      `
        SELECT id_pedido, id_estado_pedido, id_sucursal, estado_pago, validacion_pago_vence_at, ${kdsStartedAtSelect}, ${kdsExpectedMinutesSelect}
        FROM pedidos
        WHERE id_pedido = $1
        FOR UPDATE
      `,
      [idPedido]
    );

    if (pedidoResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Pedido no encontrado.' });
    }

    const pedido = pedidoResult.rows[0];
    const pedidoSucursalId = Number(pedido.id_sucursal || 0);
    if (allowedSucursalIds.length > 0 && !allowedSucursalIds.includes(pedidoSucursalId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: true, message: 'No puedes operar pedidos de otra sucursal.' });
    }

    const currentCode = estadoCodeById.get(Number(pedido.id_estado_pedido)) || null;

    let targetCode = requestedTargetCode || null;
    if (!targetCode && requestedLegacyStateId) {
      targetCode = estadoCodeById.get(Number(requestedLegacyStateId)) || null;
    }

    const normalizedTargetCode = resolvePedidoTransitionTargetCode(currentCode, targetCode);
    if (!normalizedTargetCode) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'La transici�n solicitada no es v�lida para el estado actual del pedido.'
      });
    }
    if (normalizedTargetCode === 'LISTO_PARA_ENTREGA') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'El pedido solo puede marcarse como listo desde Cocina.'
      });
    }

    if (
      (currentCode === 'EN_COCINA' || currentCode === 'EN_PREPARACION')
      && (normalizedTargetCode === 'COMPLETADO' || normalizedTargetCode === 'NO_ENTREGADO')
      && !isPedidoKdsVencido(pedido)
    ) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'El pedido a�n se encuentra dentro del tiempo operativo de cocina.'
      });
    }

    const targetStateId = await resolveEstadoPedidoIdByCode(client, normalizedTargetCode);
    if (!targetStateId) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: `No existe estado ${normalizedTargetCode} en catalogo de pedidos.`
      });
    }

    await client.query(
      `
        UPDATE pedidos
        SET id_estado_pedido = $2
        WHERE id_pedido = $1
      `,
      [idPedido, targetStateId]
    );

    await client.query('COMMIT');
    const successMessage = normalizedTargetCode === 'NO_ENTREGADO'
      ? 'Pedido marcado como no entregado correctamente.'
      : normalizedTargetCode === 'COMPLETADO'
        ? 'Pedido completado correctamente.'
        : 'Estado de pedido actualizado correctamente.';

    return res.status(200).json({
      ok: true,
      id_pedido: idPedido,
      estado_anterior: currentCode,
      estado_actual: normalizedTargetCode,
      message: successMessage
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error updating pedido estado:', error);
    return sendVentasInternalError(res, 'No se pudo actualizar el estado del pedido.');
  } finally {
    client.release();
  }
});

router.get('/ventas/:id/reversiones', checkPermission(['VENTAS_VER']), async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const idUsuario = parsePositiveInt(req.user?.id_usuario);
    if (!idUsuario) {
      return res.status(401).json({ error: true, message: 'No autorizado.' });
    }

    const rows = await listFacturaReversiones({
      idFactura,
      idUsuario
    });

    return res.status(200).json({ data: rows });
  } catch (error) {
    if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500) {
      return res.status(error.httpStatus).json({
        error: true,
        code: error.code || 'VENTAS_REVERSION_LIST_ERROR',
        message: error.publicMessage || 'No se pudo obtener las reversiones.'
      });
    }

    console.error('Error al listar reversiones de venta:', error);
    return sendVentasInternalError(res, 'No se pudo obtener las reversiones de la venta.');
  }
});

router.post('/ventas/:id/reversiones', checkPermission(['VENTAS_REVERSION_CREAR']), async (req, res) => {
  const idFactura = parsePositiveInt(req.params.id);
  if (!idFactura) {
    return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
  }

  const idUsuario = parsePositiveInt(req.user?.id_usuario);
  if (!idUsuario) {
    return res.status(401).json({ error: true, message: 'No autorizado.' });
  }

  const rawUserAgent = String(req.headers?.['user-agent'] || '');
  const userAgent = rawUserAgent.slice(0, 500);
  const ipOrigen = String(getClientIp(req) || '-').slice(0, 80);
  const deviceInfo = parseUserAgent(rawUserAgent);
  const dispositivo = String(deviceInfo?.dispositivo || 'Desconocido').slice(0, 80);
  const idempotencyKey = getIdempotencyKey(req);
  const idempotencyRequestHash = idempotencyKey
    ? buildIdempotencyRequestHash({ idFactura, body: req.body })
    : null;
  let idempotencyReservation = null;

  try {
    const hasAllowedRole = await requestHasAnyRole(req, REVERSION_ALLOWED_ROLES);
    if (!hasAllowedRole) {
      return res.status(403).json({
        error: true,
        code: 'VENTAS_REVERSION_ROL_NO_AUTORIZADO',
        message: 'Solo administradores pueden registrar reversiones.'
      });
    }

    idempotencyReservation = await reserveVentasIdempotencyKey({
      idempotencyKey,
      operation: 'VENTAS_REVERSION_CREAR',
      requestHash: idempotencyRequestHash,
      idUsuario
    });

    if (idempotencyReservation.replay) {
      return res.status(idempotencyReservation.httpStatus || 200).json({
        ...(isPlainObject(idempotencyReservation.responseBody) ? idempotencyReservation.responseBody : {}),
        replayed: true
      });
    }

    if (idempotencyReservation.conflict) {
      return res.status(409).json({
        error: true,
        code: idempotencyReservation.code,
        message: idempotencyReservation.code === 'IDEMPOTENCY_KEY_REUSED'
          ? 'Idempotency-Key ya fue usado con otro payload.'
          : 'La solicitud con este Idempotency-Key esta en proceso.'
      });
    }

    const result = await createVentaReversion({
      idFactura,
      body: req.body,
      req,
      idUsuario
    });

    try {
      await sendReversionSuccessEmail({
        payload: {
          ...result,
          usuario: req.user?.nombre_usuario || req.user?.usuario || String(idUsuario),
          id_usuario: idUsuario,
          ip_origen: result?.auditoria?.ip_origen || ipOrigen,
          user_agent: result?.auditoria?.user_agent || userAgent
        }
      });
      try {
        await pool.query(
          `
            UPDATE public.facturas_reversiones
            SET correo_notificado = true,
                notificado_en = (NOW() AT TIME ZONE 'America/Tegucigalpa'),
                error_notificacion = NULL
            WHERE id_reversion = $1
          `,
          [result.id_reversion]
        );
      } catch (updateErr) {
        console.error('Error actualizando notificación de reversión exitosa:', updateErr);
      }
    } catch (mailError) {
      console.error('Error enviando correo de reversión exitosa:', mailError);
      try {
        await pool.query(
          `
            UPDATE public.facturas_reversiones
            SET correo_notificado = false,
                error_notificacion = $2
            WHERE id_reversion = $1
          `,
          [result.id_reversion, String(mailError?.message || 'Fallo de notificación').slice(0, 500)]
        );
      } catch (updateErr) {
        console.error('Error actualizando estado de notificación de reversión:', updateErr);
      }
    }

    const responseBody = {
      success: true,
      data: result,
      message: 'Reversión registrada correctamente.'
    };

    await saveVentasIdempotencySuccess({
      reservation: idempotencyReservation,
      httpStatus: 201,
      responseBody,
      idFactura,
      idUsuario,
      idSucursal: result?.id_sucursal
    });

    return res.status(201).json(responseBody);
  } catch (error) {
    await saveVentasIdempotencyFailure({
      reservation: idempotencyReservation,
      httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : 500,
      errorCode: error?.code || 'VENTAS_REVERSION_ERROR'
    }).catch((idempotencyErr) => {
      console.error('No se pudo marcar fallo idempotente de reversion:', idempotencyErr);
    });

    if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500) {
      await registerReversionFailureAttempt({
        idFactura,
        idUsuario,
        idSucursal: req.user?.id_sucursal,
        motivo: req.body?.motivo || null,
        errorCode: error.code || 'VENTAS_REVERSION_ERROR',
        errorMessagePublic: error.publicMessage || 'No se pudo completar la reversión.',
        ipOrigen,
        userAgent,
        dispositivo
      });

      if (shouldSendReversionFailureEmail({ idUsuario, idFactura })) {
        sendReversionFailureEmail({
          payload: {
            id_factura: idFactura,
            motivo: req.body?.motivo || null,
            error: error.publicMessage || error.message,
            codigo_venta: req.body?.codigo_venta || null,
            usuario: req.user?.nombre_usuario || req.user?.usuario || String(idUsuario),
            id_usuario: idUsuario,
            id_sucursal: req.user?.id_sucursal || null,
            ip_origen: ipOrigen,
            user_agent: userAgent,
            dispositivo
          }
        }).catch((mailError) => {
          console.error('Error enviando correo de reversión fallida:', mailError);
        });
      }

      return res.status(error.httpStatus).json({
        error: true,
        code: error.code || 'VENTAS_REVERSION_ERROR',
        message: error.publicMessage || 'No se pudo completar la reversión.'
      });
    }

    console.error('Error interno en reversión de venta:', error);
    return sendVentasInternalError(res, 'No se pudo completar la reversión de venta.');
  }
});

router.get('/ventas/buscar', checkPermission(['VENTAS_VER']), buscarVentaHandler);

router.patch('/ventas/clientes/:id/telefono', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const idCliente = parseOptionalPositiveInt(req.params.id);
  if (!idCliente) {
    return res.status(400).json({ error: true, message: 'id_cliente debe ser un entero mayor a 0.' });
  }

  const telefonoRaw = normalizePedidoText(req.body?.telefono, 40);
  const telefonoDigits = normalizeTelefonoDigits(telefonoRaw);
  if (!telefonoRaw || !telefonoDigits) {
    return res.status(400).json({ error: true, message: 'telefono es obligatorio.' });
  }
  if (telefonoDigits.length !== 8) {
    return res.status(400).json({ error: true, message: 'telefono debe tener 8 digitos.' });
  }
  const telefono = /^\d{4}-\d{4}$/.test(telefonoRaw)
    ? telefonoRaw
    : `${telefonoDigits.slice(0, 4)}-${telefonoDigits.slice(4)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scope = await resolveRequestUserSucursalScope(req, client);
    const allowedSucursalIds = Array.isArray(scope?.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((id) => parseOptionalPositiveInt(id)).filter(Boolean)
      : [];
    const userSucursalId = parseOptionalPositiveInt(scope?.userSucursalId);
    const effectiveAllowedSucursalIds = allowedSucursalIds.length > 0 ? allowedSucursalIds : userSucursalId ? [userSucursalId] : [];
    const hasClienteSucursalField = await hasColumn(client, 'clientes', 'id_sucursal');

    const clienteResult = await client.query(
      `
        SELECT
          c.id_cliente,
          c.estado,
          c.id_persona,
          c.id_empresa,
          ${hasClienteSucursalField ? 'c.id_sucursal' : 'NULL::int AS id_sucursal'},
          p.id_telefono AS persona_id_telefono,
          tp.telefono AS persona_telefono,
          e.id_telefono AS empresa_id_telefono,
          te.telefono AS empresa_telefono
        FROM public.clientes c
        LEFT JOIN public.personas p ON p.id_persona = c.id_persona
        LEFT JOIN public.telefonos tp ON tp.id_telefono = p.id_telefono
        LEFT JOIN public.empresas e ON e.id_empresa = c.id_empresa
        LEFT JOIN public.telefonos te ON te.id_telefono = e.id_telefono
        WHERE c.id_cliente = $1
        FOR UPDATE OF c
      `,
      [idCliente]
    );
    const cliente = clienteResult.rows?.[0] || null;
    if (!cliente || cliente.estado === false) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Cliente no encontrado.' });
    }
    if (!cliente.id_persona && !cliente.id_empresa) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        code: 'CLIENTE_CONSUMIDOR_FINAL_NO_ACTUALIZABLE',
        message: 'No se puede actualizar telefono para consumidor final.'
      });
    }

    if (!scope.isSuperAdmin && effectiveAllowedSucursalIds.length > 0) {
      let hasScope = parseOptionalPositiveInt(cliente.id_sucursal)
        ? effectiveAllowedSucursalIds.includes(Number(cliente.id_sucursal))
        : false;
      if (!hasScope && await hasTable(client, 'clientes_sucursales')) {
        const scopeResult = await client.query(
          `
            SELECT 1
            FROM public.clientes_sucursales cs
            WHERE cs.id_cliente = $1
              AND cs.id_sucursal = ANY($2::int[])
            LIMIT 1
          `,
          [idCliente, effectiveAllowedSucursalIds]
        );
        hasScope = scopeResult.rowCount > 0;
      }
      if (!hasScope) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: true,
          code: 'CLIENTE_TELEFONO_SCOPE_FORBIDDEN',
          message: 'No tienes permiso para actualizar el telefono de este cliente.'
        });
      }
    }

    const target = parseOptionalPositiveInt(cliente.id_persona)
      ? {
          table: 'personas',
          idField: 'id_persona',
          id: Number(cliente.id_persona),
          idTelefono: parseOptionalPositiveInt(cliente.persona_id_telefono),
          telefonoActual: normalizePedidoText(cliente.persona_telefono, 40)
        }
      : {
          table: 'empresas',
          idField: 'id_empresa',
          id: Number(cliente.id_empresa),
          idTelefono: parseOptionalPositiveInt(cliente.empresa_id_telefono),
          telefonoActual: normalizePedidoText(cliente.empresa_telefono, 40)
        };

    if (target.telefonoActual) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        code: 'CLIENTE_TELEFONO_EXISTENTE',
        message: 'El cliente ya tiene telefono registrado.'
      });
    }

    let idTelefono = target.idTelefono;
    if (idTelefono) {
      await client.query(
        'UPDATE public.telefonos SET telefono = $1 WHERE id_telefono = $2',
        [telefono, idTelefono]
      );
    } else {
      const telefonoResult = await client.query(
        'INSERT INTO public.telefonos (telefono) VALUES ($1) RETURNING id_telefono',
        [telefono]
      );
      idTelefono = Number(telefonoResult.rows?.[0]?.id_telefono || 0);
      await client.query(
        `UPDATE public.${target.table} SET id_telefono = $1 WHERE ${target.idField} = $2`,
        [idTelefono, target.id]
      );
    }

    await client.query('COMMIT');
    return res.status(200).json({ ok: true, id_cliente: idCliente, telefono });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al guardar telefono de cliente desde ventas:', error);
    return sendVentasInternalError(res, 'No se pudo guardar el telefono del cliente.');
  } finally {
    client.release();
  }
});

router.get('/ventas/pedidos-pendientes', checkPermission(['VENTAS_CREAR']), listarPedidosPendientesPago);

const formatInventarioAlertaResponse = (alerta) => ({
  id_alerta: Number(alerta.id_alerta),
  id_pedido: Number(alerta.id_pedido),
  id_detalle_pedido: parseOptionalPositiveInt(alerta.id_detalle_pedido),
  tipo_alerta: alerta.tipo_alerta,
  motivo: alerta.motivo,
  mensaje: alerta.mensaje,
  tipo_recurso: alerta.tipo_recurso,
  id_recurso: parseOptionalPositiveInt(alerta.id_recurso),
  id_producto: parseOptionalPositiveInt(alerta.id_producto),
  id_insumo: parseOptionalPositiveInt(alerta.id_insumo),
  id_receta: parseOptionalPositiveInt(alerta.id_receta),
  id_combo: parseOptionalPositiveInt(alerta.id_combo),
  id_extra: parseOptionalPositiveInt(alerta.id_extra),
  stock_disponible: alerta.stock_disponible,
  cantidad_requerida: alerta.cantidad_requerida,
  deficit: alerta.deficit,
  estado: alerta.estado,
  created_at: alerta.created_at,
  created_by: parseOptionalPositiveInt(alerta.created_by),
  created_by_usuario: alerta.created_by_usuario || null,
  resolved_at: alerta.resolved_at || null,
  resolved_by: parseOptionalPositiveInt(alerta.resolved_by),
  resolved_by_usuario: alerta.resolved_by_usuario || null,
  nota_resolucion: alerta.nota_resolucion || null,
  updated_at: alerta.updated_at || null,
  pedido: {
    id_pedido: Number(alerta.id_pedido),
    id_sucursal: parseOptionalPositiveInt(alerta.id_sucursal),
    nombre_sucursal: alerta.nombre_sucursal || null,
    estado_pedido: alerta.estado_pedido || null,
    fecha_hora_pedido: alerta.fecha_hora_pedido || null,
    total: alerta.pedido_total
  },
  payload: alerta.payload
});

router.get('/ventas/pedidos/:id/inventario-alertas', checkPermission(['VENTAS_VER']), async (req, res) => {
  try {
    const result = await listarAlertasInventarioPedido(req.params.id);
    return res.status(200).json({
      ok: true,
      id_pedido: parsePositiveInt(req.params.id),
      migration_applied: result.migration_applied,
      total: result.alertas.length,
      alertas: result.alertas.map(formatInventarioAlertaResponse)
    });
  } catch (err) {
    if (err?.httpStatus === 400) {
      return res.status(400).json({ error: true, message: err.message });
    }
    console.error('Error al obtener alertas de inventario del pedido:', err);
    return sendVentasInternalError(res);
  }
});

router.get('/ventas/:id/ticket.pdf', checkPermission(['VENTAS_IMPRIMIR']), getVentaTicketPdfByIdHandler);
router.get('/ventas/:id/ticket', checkPermission(['VENTAS_IMPRIMIR']), getVentaTicketByIdHandler);
router.get('/ventas/:id', checkPermission(['VENTAS_VER']), getVentaByIdHandler);

async function listarPedidosPendientesPago(req, res) {
  const parsePaginationInt = (value, defaultValue) => {
    if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: defaultValue };
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) return { ok: false, value: null };
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? { ok: true, value: parsed } : { ok: false, value: null };
  };

  const pageParsed = parsePaginationInt(req.query.page, 1);
  const pageSizeParsed = parsePaginationInt(req.query.page_size ?? req.query.pageSize, 20);
  if (!pageParsed.ok) return res.status(400).json({ error: true, message: 'page debe ser un entero mayor a 0.' });
  if (!pageSizeParsed.ok) return res.status(400).json({ error: true, message: 'page_size debe ser un entero mayor a 0.' });

  const page = pageParsed.value;
  const pageSize = Math.min(pageSizeParsed.value, 50);
  const offset = (page - 1) * pageSize;
  const search = normalizePedidoText(req.query.search, 100) || '';
  const idSucursalRaw = req.query.id_sucursal ?? req.query.idSucursal;
  const idSucursalRequested = parseOptionalPositiveInt(idSucursalRaw);
  if (idSucursalRaw !== undefined && idSucursalRaw !== null && String(idSucursalRaw).trim() !== '' && !idSucursalRequested) {
    return res.status(400).json({ error: true, message: 'id_sucursal debe ser un entero mayor a 0.' });
  }
  const includeItems = ['1', 'true', 'si', 'sí', 'yes'].includes(String(req.query.include_items ?? req.query.includeItems ?? '').trim().toLowerCase());

  const client = await pool.connect();
  try {
    const hasDetallePedidoConfiguracionMenu = includeItems
      ? await hasColumn(client, 'detalle_pedido', 'configuracion_menu')
      : false;
    const detallePedidoExtrasColumns = includeItems && await hasTable(client, 'detalle_pedido_extras')
      ? await Promise.all([
        'id_detalle_pedido_extra',
        'id_detalle_pedido',
        'id_extra',
        'nombre_extra_snapshot',
        'cantidad',
        'precio_unitario',
        'subtotal',
        'estado'
      ].map((columnName) => hasColumn(client, 'detalle_pedido_extras', columnName)))
      : [];
    const hasDetallePedidoExtras = detallePedidoExtrasColumns.length > 0
      && detallePedidoExtrasColumns.every(Boolean);
    const scope = await resolveRequestUserSucursalScope(req, client);
    const allowedSucursalIds = Array.isArray(scope?.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((id) => parseOptionalPositiveInt(id)).filter(Boolean)
      : [];
    const userSucursalId = parseOptionalPositiveInt(scope?.userSucursalId);
    const effectiveAllowedSucursalIds = allowedSucursalIds.length > 0 ? allowedSucursalIds : userSucursalId ? [userSucursalId] : [];

    const hasPendingSplitDivisionSql = `EXISTS (
        SELECT 1
        FROM public.ventas_cuenta_divisiones vcd_pending
        WHERE vcd_pending.id_pedido = p.id_pedido
          AND UPPER(TRIM(vcd_pending.estado)) = 'PENDIENTE'
      )`;
    const cobrableFacturaScopeSql = `(f.id_factura IS NULL OR ${hasPendingSplitDivisionSql})`;
    const filters = [
      'UPPER(TRIM(ppc.estado_pago_codigo)) = $1',
      'COALESCE(ppc.monto_pendiente, 0) > 0',
      cobrableFacturaScopeSql
    ];
    const params = [PEDIDO_PENDIENTE_ESTADO_PAGO];
    const excludedPedidoEstados = [
      'CANCELADO',
      'ANULADO',
      'NO_ENTREGADO',
      'COMPLETADO',
      'CANCELADO_POR_NO_PAGO',
      'CANCELADO_TIMEOUT',
      'PAGO_ANULADO'
    ];
    params.push(excludedPedidoEstados);
    filters.push("REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') <> ALL($" + params.length + '::text[])');

    if (scope.isSuperAdmin) {
      if (idSucursalRequested) {
        const idSucursal = await resolveSucursalId(client, idSucursalRequested);
        if (!idSucursal) return res.status(403).json({ error: true, message: 'No tienes permiso para ver pendientes de esta sucursal.' });
        params.push(idSucursalRequested);
        filters.push('p.id_sucursal = $' + params.length);
      }
    } else {
      if (!effectiveAllowedSucursalIds.length) {
        return res.status(403).json({ error: true, message: 'No tienes una sucursal asignada para consultar pendientes de pago.' });
      }
      if (idSucursalRequested) {
        if (!effectiveAllowedSucursalIds.includes(idSucursalRequested)) {
          return res.status(403).json({ error: true, message: 'No tienes permiso para ver pendientes de esta sucursal.' });
        }
        params.push(idSucursalRequested);
        filters.push('p.id_sucursal = $' + params.length);
      } else {
        params.push(effectiveAllowedSucursalIds);
        filters.push('p.id_sucursal = ANY($' + params.length + '::int[])');
      }
    }

    if (search) {
      const searchOr = [];
      const codeMatch = search.match(/^(?:PED|VTA)[-\s]?0*(\d+)$/i);
      const exactId = /^\d+$/.test(search)
        ? Number.parseInt(search, 10)
        : codeMatch
          ? Number.parseInt(codeMatch[1], 10)
          : null;
      if (Number.isInteger(exactId) && exactId > 0) {
        params.push(exactId);
        searchOr.push('p.id_pedido = $' + params.length);
      }
      params.push('%' + search + '%');
      const likeIndex = params.length;
      searchOr.push("('PED-' || LPAD(p.id_pedido::text, 5, '0')) ILIKE $" + likeIndex);
      searchOr.push("('VTA-' || LPAD(p.id_pedido::text, 5, '0')) ILIKE $" + likeIndex);
      searchOr.push("COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(p.id_pedido::text, 5, '0')) ILIKE $" + likeIndex);
      searchOr.push("COALESCE(pc.nombre_contacto, '') ILIKE $" + likeIndex);
      searchOr.push("COALESCE(pc.telefono_contacto, '') ILIKE $" + likeIndex);
      searchOr.push("COALESCE(pc.telefono_normalizado, '') ILIKE $" + likeIndex);
      const searchDigits = normalizeTelefonoDigits(search);
      if (searchDigits) {
        params.push('%' + searchDigits + '%');
        searchOr.push("COALESCE(pc.telefono_normalizado, '') ILIKE $" + params.length);
      }
      filters.push('(' + searchOr.join(' OR ') + ')');
    }

    const whereClause = 'WHERE ' + filters.join(' AND ');
    const fromClause = `
      FROM public.pedidos p
      INNER JOIN LATERAL (
        SELECT
          ppc_inner.*,
          cep_inner.codigo AS estado_pago_codigo
        FROM public.pedidos_pago_control ppc_inner
        INNER JOIN public.cat_pedidos_estados_pago cep_inner
          ON cep_inner.id_estado_pago_pedido = ppc_inner.id_estado_pago_pedido
        WHERE ppc_inner.id_pedido = p.id_pedido
        ORDER BY ppc_inner.id_pedido_pago_control DESC
        LIMIT 1
      ) ppc ON true
      INNER JOIN public.estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      INNER JOIN public.sucursales s ON s.id_sucursal = p.id_sucursal AND COALESCE(s.estado, true) = true
      LEFT JOIN LATERAL (
        SELECT pc_inner.*
        FROM public.pedidos_contacto pc_inner
        WHERE pc_inner.id_pedido = p.id_pedido
        ORDER BY pc_inner.id_pedido_contacto DESC
        LIMIT 1
      ) pc ON true
      LEFT JOIN LATERAL (
        SELECT px_inner.*
        FROM public.pedidos_contexto px_inner
        WHERE px_inner.id_pedido = p.id_pedido
        ORDER BY px_inner.id_pedido_contexto DESC
        LIMIT 1
      ) px ON true
      LEFT JOIN public.cat_pedidos_canales cpc ON cpc.id_canal_pedido = px.id_canal_pedido
      LEFT JOIN public.cat_pedidos_modalidades_entrega cme ON cme.id_modalidad_entrega = px.id_modalidad_entrega
      LEFT JOIN LATERAL (
        SELECT pd_inner.*
        FROM public.pedidos_delivery pd_inner
        WHERE pd_inner.id_pedido = p.id_pedido
        ORDER BY pd_inner.id_pedido_delivery DESC
        LIMIT 1
      ) pd ON true
      LEFT JOIN public.cat_delivery_estados cde ON cde.id_estado_delivery = pd.id_estado_delivery
      LEFT JOIN LATERAL (
        SELECT f_inner.id_factura, f_inner.codigo_venta
        FROM public.facturas f_inner
        WHERE f_inner.id_pedido = p.id_pedido
        ORDER BY f_inner.fecha_hora_facturacion DESC NULLS LAST, f_inner.id_factura DESC
        LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_cuenta_division', vcd.id_cuenta_division,
            'etiqueta', vcd.etiqueta,
            'orden', vcd.orden,
            'total', vcd.total,
            'monto_pagado', vcd.monto_pagado,
            'monto_pendiente', vcd.monto_pendiente,
            'estado', UPPER(TRIM(vcd.estado)),
            'items', COALESCE(vdi_info.items, '[]'::jsonb)
          )
          ORDER BY vcd.orden, vcd.id_cuenta_division
        ) AS divisiones
        FROM public.ventas_cuenta_divisiones vcd
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_cuenta_division_item', vdi.id_cuenta_division_item,
              'id_detalle_pedido', vdi.id_detalle_pedido,
              'nombre_item', vdi.nombre_item_snapshot,
              'total_linea', vdi.total_linea
            )
            ORDER BY vdi.id_cuenta_division_item
          ) AS items
          FROM public.ventas_cuenta_division_items vdi
          WHERE vdi.id_cuenta_division = vcd.id_cuenta_division
        ) vdi_info ON true
        WHERE vcd.id_pedido = p.id_pedido
      ) vcd_info ON true
    `;

    const summaryResult = await client.query(
      `
        SELECT
          COUNT(*)::int AS total_pedidos_pendientes,
          COALESCE(SUM(ppc.monto_pendiente), 0)::numeric(14,2) AS monto_total_pendiente
        ${fromClause}
        ${whereClause}
      `,
      params
    );

    const totalRows = Number(summaryResult.rows?.[0]?.total_pedidos_pendientes || 0);
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const rowParams = [...params, pageSize, offset];
    const limitIndex = rowParams.length - 1;
    const offsetIndex = rowParams.length;

    const result = await client.query(
      `
        SELECT
          p.id_pedido,
          'PED-' || LPAD(p.id_pedido::text, 5, '0') AS codigo_pedido,
          COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(p.id_pedido::text, 5, '0')) AS codigo_venta_operativo,
          COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(p.id_pedido::text, 5, '0')) AS codigo_venta,
          f.id_factura,
          p.fecha_hora_pedido,
          p.origen_pedido,
          CASE
            WHEN REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') IN ('EN_COCINA', 'EN_PREPARACION') THEN 'EN_COCINA'
            WHEN REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') IN ('LISTO', 'LISTO_PARA_ENTREGA') THEN 'LISTO_PARA_ENTREGA'
            ELSE REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_')
          END AS estado_pedido,
          UPPER(TRIM(ppc.estado_pago_codigo)) AS estado_pago,
          p.estado_pago AS estado_pago_legacy,
          UPPER(TRIM(ppc.estado_pago_codigo)) AS estado_pago_control,
          p.id_sucursal,
          s.nombre_sucursal,
          pc.nombre_contacto,
          pc.telefono_contacto,
          pc.telefono_normalizado,
          COALESCE(cpc.codigo, p.canal) AS canal,
          COALESCE(cme.codigo, p.tipo_entrega) AS modalidad,
          COALESCE(p.total, ppc.monto_total, 0)::numeric(14,2) AS total,
          COALESCE(ppc.monto_total, p.total, 0)::numeric(14,2) AS monto_total,
          COALESCE(ppc.monto_pagado, 0)::numeric(14,2) AS monto_pagado,
          COALESCE(ppc.monto_pendiente, 0)::numeric(14,2) AS monto_pendiente,
          (
            UPPER(TRIM(ppc.estado_pago_codigo)) = $1
            AND COALESCE(ppc.monto_pendiente, 0) > 0
            AND ${cobrableFacturaScopeSql}
          ) AS puede_cobrar,
          pd.id_pedido_delivery IS NOT NULL AS es_delivery,
          CASE
            WHEN pd.id_pedido_delivery IS NULL THEN NULL
            ELSE COALESCE(pd.costo_envio, 0)::numeric(14,2)
          END AS costo_envio,
          cde.codigo AS estado_delivery,
          pd.nombre_receptor,
          pd.telefono_receptor,
          pd.direccion_entrega,
          pd.referencia_entrega,
          pd.observacion_delivery,
          COALESCE(vcd_info.divisiones, '[]'::jsonb) AS cuenta_dividida
        ${fromClause}
        ${whereClause}
        ORDER BY p.fecha_hora_pedido DESC, p.id_pedido DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      rowParams
    );

    const items = result.rows.map((row) => ({
      id_pedido: Number(row.id_pedido),
      codigo_pedido: row.codigo_pedido,
      codigo_venta_operativo: row.codigo_venta_operativo,
      codigo_venta: row.codigo_venta,
      fecha_hora_pedido: row.fecha_hora_pedido,
      origen_pedido: row.origen_pedido,
      estado_pedido: row.estado_pedido,
      estado_pago: row.estado_pago,
      estado_pago_legacy: row.estado_pago_legacy,
      estado_pago_control: row.estado_pago_control,
      id_factura: parseOptionalPositiveInt(row.id_factura),
      id_sucursal: Number(row.id_sucursal),
      nombre_sucursal: row.nombre_sucursal,
      nombre_contacto: row.nombre_contacto,
      telefono_contacto: row.telefono_contacto,
      telefono_normalizado: row.telefono_normalizado,
      canal: row.canal,
      modalidad: row.modalidad,
      total: roundMoney(row.total),
      monto_total: roundMoney(row.monto_total),
      monto_pagado: roundMoney(row.monto_pagado),
      monto_pendiente: roundMoney(row.monto_pendiente),
      puede_cobrar: Boolean(row.puede_cobrar),
      cuenta_dividida: {
        divisiones: Array.isArray(row.cuenta_dividida) ? row.cuenta_dividida : []
      },
      es_delivery: Boolean(row.es_delivery),
      costo_envio: row.costo_envio === null || row.costo_envio === undefined ? null : roundMoney(row.costo_envio),
      estado_delivery: row.estado_delivery,
      nombre_receptor: row.nombre_receptor,
      telefono_receptor: row.telefono_receptor,
      direccion_entrega: row.direccion_entrega,
      referencia_entrega: row.referencia_entrega,
      observacion_delivery: row.observacion_delivery
    }));

    if (includeItems && items.length > 0) {
      const pedidoIds = items.map((item) => Number(item.id_pedido)).filter(Boolean);
      const detalleResult = await client.query(
        `
          SELECT
            dp.id_pedido,
            dp.id_detalle_pedido,
            COALESCE(prod.nombre_producto, combo.nombre_combo, combo.descripcion, rec.nombre_receta, 'Item de pedido') AS nombre_item,
            CASE
              WHEN COALESCE(prod.precio, combo.precio, rec.precio, 0) > 0
                THEN GREATEST(1, ROUND(COALESCE(dp.sub_total_pedido, dp.total_pedido, 0) / COALESCE(prod.precio, combo.precio, rec.precio, 1))::int)
              ELSE 1
            END AS cantidad,
            COALESCE(prod.precio, combo.precio, rec.precio, 0)::numeric(14,2) AS precio_unitario,
            COALESCE(dp.sub_total_pedido, 0)::numeric(14,2) AS sub_total,
            COALESCE(dp.total_pedido, dp.sub_total_pedido, 0)::numeric(14,2) AS total_linea,
            COALESCE(d.monto_descuento, 0)::numeric(14,2) AS descuento,
            COALESCE(d.monto_descuento, 0)::numeric(14,2) AS descuento_linea,
            0::numeric(14,2) AS descuento_global,
            CASE
              WHEN COALESCE(dp.sub_total_pedido, 0) > 0 AND COALESCE(d.monto_descuento, 0) > 0
                THEN LEAST(100, (COALESCE(d.monto_descuento, 0) / COALESCE(dp.sub_total_pedido, 1)) * 100)
              ELSE NULL
            END AS descuento_porcentaje_linea,
            dp.observacion,
            ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu,' : 'NULL::jsonb AS configuracion_menu,'}
            ${hasDetallePedidoExtras ? "COALESCE(extras_info.extras, '[]'::jsonb)" : "'[]'::jsonb"} AS extras
          FROM public.detalle_pedido dp
          LEFT JOIN public.productos prod ON prod.id_producto = dp.id_producto
          LEFT JOIN public.combos combo ON combo.id_combo = dp.id_combo
          LEFT JOIN public.recetas rec ON rec.id_receta = dp.id_receta
          LEFT JOIN public.descuentos d ON d.id_descuento = dp.id_descuento
          ${hasDetallePedidoExtras ? `
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id_detalle_pedido_extra', dpe.id_detalle_pedido_extra,
                'id_extra', dpe.id_extra,
                'nombre', dpe.nombre_extra_snapshot,
                'nombre_extra', dpe.nombre_extra_snapshot,
                'cantidad', dpe.cantidad,
                'precio_unitario', dpe.precio_unitario,
                'precio', dpe.precio_unitario,
                'subtotal', dpe.subtotal
              )
              ORDER BY dpe.id_detalle_pedido_extra
            ) AS extras
            FROM public.detalle_pedido_extras dpe
            WHERE dpe.id_detalle_pedido = dp.id_detalle_pedido
              AND COALESCE(dpe.estado, true) = true
          ) extras_info ON true
          ` : ''}
          WHERE dp.id_pedido = ANY($1::int[])
            AND COALESCE(dp.estado, true) = true
          ORDER BY dp.id_pedido, dp.id_detalle_pedido
        `,
        [pedidoIds]
      );
      const detallesByPedido = new Map();
      for (const row of detalleResult.rows) {
        const idPedidoRow = Number(row.id_pedido);
        if (!detallesByPedido.has(idPedidoRow)) detallesByPedido.set(idPedidoRow, []);
        detallesByPedido.get(idPedidoRow).push({
          id_detalle_pedido: Number(row.id_detalle_pedido),
          nombre_item: row.nombre_item,
          cantidad: Number(row.cantidad || 1),
          precio_unitario: roundMoney(row.precio_unitario),
          sub_total: roundMoney(row.sub_total),
          total_linea: roundMoney(row.total_linea),
          descuento: roundMoney(row.descuento),
          descuento_linea: roundMoney(row.descuento_linea),
          descuento_global: roundMoney(row.descuento_global),
          descuento_porcentaje_linea: row.descuento_porcentaje_linea === null ? null : Number(row.descuento_porcentaje_linea),
          observacion: row.observacion || null,
          configuracion_menu: row.configuracion_menu || null,
          extras: Array.isArray(row.extras) ? row.extras : []
        });
      }
      for (const item of items) {
        item.items = detallesByPedido.get(Number(item.id_pedido)) || [];
      }
    }

    return res.status(200).json({
      items,
      pagination: {
        page,
        page_size: pageSize,
        total: totalRows,
        total_pages: totalPages
      },
      summary: {
        total_pedidos_pendientes: totalRows,
        monto_total_pendiente: roundMoney(summaryResult.rows?.[0]?.monto_total_pendiente)
      }
    });
  } catch (error) {
    console.error('Error al listar pedidos pendientes de pago:', error);
    return sendVentasInternalError(res, 'No se pudieron cargar los pedidos pendientes de pago.');
  } finally {
    client.release();
  }
}
router.post('/ventas/pedidos-pendientes', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const ventasPerf = createVentasPerfTracker();
  const pedidoPendienteRouteStart = ventasPerf.now();
  const pedidoPendienteRoute = 'POST /ventas/pedidos-pendientes';
  const pedidoPendienteRpcEnabled = isPedidoPendienteRpcV1Enabled();
  let pedidoPendientePersistenceMode = 'not_reached';
  let pedidoPendienteRpcSkipReason = null;
  let pedidoPendienteTotalRouteMeasured = false;
  const addPedidoPendienteTotalRoute = () => {
    if (pedidoPendienteTotalRouteMeasured) return;
    ventasPerf.add('pedido_pendiente_total_route_ms', pedidoPendienteRouteStart);
    pedidoPendienteTotalRouteMeasured = true;
  };
  logVentasPerfRoute(pedidoPendienteRoute, {
    items_count: Array.isArray(req.body?.items) ? req.body.items.length : 0,
    id_sucursal: parseOptionalPositiveInt(req.body?.id_sucursal) || null
  });
  const ventasPerfContext = {
    route: pedidoPendienteRoute,
    operation: 'pedido_pendiente',
    id_usuario: null,
    id_sucursal: parseOptionalPositiveInt(req.body?.id_sucursal) || null,
    id_caja: null,
    id_sesion_caja: parseOptionalPositiveInt(req.body?.id_sesion_caja) || null,
    items_count: Array.isArray(req.body?.items) ? req.body.items.length : 0,
    rpc_enabled: pedidoPendienteRpcEnabled,
    cuenta_dividida: hasCuentaDivididaPayload(req.body)
  };
  const buildPedidoPendientePerfLogContext = (extra = {}) => {
    const context = {
      ...ventasPerfContext,
      persistence_mode: pedidoPendientePersistenceMode,
      rpc_skip_reason: pedidoPendienteRpcSkipReason
    };
    if (!context.rpc_skip_reason) delete context.rpc_skip_reason;
    return {
      ...context,
      ...extra
    };
  };
  const idempotencyKey = getIdempotencyKey(req);
  const idempotencyRequestHash = idempotencyKey
    ? buildIdempotencyRequestHash(req.body)
    : null;
  let idempotencyReservation = null;
  let client = null;

  try {
    const discountIntent = hasDiscountIntentInPayload(req.body);
    const canApplyDiscount = await requestHasAnyPermission(req, [VENTAS_DESCUENTO_APLICAR_PERMISSION]);
    if (discountIntent && !canApplyDiscount) {
      addPedidoPendienteTotalRoute();
      ventasPerf.log(buildPedidoPendientePerfLogContext({
        status: 403,
        error_code: 'VENTAS_DESCUENTO_NO_AUTORIZADO'
      }));
      return res.status(403).json({
        error: true,
        code: 'VENTAS_DESCUENTO_NO_AUTORIZADO',
        message: 'No tienes permiso para aplicar descuentos en ventas.'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const contextoStart = ventasPerf.now();
    const scope = await resolveRequestUserSucursalScope(req, client);
    const userId = parseOptionalPositiveInt(scope.idUsuario);
    ventasPerfContext.id_usuario = userId || null;
    ventasPerf.add('auth_scope_ms', contextoStart);
    ventasPerf.add('pedido_pendiente_scope_ms', contextoStart);

    const idempotencyStart = ventasPerf.now();
    try {
      idempotencyReservation = await reserveVentasIdempotencyKey({
        idempotencyKey,
        operation: 'POST /ventas/pedidos-pendientes',
        requestHash: idempotencyRequestHash,
        idUsuario: userId,
        idSucursal: req.body?.id_sucursal
      });
    } finally {
      ventasPerf.add('pedido_pendiente_idempotency_ms', idempotencyStart);
    }
    if (idempotencyReservation.replay) {
      await client.query('ROLLBACK');
      addPedidoPendienteTotalRoute();
      ventasPerf.log(buildPedidoPendientePerfLogContext({ status: idempotencyReservation.httpStatus || 200 }));
      return res.status(idempotencyReservation.httpStatus || 200).json({
        ...(isPlainObject(idempotencyReservation.responseBody) ? idempotencyReservation.responseBody : {}),
        idempotent_replay: true
      });
    }
    if (idempotencyReservation.conflict) {
      await client.query('ROLLBACK');
      addPedidoPendienteTotalRoute();
      ventasPerf.log(buildPedidoPendientePerfLogContext({
        status: 409,
        error_code: idempotencyReservation.code
      }));
      return res.status(409).json({
        error: true,
        code: idempotencyReservation.code,
        message: idempotencyReservation.code === 'IDEMPOTENCY_KEY_REUSED'
          ? 'Idempotency-Key ya fue usado con otro payload.'
          : 'La solicitud ya esta en proceso.'
      });
    }

    const buildStart = ventasPerf.now();
    const prepared = await buildPedidoPendientePayload({
      client,
      body: req.body,
      userId,
      sucursalScope: scope,
      canApplyDiscount,
      perf: ventasPerf
    });
    ventasPerf.add('pedido_pendiente_build_ms', buildStart);

    if (!prepared.ok) {
      await client.query('ROLLBACK');
      await saveVentasIdempotencyFailure({
        reservation: idempotencyReservation,
        httpStatus: prepared.status,
        errorCode: prepared.body?.code || null
      });
      addPedidoPendienteTotalRoute();
      ventasPerf.log(buildPedidoPendientePerfLogContext({
        status: prepared.status,
        error_code: prepared.body?.code || null
      }));
      return res.status(prepared.status).json(prepared.body);
    }

    const cuentaDivididaPlanStart = ventasPerf.now();
    const pedidoPendiente = prepared.data;
    const cuentaDivisionPlan = buildCuentaDivisionPlan({
      cuentaDividida: req.body?.cuenta_dividida,
      lines: pedidoPendiente.pedido_lines,
      expectedTotal: pedidoPendiente.total
    });
    ventasPerf.add('pedido_pendiente_cuenta_dividida_plan_ms', cuentaDivididaPlanStart);
    Object.assign(ventasPerfContext, {
      id_sucursal: parseOptionalPositiveInt(pedidoPendiente.id_sucursal),
      id_caja: parseOptionalPositiveInt(pedidoPendiente.id_caja),
      id_sesion_caja: parseOptionalPositiveInt(pedidoPendiente.id_sesion_caja),
      items_count: Array.isArray(pedidoPendiente.pedido_lines) ? pedidoPendiente.pedido_lines.length : 0
    });
    ventasPerfContext.cuenta_dividida = Boolean(cuentaDivisionPlan);

    const shouldUsePedidoPendienteRpcV1 =
      pedidoPendienteRpcEnabled
      && !cuentaDivisionPlan
      && Array.isArray(pedidoPendiente.pedido_lines)
      && pedidoPendiente.pedido_lines.length > 0;

    if (shouldUsePedidoPendienteRpcV1) {
      pedidoPendientePersistenceMode = 'rpc_v1';
      const rpcResponseBody = await createPedidoPendienteWithRpcV1Transaction({
        client,
        pedidoPendiente,
        perf: ventasPerf
      });
      const commitStart = ventasPerf.now();
      await client.query('COMMIT');
      ventasPerf.add('commit_ms', commitStart);
      ventasPerf.add('pedido_pendiente_commit_ms', commitStart);

      const idempotencySuccessStart = ventasPerf.now();
      await saveVentasIdempotencySuccess({
        reservation: idempotencyReservation,
        httpStatus: 201,
        responseBody: rpcResponseBody,
        idPedido: rpcResponseBody.id_pedido,
        idUsuario: userId,
        idSucursal: pedidoPendiente.id_sucursal
      }).catch((err) => {
        console.error('No se pudo guardar resultado idempotente RPC de pedido pendiente:', err);
      });
      ventasPerf.add('pedido_pendiente_idempotency_success_ms', idempotencySuccessStart);
      addPedidoPendienteTotalRoute();
      ventasPerf.log(buildPedidoPendientePerfLogContext({ status: 201 }));
      return res.status(201).json(rpcResponseBody);
    }

    pedidoPendientePersistenceMode = 'legacy';
    if (cuentaDivisionPlan) {
      pedidoPendienteRpcSkipReason = 'cuenta_dividida';
    } else if (!pedidoPendienteRpcEnabled) {
      pedidoPendienteRpcSkipReason = 'flag_disabled';
    } else if (!Array.isArray(pedidoPendiente.pedido_lines) || pedidoPendiente.pedido_lines.length === 0) {
      pedidoPendienteRpcSkipReason = 'no_lines';
    }

    const descuentosStart = ventasPerf.now();
    for (const line of pedidoPendiente.pedido_lines) {
      let idDescuento = null;
      if (line.descuento > 0) {
        const descuentoResult = await client.query(
          `
            INSERT INTO descuentos (monto_descuento, id_descuento_catalogo)
            VALUES ($1, $2)
            RETURNING id_descuento
          `,
          [line.descuento, line.id_descuento_catalogo]
        );
        idDescuento = descuentoResult.rows[0].id_descuento;
      }
      line.id_descuento = idDescuento;
    }
    ventasPerf.add('detalle_pedido_descuentos_ms', descuentosStart);

    const pedidoStart = ventasPerf.now();
    const pedidoResult = await client.query(
      `
        INSERT INTO pedidos (
          descripcion_pedido,
          descripcion_envio,
          fecha_hora_pedido,
          sub_total,
          isv,
          total,
          id_estado_pedido,
          id_sucursal,
          id_cliente,
          id_usuario,
          origen_pedido,
          canal,
          estado_pago,
          tipo_entrega,
          visible_en_cocina_at
        )
        VALUES ($1, $2, (NOW() AT TIME ZONE 'America/Tegucigalpa'), $3, $4, $5, $6, $7, $8, $9, 'CAJA', $10, $11, $12, (NOW() AT TIME ZONE 'America/Tegucigalpa'))
        RETURNING id_pedido
      `,
      [
        pedidoPendiente.descripcion_pedido,
        pedidoPendiente.descripcion_envio,
        pedidoPendiente.subtotal,
        pedidoPendiente.isv,
        pedidoPendiente.total,
        pedidoPendiente.id_estado_pedido,
        pedidoPendiente.id_sucursal,
        pedidoPendiente.id_cliente,
        pedidoPendiente.id_usuario,
        pedidoPendiente.canal,
        PEDIDO_PENDIENTE_ESTADO_PAGO,
        pedidoPendiente.modalidad
      ]
    );

    const idPedido = Number(pedidoResult.rows?.[0]?.id_pedido || 0);
    if (!idPedido) {
      throw {
        httpStatus: 500,
        code: 'PEDIDO_PENDIENTE_ID_NO_GENERADO',
        publicMessage: 'No se pudo crear el pedido pendiente.'
      };
    }
    ventasPerf.add('pedido_ms', pedidoStart);

    const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
    const detalleStart = ventasPerf.now();
    const pedidoLineRefs = [];
    const detallePedidoRows = pedidoPendiente.pedido_lines.map((line) => ({
      line,
      configuracionMenu: buildComplementLineConfig(line)
    }));

    if (detallePedidoRows.length > 0) {
      const detallePedidoParams = [];
      let detallePedidoValues;
      let detallePedidoResult;

      if (hasDetallePedidoConfiguracionMenu) {
        detallePedidoValues = detallePedidoRows.map((_, index) => {
          const base = index * 10;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::jsonb)`;
        }).join(', ');
        for (const { line, configuracionMenu } of detallePedidoRows) {
          detallePedidoParams.push(
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.cantidad,
            line.observacion,
            configuracionMenu ? JSON.stringify(configuracionMenu) : null
          );
        }
        detallePedidoResult = await client.query(
          `
            INSERT INTO detalle_pedido (
              sub_total_pedido,
              total_pedido,
              id_producto,
              id_pedido,
              id_descuento,
              estado,
              id_combo,
              id_receta,
              cantidad,
              observacion,
              configuracion_menu
            )
            VALUES ${detallePedidoValues}
            RETURNING id_detalle_pedido
          `,
          detallePedidoParams
        );
      } else {
        detallePedidoValues = detallePedidoRows.map((_, index) => {
          const base = index * 9;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
        }).join(', ');
        for (const { line } of detallePedidoRows) {
          detallePedidoParams.push(
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.cantidad,
            line.observacion
          );
        }
        detallePedidoResult = await client.query(
          `
            INSERT INTO detalle_pedido (
              sub_total_pedido,
              total_pedido,
              id_producto,
              id_pedido,
              id_descuento,
              estado,
              id_combo,
              id_receta,
              cantidad,
              observacion
            )
            VALUES ${detallePedidoValues}
            RETURNING id_detalle_pedido
          `,
          detallePedidoParams
        );
      }

      detallePedidoRows.forEach((_, index) => {
        const idDetallePedido = Number(detallePedidoResult.rows?.[index]?.id_detalle_pedido || 0);
        pedidoLineRefs.push({ id_detalle_pedido: idDetallePedido });
      });

      for (let index = 0; index < detallePedidoRows.length; index += 1) {
        await insertDetallePedidoExtras({
          client,
          idDetallePedido: pedidoLineRefs[index]?.id_detalle_pedido,
          extras: detallePedidoRows[index].line.extras_detalle
        });
      }
    }
    ventasPerf.add('detalle_pedido_ms', detalleStart);

    let cuentaDivididaResponse = null;
    if (cuentaDivisionPlan) {
      await persistCuentaDividida({
        client,
        plan: cuentaDivisionPlan,
        idPedido,
        lineRefs: pedidoLineRefs,
        estadoInicial: 'PENDIENTE'
      });
      cuentaDivididaResponse = await fetchCuentaDividida(client, { idPedido });
    }

    const contextoPedidoStart = ventasPerf.now();
    await client.query(
      `
        INSERT INTO public.pedidos_contexto (
          id_pedido,
          id_canal_pedido,
          id_modalidad_entrega,
          id_usuario_toma,
          id_sesion_caja_origen,
          observacion_contexto
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        idPedido,
        pedidoPendiente.id_canal_pedido,
        pedidoPendiente.id_modalidad_entrega,
        pedidoPendiente.id_usuario,
        pedidoPendiente.id_sesion_caja,
        pedidoPendiente.observacion_contexto
      ]
    );
    ventasPerf.add('pedido_pendiente_contexto_ms', contextoPedidoStart);

    const contactoStart = ventasPerf.now();
    await client.query(
      `
        INSERT INTO public.pedidos_contacto (
          id_pedido,
          nombre_contacto,
          telefono_contacto,
          telefono_normalizado,
          dni,
          rtn,
          correo
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        idPedido,
        pedidoPendiente.contacto.nombre_contacto,
        pedidoPendiente.contacto.telefono_contacto,
        pedidoPendiente.contacto.telefono_normalizado,
        pedidoPendiente.contacto.dni,
        pedidoPendiente.contacto.rtn,
        pedidoPendiente.contacto.correo
      ]
    );
    ventasPerf.add('pedido_pendiente_contacto_ms', contactoStart);

    const pagoControlStart = ventasPerf.now();
    await client.query(
      `
        INSERT INTO public.pedidos_pago_control (
          id_pedido,
          id_estado_pago_pedido,
          id_motivo_pago_pendiente,
          monto_total,
          monto_pagado,
          monto_pendiente,
          fecha_pago_confirmado,
          id_usuario_confirma_pago,
          id_sesion_caja_pago,
          id_factura,
          observacion_pago
        )
        VALUES ($1, $2, $3, $4, 0, $4, NULL, NULL, NULL, NULL, $5)
      `,
      [
        idPedido,
        pedidoPendiente.id_estado_pago_pedido,
        pedidoPendiente.id_motivo_pago_pendiente,
        pedidoPendiente.total,
        pedidoPendiente.observacion_pago
      ]
    );
    ventasPerf.add('pedido_pendiente_pago_control_ms', pagoControlStart);

    if (pedidoPendiente.modalidad === 'DELIVERY') {
      await client.query(
        `
          INSERT INTO public.pedidos_delivery (
            id_pedido,
            id_estado_delivery,
            costo_envio,
            nombre_receptor,
            telefono_receptor,
            direccion_entrega,
            referencia_entrega,
            observacion_delivery
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          idPedido,
          pedidoPendiente.id_estado_delivery,
          pedidoPendiente.delivery.costo_envio,
          pedidoPendiente.delivery.nombre_receptor,
          pedidoPendiente.delivery.telefono_receptor,
          pedidoPendiente.delivery.direccion_entrega,
          pedidoPendiente.delivery.referencia_entrega,
          pedidoPendiente.delivery.observacion_delivery
        ]
      );
    }

    const commitStart = ventasPerf.now();
    await client.query('COMMIT');
    ventasPerf.add('commit_ms', commitStart);
    ventasPerf.add('pedido_pendiente_commit_ms', commitStart);

    const responseBody = {
      message: 'Pedido pendiente creado correctamente.',
      id_pedido: idPedido,
      estado_pago: PEDIDO_PENDIENTE_ESTADO_PAGO,
      estado_pedido: 'EN_COCINA',
      origen_pedido: 'CAJA',
      canal: pedidoPendiente.canal,
      modalidad: pedidoPendiente.modalidad,
      total: pedidoPendiente.total,
      monto_pendiente: pedidoPendiente.total,
      cuenta_dividida: cuentaDivididaResponse
    };
    const idempotencySuccessStart = ventasPerf.now();
    await saveVentasIdempotencySuccess({
      reservation: idempotencyReservation,
      httpStatus: 201,
      responseBody,
      idPedido,
      idUsuario: userId,
      idSucursal: pedidoPendiente.id_sucursal
    }).catch((err) => {
      console.error('No se pudo guardar resultado idempotente de pedido pendiente:', err);
    });
    ventasPerf.add('pedido_pendiente_idempotency_success_ms', idempotencySuccessStart);
    addPedidoPendienteTotalRoute();
    ventasPerf.log(buildPedidoPendientePerfLogContext({ status: 201 }));
    return res.status(201).json(responseBody);
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch((rollbackErr) => {
        console.error('Error al revertir creacion de pedido pendiente:', rollbackErr);
      });
    }
    await saveVentasIdempotencyFailure({
      reservation: idempotencyReservation,
      httpStatus: Number.isInteger(err?.httpStatus) ? err.httpStatus : 500,
      errorCode: err?.code || null
    }).catch((idempotencyErr) => {
      console.error('No se pudo marcar fallo idempotente de pedido pendiente:', idempotencyErr);
    });
    addPedidoPendienteTotalRoute();
    ventasPerf.log(buildPedidoPendientePerfLogContext({
      status: Number.isInteger(err?.httpStatus) ? err.httpStatus : 500,
      error_code: err?.code || null
    }));
    console.error('Error al crear pedido pendiente:', err);
    if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 500) {
      return res.status(err.httpStatus).json({
        error: true,
        code: err.code || 'PEDIDO_PENDIENTE_ERROR',
        message: err.publicMessage || 'No se pudo crear el pedido pendiente.'
      });
    }
    return sendVentasInternalError(res, 'No se pudo crear el pedido pendiente.');
  } finally {
    addPedidoPendienteTotalRoute();
    ventasPerf.logIfMissing(buildPedidoPendientePerfLogContext({
      status: res.statusCode || null,
      completion: 'finally'
    }));
    if (client) client.release();
  }
});
router.post('/ventas/pedidos/:id/registrar-pago', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const ventasPerf = createVentasPerfTracker();
  const idPedido = parseOptionalPositiveInt(req.params.id);
  const idCuentaDivisionRequested = parseOptionalPositiveInt(req.body?.id_cuenta_division);
  const cuentaDivididaSolicitada = hasCuentaDivididaPayload(req.body);
  const cobrarDivisionOrdenRequested = parsePositiveInt(req.body?.cobrar_division_orden);
  logVentasPerfRoute('POST /ventas/pedidos/:id/registrar-pago', {
    id_pedido: idPedido || null,
    id_sesion_caja: parseOptionalPositiveInt(req.body?.id_sesion_caja) || null,
    id_cuenta_division: idCuentaDivisionRequested || null,
    cuenta_dividida_nueva: cuentaDivididaSolicitada
  });
  const ventasPerfContext = {
    operation: 'registrar_pago_pendiente',
    id_pedido: idPedido || null,
    id_usuario: null,
    id_sucursal: null,
    id_caja: null,
    id_sesion_caja: parseOptionalPositiveInt(req.body?.id_sesion_caja) || null,
    items_count: 0
  };
  if (!idPedido) {
    ventasPerf.log({ ...ventasPerfContext, status: 400, error_code: 'ID_PEDIDO_INVALIDO' });
    return res.status(400).json({ error: true, message: 'id_pedido invalido.' });
  }
  if (req.body?.id_cuenta_division !== undefined && req.body?.id_cuenta_division !== null && !idCuentaDivisionRequested) {
    ventasPerf.log({ ...ventasPerfContext, status: 400, error_code: 'ID_CUENTA_DIVISION_INVALIDO' });
    return res.status(400).json({ error: true, message: 'id_cuenta_division invalido.' });
  }
  if (req.body?.cuenta_dividida !== undefined && !cuentaDivididaSolicitada) {
    ventasPerf.log({ ...ventasPerfContext, status: 400, error_code: 'CUENTA_DIVIDIDA_INVALIDA' });
    return res.status(400).json({ error: true, message: 'cuenta_dividida debe ser un arreglo.' });
  }
  if (cuentaDivididaSolicitada && idCuentaDivisionRequested) {
    ventasPerf.log({ ...ventasPerfContext, status: 400, error_code: 'CUENTA_DIVIDIDA_CON_ID_EXISTENTE' });
    return res.status(400).json({ error: true, message: 'No envies cuenta_dividida e id_cuenta_division en el mismo cobro.' });
  }
  if (cuentaDivididaSolicitada && !cobrarDivisionOrdenRequested) {
    ventasPerf.log({ ...ventasPerfContext, status: 400, error_code: 'COBRAR_DIVISION_ORDEN_INVALIDO' });
    return res.status(400).json({ error: true, message: 'cobrar_division_orden debe ser un entero mayor a 0.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const contextoStart = ventasPerf.now();
    const contextoBaseResult = await client.query(
      `
        WITH pedido_locked AS (
          SELECT p.*
          FROM public.pedidos p
          WHERE p.id_pedido = $1
          FOR UPDATE
        ),
        pago_control_locked AS (
          SELECT
            ppc.*,
            ep.codigo AS estado_pago_codigo
          FROM public.pedidos_pago_control ppc
          INNER JOIN public.cat_pedidos_estados_pago ep
            ON ep.id_estado_pago_pedido = ppc.id_estado_pago_pedido
          WHERE ppc.id_pedido = $1
          ORDER BY ppc.id_pedido_pago_control DESC
          LIMIT 1
          FOR UPDATE OF ppc
        ),
        factura_previa_locked AS (
          SELECT id_factura, codigo_venta, fecha_operacion
          FROM public.facturas
          WHERE id_pedido = $1
            AND $3::boolean = false
          LIMIT 1
          FOR UPDATE
        ),
        delivery_locked AS (
          SELECT costo_envio
          FROM public.pedidos_delivery
          WHERE id_pedido = $1
          ORDER BY id_pedido_delivery DESC
          LIMIT 1
          FOR UPDATE
        ),
        estado_pagado AS (
          SELECT id_estado_pago_pedido AS id, codigo
          FROM public.cat_pedidos_estados_pago
          WHERE UPPER(TRIM(codigo)) = $2
            AND COALESCE(estado, true) = true
          LIMIT 1
        )
        SELECT
          to_jsonb(pedido_locked) AS pedido,
          to_jsonb(pago_control_locked) AS pago_control,
          to_jsonb(factura_previa_locked) AS factura_previa,
          to_jsonb(delivery_locked) AS delivery,
          to_jsonb(estado_pagado) AS estado_pagado
        FROM (SELECT 1) keep_row
        LEFT JOIN pedido_locked ON true
        LEFT JOIN pago_control_locked ON true
        LEFT JOIN factura_previa_locked ON true
        LEFT JOIN delivery_locked ON true
        LEFT JOIN estado_pagado ON true
      `,
      [idPedido, PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO, Boolean(idCuentaDivisionRequested || cuentaDivididaSolicitada)]
    );
    const contextoBase = contextoBaseResult.rows?.[0] || {};
    ventasPerf.add('registrar_pago_base_context_ms', contextoStart);
    const pedido = contextoBase.pedido || null;
    if (!pedido) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_NO_ENCONTRADO', message: 'Pedido no encontrado.' });
    }

    const pagoControl = contextoBase.pago_control || null;
    if (!pagoControl) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_PAGO_CONTROL_NO_ENCONTRADO', message: 'El pedido no tiene control de pago pendiente.' });
    }

    const cuentaDivididaStart = ventasPerf.now();
    let cuentaDivisionPago = null;
    if (idCuentaDivisionRequested) {
      const cuentaDivisionResult = await client.query(
        `
          SELECT *
          FROM (
            SELECT
              vcd.*,
              (
                SELECT fc.id_factura_cobro
                FROM public.facturas_cobros fc
                WHERE fc.id_cuenta_division = vcd.id_cuenta_division
                LIMIT 1
              ) AS id_factura_cobro_existente
            FROM public.ventas_cuenta_divisiones vcd
            WHERE vcd.id_cuenta_division = $1
              AND vcd.id_pedido = $2
            FOR UPDATE OF vcd
          ) division_locked
        `,
        [idCuentaDivisionRequested, idPedido]
      );
      cuentaDivisionPago = cuentaDivisionResult.rows?.[0] || null;
      if (!cuentaDivisionPago) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: true, code: 'CUENTA_DIVISION_NO_ENCONTRADA', message: 'La subcuenta no pertenece al pedido.' });
      }
      if (parseOptionalPositiveInt(cuentaDivisionPago.id_factura)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          code: 'CUENTA_DIVISION_YA_FACTURADA',
          message: 'Esta subcuenta ya tiene una factura registrada.'
        });
      }
      if (String(cuentaDivisionPago.estado || '').trim().toUpperCase() !== 'PENDIENTE' || roundMoney(cuentaDivisionPago.monto_pendiente) <= 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: true, code: 'CUENTA_DIVISION_NO_PENDIENTE', message: 'La subcuenta no esta pendiente de pago.' });
      }
      if (parseOptionalPositiveInt(cuentaDivisionPago.id_factura_cobro_existente)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          code: 'CUENTA_DIVISION_YA_COBRADA',
          message: 'Esta subcuenta ya tiene un cobro registrado.'
        });
      }
    }

    const estadoPagoActual = normalizePedidoCatalogCode(pagoControl.estado_pago_codigo);
    if (estadoPagoActual !== PEDIDO_PENDIENTE_ESTADO_PAGO) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_NO_PENDIENTE_PAGO', message: 'El pedido no esta pendiente de pago.' });
    }
    if (!cuentaDivisionPago && (pagoControl.id_factura || pagoControl.fecha_pago_confirmado || roundMoney(pagoControl.monto_pendiente) <= 0)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_YA_PAGADO', message: 'El pedido ya tiene pago confirmado o factura asociada.' });
    }
    if (cuentaDivisionPago && (pagoControl.fecha_pago_confirmado || roundMoney(pagoControl.monto_pendiente) <= 0)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_YA_PAGADO', message: 'El pedido ya tiene pago confirmado.' });
    }

    const facturaPrevia = contextoBase.factura_previa || null;
    const idFacturaPrevia = parseOptionalPositiveInt(facturaPrevia?.id_factura);
    if (!cuentaDivisionPago && idFacturaPrevia) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_FACTURA_EXISTENTE', message: 'El pedido ya tiene una factura asociada.' });
    }

    const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
    const detallePedidoStart = ventasPerf.now();
    const detallePedidoResult = cuentaDivisionPago
      ? await client.query(
        `
          WITH division_items AS (
            SELECT
              vdi.id_detalle_pedido,
              vdi.id_cuenta_division_item
            FROM public.ventas_cuenta_division_items vdi
            WHERE vdi.id_cuenta_division = $1
              AND vdi.id_detalle_pedido IS NOT NULL
          ),
          division_item_summary AS (
            SELECT COUNT(*)::int AS division_item_count
            FROM division_items
          )
          SELECT
            dp.id_detalle_pedido,
            dp.sub_total_pedido,
            dp.total_pedido,
            dp.id_producto,
            dp.id_descuento,
            dp.id_combo,
            dp.id_receta,
            dp.observacion,
            ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu,' : 'NULL::jsonb AS configuracion_menu,'}
            COALESCE(prod.nombre_producto, combo.nombre_combo, combo.descripcion, rec.nombre_receta, 'Item de pedido') AS nombre_item,
            COALESCE(prod.precio, combo.precio, rec.precio, NULL) AS precio_unitario,
            dis.division_item_count
          FROM division_items di
          CROSS JOIN division_item_summary dis
          INNER JOIN public.detalle_pedido dp
            ON dp.id_detalle_pedido = di.id_detalle_pedido
           AND dp.id_pedido = $2
           AND COALESCE(dp.estado, true) = true
          LEFT JOIN public.productos prod ON prod.id_producto = dp.id_producto
          LEFT JOIN public.combos combo ON combo.id_combo = dp.id_combo
          LEFT JOIN public.recetas rec ON rec.id_receta = dp.id_receta
          ORDER BY di.id_cuenta_division_item
          FOR UPDATE OF dp
        `,
        [Number(cuentaDivisionPago.id_cuenta_division), idPedido]
      )
      : await client.query(
        `
          SELECT
            dp.id_detalle_pedido,
            dp.sub_total_pedido,
            dp.total_pedido,
            dp.id_producto,
            dp.id_descuento,
            dp.id_combo,
            dp.id_receta,
            dp.observacion,
            ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu,' : 'NULL::jsonb AS configuracion_menu,'}
            COALESCE(prod.nombre_producto, combo.nombre_combo, combo.descripcion, rec.nombre_receta, 'Item de pedido') AS nombre_item,
            COALESCE(prod.precio, combo.precio, rec.precio, NULL) AS precio_unitario
          FROM public.detalle_pedido dp
          LEFT JOIN public.productos prod ON prod.id_producto = dp.id_producto
          LEFT JOIN public.combos combo ON combo.id_combo = dp.id_combo
          LEFT JOIN public.recetas rec ON rec.id_receta = dp.id_receta
          WHERE dp.id_pedido = $1
            AND COALESCE(dp.estado, true) = true
          ORDER BY dp.id_detalle_pedido ASC
          FOR UPDATE OF dp
        `,
        [idPedido]
      );
    ventasPerf.add('registrar_pago_detalle_pedido_ms', detallePedidoStart);
    if (detallePedidoResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return cuentaDivisionPago
        ? res.status(409).json({
            error: true,
            code: 'CUENTA_DIVISION_ITEMS_INVALIDOS',
            message: 'La subcuenta no tiene items validos para facturar.'
          })
        : res.status(409).json({ error: true, code: 'PEDIDO_DETALLE_VACIO', message: 'El pedido no tiene detalle para facturar.' });
    }

    let detallePedidoExtrasByIdCache = null;
    if (!cuentaDivisionPago) {
      const divisionesExistentesResult = await client.query(
        `
          SELECT *
          FROM public.ventas_cuenta_divisiones
          WHERE id_pedido = $1
          ORDER BY orden, id_cuenta_division
          FOR UPDATE
        `,
        [idPedido]
      );
      if (divisionesExistentesResult.rowCount > 0 && !cuentaDivididaSolicitada) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          code: 'CUENTA_DIVIDIDA_REQUIERE_SUBCUENTA',
          message: 'Este pedido tiene cuenta dividida. Debes enviar id_cuenta_division para cobrar una subcuenta.'
        });
      }
      if (cuentaDivididaSolicitada) {
        detallePedidoExtrasByIdCache = await fetchDetallePedidoExtras(
          client,
          detallePedidoResult.rows.map((row) => row.id_detalle_pedido)
        );
        let detallePedidoRowsDisponibles = detallePedidoResult.rows;
        if (divisionesExistentesResult.rowCount > 0) {
          const existingDivisionIds = divisionesExistentesResult.rows
            .map((row) => parseOptionalPositiveInt(row.id_cuenta_division))
            .filter(Boolean);
          const assignedItemsResult = existingDivisionIds.length
            ? await client.query(
              `
                SELECT DISTINCT id_detalle_pedido
                FROM public.ventas_cuenta_division_items
                WHERE id_cuenta_division = ANY($1::bigint[])
                  AND id_detalle_pedido IS NOT NULL
              `,
              [existingDivisionIds]
            )
            : { rows: [] };
          const assignedDetalleIds = new Set(
            assignedItemsResult.rows
              .map((row) => parseOptionalPositiveInt(row.id_detalle_pedido))
              .filter(Boolean)
          );
          detallePedidoRowsDisponibles = detallePedidoResult.rows.filter((row) => (
            !assignedDetalleIds.has(Number(row.id_detalle_pedido))
          ));
        }
        if (!detallePedidoRowsDisponibles.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: true,
            code: 'CUENTA_DIVIDIDA_SIN_LINEAS_DISPONIBLES',
            message: 'No quedan lineas disponibles para agregar otra persona.'
          });
        }
        const divisionLines = detallePedidoRowsDisponibles.map((row) => {
          const idProducto = parseOptionalPositiveInt(row.id_producto);
          const idReceta = parseOptionalPositiveInt(row.id_receta);
          const idCombo = parseOptionalPositiveInt(row.id_combo);
          const subTotal = roundMoney(row.sub_total_pedido);
          const totalLinea = roundMoney(row.total_pedido ?? row.sub_total_pedido);
          const detalleExtras = detallePedidoExtrasByIdCache.get(Number(row.id_detalle_pedido)) || [];
          const extrasSubtotalPersistido = roundMoney(detalleExtras.reduce((sum, extra) => sum + Number(extra.subtotal || 0), 0));
          const extrasSubtotal = extrasSubtotalPersistido > 0
            ? extrasSubtotalPersistido
            : Math.max(roundMoney(totalLinea - subTotal), 0);
          const descuentoLinea = Math.max(roundMoney(subTotal + extrasSubtotal - totalLinea), 0);
          const precioBase = roundMoney(row.precio_unitario || (subTotal > 0 ? subTotal : totalLinea));
          const cantidad = inferKitchenItemQuantity(subTotal, precioBase);
          return {
            id_detalle_pedido: parseOptionalPositiveInt(row.id_detalle_pedido),
            kind: normalizeTipoItem(idCombo ? 'COMBO' : idReceta ? 'RECETA' : idProducto ? 'PRODUCTO' : 'ITEM'),
            id_producto: idProducto,
            id_receta: idReceta,
            id_combo: idCombo,
            nombre_item: row.nombre_item || 'Item de pedido',
            cantidad,
            precio_unitario: precioBase,
            base_sub_total: subTotal,
            sub_total: subTotal,
            subtotal_extras: extrasSubtotal,
            descuento: descuentoLinea,
            total_linea: totalLinea,
            observacion: row.observacion || null,
            extras_detalle: detalleExtras,
            complementos_detalle: normalizeComplementosFromMenuConfig(row.configuracion_menu),
            configuracion_menu: row.configuracion_menu || null
          };
        });
        const cuentaDivisionPlan = buildCuentaDivisionPlan({
          cuentaDividida: req.body?.cuenta_dividida,
          lines: divisionLines,
          expectedTotal: roundMoney(pedido.total || pagoControl.monto_pendiente),
          allowPartial: true
        });
        const persistedDivisions = await persistCuentaDividida({
          client,
          plan: cuentaDivisionPlan,
          idPedido,
          lineRefs: divisionLines.map((line) => ({ id_detalle_pedido: line.id_detalle_pedido })),
          estadoInicial: 'PENDIENTE'
        });
        cuentaDivisionPago = persistedDivisions.find((division) => Number(division.orden) === Number(cobrarDivisionOrdenRequested)) || null;
        if (!cuentaDivisionPago) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: true,
            code: 'COBRAR_DIVISION_ORDEN_NO_EXISTE',
            message: 'La subcuenta seleccionada para cobrar no existe en cuenta_dividida.'
          });
        }
      }
    }
    ventasPerf.add('registrar_pago_cuenta_dividida_ms', cuentaDivididaStart);

    let detallePedidoRowsFacturar = detallePedidoResult.rows;
    if (cuentaDivisionPago) {
      if (Array.isArray(cuentaDivisionPago.items) && cuentaDivisionPago.items.length) {
        const detallePedidoById = new Map(
          detallePedidoResult.rows.map((row) => [Number(row.id_detalle_pedido), row])
        );
        const detalleIdsDivision = cuentaDivisionPago.items
          .map((item) => parseOptionalPositiveInt(item?.line?.id_detalle_pedido ?? item?.id_detalle_pedido))
          .filter(Boolean);
        detallePedidoRowsFacturar = detalleIdsDivision
          .map((idDetallePedido) => detallePedidoById.get(idDetallePedido))
          .filter(Boolean);
      }
      if (!detallePedidoRowsFacturar.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          code: 'CUENTA_DIVISION_ITEMS_INVALIDOS',
          message: 'La subcuenta no tiene items validos para facturar.'
        });
      }
      const divisionItemCount = Number(detallePedidoRowsFacturar[0]?.division_item_count || detallePedidoRowsFacturar.length);
      if (divisionItemCount !== detallePedidoRowsFacturar.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          code: 'CUENTA_DIVISION_ITEMS_INVALIDOS',
          message: 'La subcuenta no tiene items validos para facturar.'
        });
      }
    }
    ventasPerfContext.items_count = detallePedidoRowsFacturar.length;

    const scopeSessionStart = ventasPerf.now();
    const scope = await resolveRequestUserSucursalScope(req, client);
    const userId = parseOptionalPositiveInt(scope.idUsuario);
    ventasPerfContext.id_usuario = userId || null;
    if (!userId) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: true, message: 'No se pudo resolver el usuario autenticado.' });
    }

    const idSucursalPedido = parseOptionalPositiveInt(pedido.id_sucursal);
    ventasPerfContext.id_sucursal = idSucursalPedido || null;
    const isSuperAdmin = Boolean(scope?.isSuperAdmin);
    const allowedSucursalIds = Array.isArray(scope?.allowedSucursalIds) ? scope.allowedSucursalIds.map((id) => parseOptionalPositiveInt(id)).filter(Boolean) : [];
    const userSucursalId = parseOptionalPositiveInt(scope?.userSucursalId);
    const effectiveAllowedSucursalIds = allowedSucursalIds.length > 0 ? allowedSucursalIds : userSucursalId ? [userSucursalId] : [];
    if (!isSuperAdmin && !effectiveAllowedSucursalIds.includes(idSucursalPedido)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: true, message: 'No puedes operar pedidos de otra sucursal.' });
    }

    const idSesionCajaRequested = parseOptionalPositiveInt(req.body?.id_sesion_caja);
    const sessionActiva = await resolveCajaSession({
      client,
      idSucursal: idSucursalPedido,
      idUsuario: userId,
      idSesionCaja: idSesionCajaRequested,
      isSuperAdmin
    });
    if (!sessionActiva.ok) {
      await client.query('ROLLBACK');
      return res.status(mapPedidoPendienteSessionStatus(sessionActiva.reason)).json({
        error: true,
        code: sessionActiva.reason || 'NO_ACTIVE_SESSION',
        message: sessionActiva.reason === 'SESSION_SCOPE_MISMATCH'
          ? 'La caja activa no pertenece a la sucursal del pedido.'
          : 'Debe abrir o participar en una sesion de caja activa para registrar el pago.'
      });
    }
    ventasPerf.add('registrar_pago_scope_session_ms', scopeSessionStart);

    const metodoPago = await resolveMetodoPagoRegistroPedido(client, {
      idMetodoPago: req.body?.id_metodo_pago,
      metodoPagoRaw: req.body?.metodo_pago
    });
    if (!metodoPago) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'El metodo de pago seleccionado no esta disponible.' });
    }

    const metodoPagoAfectaEfectivo = parseBooleanish(metodoPago.afecta_efectivo);
    const referenciaPago = normalizePedidoText(req.body?.referencia_pago ?? req.body?.referencia, 120);
    if (!metodoPagoAfectaEfectivo && !referenciaPago) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'referencia_pago es obligatoria para pagos con tarjeta o transferencia.' });
    }

    const totalPendientePedido = roundMoney(pagoControl.monto_pendiente || pedido.total);
    const montoCobro = cuentaDivisionPago
      ? roundMoney(cuentaDivisionPago.monto_pendiente || cuentaDivisionPago.total)
      : totalPendientePedido;
    if (montoCobro <= 0 || roundMoney(pedido.total) <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_TOTAL_INVALIDO', message: 'El total pendiente del pedido no es valido.' });
    }

    const montoRecibidoInput = req.body?.monto_recibido ?? req.body?.efectivo_entregado;
    const montoRecibido = metodoPagoAfectaEfectivo ? parseNonNegativeNumber(montoRecibidoInput) : null;
    if (metodoPagoAfectaEfectivo && montoRecibido === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'monto_recibido debe ser numerico para pagos en efectivo.' });
    }
    if (metodoPagoAfectaEfectivo && montoRecibido < montoCobro) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'El efectivo recibido no puede ser menor al total pendiente.' });
    }

    const estadoPagadoCatalog = contextoBase.estado_pagado
      ? {
          id: parseOptionalPositiveInt(contextoBase.estado_pagado.id),
          codigo: String(contextoBase.estado_pagado.codigo || PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO).trim().toUpperCase()
        }
      : null;
    if (!estadoPagadoCatalog) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'CAT_ESTADO_PAGO_NO_ENCONTRADO', message: 'No se encontro el estado PAGADO_CONFIRMADO.' });
    }

    const costoEnvio = roundMoney(contextoBase.delivery?.costo_envio || 0);
    const isvPedido = 0;
    const totalPedido = roundMoney(pedido.total || totalPendientePedido);
    if (!cuentaDivisionPago && Math.abs(totalPendientePedido - totalPedido) > 0.05) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_TOTAL_NO_CUADRA', message: 'El monto pendiente no coincide con el total del pedido.' });
    }
    ventasPerfContext.id_caja = parseOptionalPositiveInt(sessionActiva.data.id_caja) || null;
    ventasPerfContext.id_sesion_caja = parseOptionalPositiveInt(sessionActiva.data.id_sesion_caja) || null;
    ventasPerf.add('registrar_pago_contexto_ms', contextoStart);

    const facturaCobroStart = ventasPerf.now();
    let correlativoVenta = null;
    let idFactura = null;
    if (!cuentaDivisionPago && idFacturaPrevia) {
      idFactura = idFacturaPrevia;
      correlativoVenta = {
        codigo: facturaPrevia?.codigo_venta || null,
        fecha_operacion: facturaPrevia?.fecha_operacion || null
      };
    } else {
      correlativoVenta = await generarCodigoDocumento({
        client,
        idSucursal: idSucursalPedido,
        tipoDocumento: 'VENTA',
        perf: ventasPerf
      });
    }
    const cambio = metodoPagoAfectaEfectivo ? roundMoney(montoRecibido - montoCobro) : 0;

    if (!idFactura) {
      const facturaResult = await client.query(
        `
          INSERT INTO facturas (
            id_caja,
            id_pedido,
            id_sucursal,
            id_usuario,
            id_cliente,
            codigo_venta,
            fecha_operacion,
            efectivo_entregado,
            cambio,
            fecha_hora_facturacion,
            isv_15,
            isv_18,
            id_sesion_caja
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, (NOW() AT TIME ZONE 'America/Tegucigalpa'), $10, 0, $11)
          RETURNING id_factura
        `,
        [
          Number(sessionActiva.data.id_caja),
          idPedido,
          idSucursalPedido,
          userId,
          parseOptionalPositiveInt(pedido.id_cliente),
          correlativoVenta.codigo,
          correlativoVenta.fecha_operacion,
          metodoPagoAfectaEfectivo ? montoRecibido : null,
          cambio,
          isvPedido,
          Number(sessionActiva.data.id_sesion_caja)
        ]
      );
      idFactura = Number(facturaResult.rows?.[0]?.id_factura || 0);

      const facturacionVenta = await obtenerConfigFacturacionParaVenta(client, idSucursalPedido);
      await aplicarSnapshotEnFactura(client, idFactura, facturacionVenta.snapshot, facturacionVenta.idConfig);
    }

    await client.query(
      `
        INSERT INTO facturas_cobros (
          id_factura,
          id_sesion_caja,
          id_caja,
          id_sucursal,
          id_usuario_ejecutor,
          id_metodo_pago,
          monto,
          referencia,
          observacion,
          id_cuenta_division,
          fecha_cobro,
          fecha_creacion
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (NOW() AT TIME ZONE 'America/Tegucigalpa'), (NOW() AT TIME ZONE 'America/Tegucigalpa'))
      `,
      [
        idFactura,
        Number(sessionActiva.data.id_sesion_caja),
        Number(sessionActiva.data.id_caja),
        idSucursalPedido,
        userId,
        Number(metodoPago.id_metodo_pago),
        montoCobro,
        referenciaPago,
        normalizePedidoText(req.body?.observacion_pago, 250),
        cuentaDivisionPago ? Number(cuentaDivisionPago.id_cuenta_division) : null
      ]
    );
    ventasPerf.add('registrar_pago_factura_cobro_ms', facturaCobroStart);

    const detalleFinalStart = ventasPerf.now();
    let detallesTotal = 0;
    let deliveryFacturado = 0;
    if (!idFacturaPrevia || cuentaDivisionPago) {
      const detallePedidoExtrasById = detallePedidoExtrasByIdCache || await fetchDetallePedidoExtras(
        client,
        detallePedidoRowsFacturar.map((row) => row.id_detalle_pedido)
      );
      const detalleRowsConExtras = detallePedidoRowsFacturar.map((row) => ({
        ...row,
        extras_detalle: detallePedidoExtrasById.get(Number(row.id_detalle_pedido)) || []
      }));
      const detallesInsertados = await insertDetalleFacturasDesdePedidoBatch({
        client,
        idFactura,
        idPedido,
        rows: detalleRowsConExtras
      });
      detallesTotal = roundMoney(detallesInsertados.totalDetalle);
      if (!cuentaDivisionPago) {
        deliveryFacturado = await insertDetalleFacturaDelivery({ client, idFactura, idPedido, costoEnvio });
      }
      if (cuentaDivisionPago) {
        await client.query(
          `
            UPDATE public.ventas_cuenta_divisiones
            SET id_factura = $2,
                fecha_actualizacion = (NOW() AT TIME ZONE 'America/Tegucigalpa')
            WHERE id_cuenta_division = $1
          `,
          [Number(cuentaDivisionPago.id_cuenta_division), idFactura]
        );
      }
    }
    ventasPerf.add('registrar_pago_detalle_final_ms', detalleFinalStart);

    const baseFacturada = roundMoney(detallesTotal + deliveryFacturado);
    const totalFacturadoCalculado = baseFacturada;
    if ((!idFacturaPrevia || cuentaDivisionPago) && Math.abs(totalFacturadoCalculado - montoCobro) > 0.05) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_FACTURA_NO_CUADRA', message: 'El detalle facturado no cuadra con el total del pedido.' });
    }

    const observacionPago = normalizePedidoText(req.body?.observacion_pago, 250);
    let estadoPagoRespuesta = PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO;
    let montoPagadoRespuesta = montoCobro;
    let montoPendienteRespuesta = 0;
    let pedidoPagadoCompleto = true;
    if (cuentaDivisionPago) {
      await client.query(
        `
          UPDATE public.ventas_cuenta_divisiones
          SET estado = 'PAGADA',
              monto_pagado = total,
              monto_pendiente = 0,
              fecha_actualizacion = (NOW() AT TIME ZONE 'America/Tegucigalpa')
          WHERE id_cuenta_division = $1
        `,
        [Number(cuentaDivisionPago.id_cuenta_division)]
      );
      const divisionSummary = await client.query(
        `
          SELECT
            COALESCE(SUM(total), 0)::numeric(14,2) AS total_dividido,
            COALESCE(SUM(monto_pagado), 0)::numeric(14,2) AS monto_pagado,
            COALESCE(SUM(monto_pendiente), 0)::numeric(14,2) AS monto_pendiente,
            COUNT(*) FILTER (WHERE UPPER(TRIM(estado)) = 'PENDIENTE')::int AS pendientes
          FROM public.ventas_cuenta_divisiones
          WHERE id_pedido = $1
        `,
        [idPedido]
      );
      const summary = divisionSummary.rows?.[0] || {};
      const totalDividido = roundMoney(summary.total_dividido);
      const montoPendienteSinAsignar = Math.max(roundMoney(totalPedido - totalDividido), 0);
      montoPagadoRespuesta = roundMoney(summary.monto_pagado);
      montoPendienteRespuesta = roundMoney(Number(summary.monto_pendiente || 0) + montoPendienteSinAsignar);
      pedidoPagadoCompleto = Number(summary.pendientes || 0) === 0
        && montoPendienteRespuesta <= 0.05
        && Math.abs(totalDividido - totalPedido) <= 0.05;
      estadoPagoRespuesta = pedidoPagadoCompleto ? PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO : PEDIDO_PENDIENTE_ESTADO_PAGO;

      await client.query(
        `
          UPDATE public.pedidos_pago_control
          SET id_estado_pago_pedido = $2,
              monto_pagado = $3,
              monto_pendiente = $4,
              fecha_pago_confirmado = CASE WHEN $5::boolean THEN (NOW() AT TIME ZONE 'America/Tegucigalpa') ELSE NULL END,
              id_usuario_confirma_pago = CASE WHEN $5::boolean THEN $6 ELSE id_usuario_confirma_pago END,
              id_sesion_caja_pago = $7,
              id_factura = CASE WHEN $5::boolean THEN $8 ELSE id_factura END,
              observacion_pago = $9,
              fecha_actualizacion = (NOW() AT TIME ZONE 'America/Tegucigalpa')
          WHERE id_pedido_pago_control = $1
        `,
        [
          Number(pagoControl.id_pedido_pago_control),
          pedidoPagadoCompleto ? estadoPagadoCatalog.id : Number(pagoControl.id_estado_pago_pedido),
          montoPagadoRespuesta,
          montoPendienteRespuesta,
          pedidoPagadoCompleto,
          userId,
          Number(sessionActiva.data.id_sesion_caja),
          idFactura,
          observacionPago
        ]
      );
    } else {
      await client.query(
        `
          UPDATE public.pedidos_pago_control
          SET id_estado_pago_pedido = $2,
              monto_pagado = $3,
              monto_pendiente = 0,
              fecha_pago_confirmado = (NOW() AT TIME ZONE 'America/Tegucigalpa'),
              id_usuario_confirma_pago = $4,
              id_sesion_caja_pago = $5,
              id_factura = $6,
              observacion_pago = $7,
              fecha_actualizacion = (NOW() AT TIME ZONE 'America/Tegucigalpa')
          WHERE id_pedido_pago_control = $1
        `,
        [
          Number(pagoControl.id_pedido_pago_control),
          estadoPagadoCatalog.id,
          montoCobro,
          userId,
          Number(sessionActiva.data.id_sesion_caja),
          idFactura,
          observacionPago
        ]
      );
    }

    if (pedidoPagadoCompleto) {
      await updatePedidoLegacyPagoConfirmado({ client, idPedido, userId });
    }

    const fidelizacionStart = ventasPerf.now();
    const acumulacionFidelizacion = pedidoPagadoCompleto
      ? await registerFacturaLoyaltyAccumulation({
        client,
        idFactura,
        idPedido,
        idCliente: parseOptionalPositiveInt(pedido.id_cliente),
        idSucursal: idSucursalPedido,
        idUsuarioEjecutor: userId,
        montoFactura: totalPedido
      })
      : { created: false };
    ventasPerf.add('fidelizacion_ms', fidelizacionStart);

    const commitStart = ventasPerf.now();
    await client.query('COMMIT');
    ventasPerf.add('commit_ms', commitStart);
    ventasPerf.log({ ...ventasPerfContext, status: 201 });

    return res.status(201).json({
      message: 'Pago registrado correctamente.',
      id_pedido: idPedido,
      id_factura: idFactura,
      codigo_venta: correlativoVenta.codigo,
      estado_pago: estadoPagoRespuesta,
      id_cuenta_division: cuentaDivisionPago ? Number(cuentaDivisionPago.id_cuenta_division) : null,
      total: montoCobro,
      monto_pagado: montoPagadoRespuesta,
      monto_pendiente: montoPendienteRespuesta,
      cambio,
      id_sesion_caja: Number(sessionActiva.data.id_sesion_caja),
      metodo_pago: String(metodoPago.codigo || metodoPago.nombre || '').toUpperCase(),
      fidelizacion: acumulacionFidelizacion.created
        ? {
            puntos_acumulados: acumulacionFidelizacion.points,
            saldo_nuevo: acumulacionFidelizacion.saldoNuevo
          }
        : null
    });
  } catch (err) {
    await client.query('ROLLBACK');
    ventasPerf.log({
      ...ventasPerfContext,
      status: Number.isInteger(err?.httpStatus) ? err.httpStatus : 500,
      error_code: err?.code || null
    });
    console.error('Error al registrar pago de pedido pendiente:', err);
    if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 500) {
      return res.status(err.httpStatus).json({
        error: true,
        code: err.code || 'PEDIDO_REGISTRAR_PAGO_ERROR',
        message: err.publicMessage || 'No se pudo registrar el pago del pedido.'
      });
    }
    return res.status(500).json({ error: true, message: 'No se pudo registrar el pago del pedido.' });
  } finally {
    ventasPerf.logIfMissing({
      ...ventasPerfContext,
      status: res.statusCode || null,
      completion: 'finally'
    });
    client.release();
  }
});

router.post('/ventas', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const ventasPerf = createVentasPerfTracker();
  logVentasPerfRoute('POST /ventas', {
    items_count: Array.isArray(req.body?.items) ? req.body.items.length : 0,
    has_pedido_pendiente: false
  });
  const cuentaDivididaSolicitada = hasCuentaDivididaPayload(req.body);
  const ventasRpcV2Enabled = !cuentaDivididaSolicitada && isVentasRpcV2Enabled();
  const ventasRpcV1Enabled = !cuentaDivididaSolicitada && isVentasRpcTransactionEnabled();
  const ventasPerfContext = {
    id_usuario: null,
    id_sucursal: null,
    id_caja: null,
    id_sesion_caja: null,
    items_count: Array.isArray(req.body?.items) ? req.body.items.length : 0,
    rpc_enabled: ventasRpcV2Enabled || ventasRpcV1Enabled,
    rpc_v2_enabled: ventasRpcV2Enabled,
    rpc_version: ventasRpcV2Enabled ? 'v2' : ventasRpcV1Enabled ? 'v1' : 'legacy'
  };
  const authContextStart = ventasPerf.now();
  const discountIntent = hasDiscountIntentInPayload(req.body);
  let canApplyDiscount = false;
  if (discountIntent) {
    const authPermissionStart = ventasPerf.now();
    canApplyDiscount = await requestHasAnyPermission(req, [VENTAS_DESCUENTO_APLICAR_PERMISSION]);
    ventasPerf.add('auth_permission_ms', authPermissionStart);
  }
  if (discountIntent && !canApplyDiscount) {
    ventasPerf.add('auth_context_ms', authContextStart);
    ventasPerf.log({
      ...ventasPerfContext,
      status: 403,
      error_code: 'VENTAS_DESCUENTO_NO_AUTORIZADO'
    });
    return res.status(403).json({
      error: true,
      code: 'VENTAS_DESCUENTO_NO_AUTORIZADO',
      message: 'No tienes permiso para aplicar descuentos en ventas.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const authScopeStart = ventasPerf.now();
    const scope = await resolveRequestUserSucursalScope(req, client);
    ventasPerf.add('auth_scope_ms', authScopeStart);
    const userId = parseOptionalPositiveInt(scope.idUsuario);
    ventasPerfContext.id_usuario = userId || null;
    ventasPerf.add('auth_context_ms', authContextStart);

    const prepared = await buildVentaPayload({
      client,
      body: req.body,
      userId,
      sucursalScope: scope,
      canApplyDiscount,
      perf: ventasPerf
    });

    if (!prepared.ok) {
      await client.query('ROLLBACK');
      ventasPerf.log({
        ...ventasPerfContext,
        status: prepared.status,
        error_code: prepared.body?.code || null
      });
      return res.status(prepared.status).json(prepared.body);
    }

    const venta = prepared.data;
    const amountValidation = validateVentaMontoCobro({ venta });
    if (!amountValidation.ok) {
      await client.query('ROLLBACK');
      ventasPerf.log({
        ...ventasPerfContext,
        status: amountValidation.status,
        error_code: amountValidation.code
      });
      return res.status(amountValidation.status).json({
        error: true,
        code: amountValidation.code,
        message: amountValidation.message
      });
    }
    const allLines = [...venta.all_lines];
    const cuentaDivisionPlan = buildCuentaDivisionPlan({
      cuentaDividida: req.body?.cuenta_dividida,
      lines: allLines,
      expectedTotal: venta.total
    });
    Object.assign(ventasPerfContext, {
      id_usuario: parseOptionalPositiveInt(venta.id_usuario) || userId || null,
      id_sucursal: parseOptionalPositiveInt(venta.id_sucursal),
      id_caja: parseOptionalPositiveInt(venta.id_caja),
      id_sesion_caja: parseOptionalPositiveInt(venta.id_sesion_caja),
      items_count: allLines.length
    });
    const ventaHasExtras = hasVentaExtras(venta);
    if (ventaHasExtras && ventasRpcV2Enabled) {
      ventasPerfContext.rpc_version = 'v2_extras';
    } else if (ventaHasExtras) {
      ventasPerfContext.rpc_enabled = false;
      ventasPerfContext.rpc_version = 'legacy_extras';
    }

    if (ventasRpcV2Enabled) {
      const rpcCreateResult = await createVentaWithRpcV2Transaction({
        client,
        venta,
        perf: ventasPerf,
        requestStartedAt: authContextStart
      });
      if (ventaHasExtras) {
        const idPedidoRpc = parseOptionalPositiveInt(rpcCreateResult.fidelizacionJob?.idPedido);
        if (!idPedidoRpc) {
          throw {
            httpStatus: 500,
            code: 'VENTAS_RPC_V2_PEDIDO_INVALIDO',
            publicMessage: 'La venta fue procesada por RPC V2, pero no devolvio pedido valido para descontar extras.'
          };
        }
      }

      const commitStart = ventasPerf.now();
      await client.query('COMMIT');
      ventasPerf.add('commit_ms', commitStart);

      ventasPerf.add('node_after_rpc_ms', rpcCreateResult.afterRpcStart);
      ventasPerf.log({ ...ventasPerfContext, status: 201 });
      res.status(201).json(rpcCreateResult.response);

      void registerVentaFidelizacionAfterCommit(rpcCreateResult.fidelizacionJob);
      return;
    }

    if (ventasRpcV1Enabled && !ventaHasExtras) {
      const rpcCreateResult = await createVentaWithRpcTransaction({
        client,
        venta,
        perf: ventasPerf,
        requestStartedAt: authContextStart
      });

      const commitStart = ventasPerf.now();
      await client.query('COMMIT');
      ventasPerf.add('commit_ms', commitStart);

      ventasPerf.add('node_after_rpc_ms', rpcCreateResult.afterRpcStart);
      ventasPerf.log({ ...ventasPerfContext, status: 201 });
      res.status(201).json(rpcCreateResult.response);

      void registerVentaFidelizacionAfterCommit(rpcCreateResult.fidelizacionJob);
      return;
    }

    const correlativoStart = ventasPerf.now();
    const correlativoVenta = await generarCodigoDocumento({
      client,
      idSucursal: venta.id_sucursal,
      tipoDocumento: 'VENTA',
      perf: ventasPerf
    });
    ventasPerf.add('factura_correlativo_ms', correlativoStart);
    ventasPerf.add('factura_ms', correlativoStart);

    const descuentosStart = ventasPerf.now();
    for (const line of allLines) {
      let idDescuento = null;

      if (line.descuento > 0) {
        const descuentoResult = await client.query(
          `
            INSERT INTO descuentos (monto_descuento, id_descuento_catalogo)
            VALUES ($1, $2)
            RETURNING id_descuento
          `,
          [line.descuento, line.id_descuento_catalogo]
        );
        idDescuento = descuentoResult.rows[0].id_descuento;
      }

      line.id_descuento = idDescuento;
    }
    ventasPerf.add('detalle_pedido_descuentos_ms', descuentosStart);
    ventasPerf.add('totals_ms', descuentosStart);

    let idPedido = null;

    if (!venta.requires_pedido || !Array.isArray(venta.pedido_lines) || venta.pedido_lines.length === 0) {
      throw {
        httpStatus: 409,
        code: 'VENTAS_PEDIDO_REQUERIDO',
        publicMessage: 'No se pudo completar la venta: se requiere pedido de cocina.'
      };
    }

    const pedidoStart = ventasPerf.now();
    const pedidoResult = await client.query(
      `
        INSERT INTO pedidos (
          descripcion_pedido,
          descripcion_envio,
          fecha_hora_pedido,
          sub_total,
          isv,
          total,
          id_estado_pedido,
          id_sucursal,
          id_cliente,
          id_usuario,
          origen_pedido
        )
        VALUES ($1, $2, (NOW() AT TIME ZONE 'America/Tegucigalpa'), $3, $4, $5, $6, $7, $8, $9, 'CAJA')
        RETURNING id_pedido, fecha_hora_pedido
      `,
      [
        venta.descripcion_pedido,
        venta.descripcion_envio,
        venta.pedido_subtotal,
        venta.pedido_isv,
        venta.pedido_total,
        venta.id_estado_pedido,
        venta.id_sucursal,
        venta.id_cliente,
        venta.id_usuario
      ]
    );

    idPedido = Number(pedidoResult.rows[0].id_pedido);
    const fechaHoraPedido = pedidoResult.rows[0].fecha_hora_pedido || null;
    ventasPerf.add('pedido_ms', pedidoStart);

    const detallePedidoStart = ventasPerf.now();
    const detallePedidoLookupStart = ventasPerf.now();
    const detallePedidoSchemaCacheKey = 'detalle_pedido.configuracion_menu';
    const hasDetallePedidoConfigCache = schemaColumnCache.has(detallePedidoSchemaCacheKey);
    const hasDetallePedidoConfiguracionMenu = await hasColumn(
      client,
      'detalle_pedido',
      'configuracion_menu'
    );
    if (hasDetallePedidoConfigCache) {
      ventasPerf.add('detalle_pedido_reuse_hydrated_ms', detallePedidoLookupStart);
    } else {
      ventasPerf.add('detalle_pedido_lookup_ms', detallePedidoLookupStart);
    }

    const detallePedidoInsertStart = ventasPerf.now();
    const detallePedidoRows = venta.pedido_lines.map((line) => ({
      line,
      configuracionMenu: buildComplementLineConfig(line),
      complementSnapshot: buildComplementSnapshot(line)
    }));
    const pedidoLineRefs = [];

    if (detallePedidoRows.length > 0) {
      const detallePedidoParams = [];
      let detallePedidoValues;
      let detallePedidoResult;

      if (hasDetallePedidoConfiguracionMenu) {
        detallePedidoValues = detallePedidoRows.map((_, index) => {
          const base = index * 10;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::jsonb)`;
        }).join(', ');
        for (const { line, configuracionMenu } of detallePedidoRows) {
          detallePedidoParams.push(
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.cantidad,
            line.observacion,
            configuracionMenu ? JSON.stringify(configuracionMenu) : null
          );
        }
        detallePedidoResult = await client.query(
          `
            INSERT INTO detalle_pedido (
              sub_total_pedido,
              total_pedido,
              id_producto,
              id_pedido,
              id_descuento,
              estado,
              id_combo,
              id_receta,
              cantidad,
              observacion,
              configuracion_menu
            )
            VALUES ${detallePedidoValues}
            RETURNING id_detalle_pedido
          `,
          detallePedidoParams
        );
      } else {
        detallePedidoValues = detallePedidoRows.map((_, index) => {
          const base = index * 9;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
        }).join(', ');
        for (const { line } of detallePedidoRows) {
          detallePedidoParams.push(
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.cantidad,
            line.observacion
          );
        }
        detallePedidoResult = await client.query(
          `
            INSERT INTO detalle_pedido (
              sub_total_pedido,
              total_pedido,
              id_producto,
              id_pedido,
              id_descuento,
              estado,
              id_combo,
              id_receta,
              cantidad,
              observacion
            )
            VALUES ${detallePedidoValues}
            RETURNING id_detalle_pedido
          `,
          detallePedidoParams
        );
      }

      detallePedidoRows.forEach(({ line, configuracionMenu, complementSnapshot }, index) => {
        const insertedDetallePedido = detallePedidoResult.rows?.[index] || {};
        pedidoLineRefs.push({
          ...line,
          id_detalle_pedido: Number(insertedDetallePedido.id_detalle_pedido || 0),
          tipo_item: normalizeTipoItem(line.kind),
          configuracion_menu: configuracionMenu,
          origen_snapshot: {
            tipo_item: normalizeTipoItem(line.kind),
            nombre_item: line.nombre_item || null,
            id_producto: line.id_producto || null,
            id_receta: line.id_receta || null,
            id_combo: line.id_combo || null,
            cantidad: Number(line.cantidad || 0),
            precio_unitario: roundMoney(line.precio_unitario),
            total_detalle: roundMoney(line.total_linea),
            subtotal_extras: roundMoney(line.subtotal_extras),
            descuento: roundMoney(line.descuento),
            descuento_linea: roundMoney(line.descuento_linea),
            descuento_global: roundMoney(line.descuento_global),
            id_descuento_catalogo_linea: line.id_descuento_catalogo_linea_aplicado || null,
            id_descuento_catalogo_global: line.id_descuento_catalogo_global || null,
            observacion: line.observacion || null,
            componentes: complementSnapshot,
            extras: Array.isArray(line.extras_detalle) ? line.extras_detalle : []
          }
        });
      });
      for (const ref of pedidoLineRefs) {
        await insertDetallePedidoExtras({
          client,
          idDetallePedido: ref.id_detalle_pedido,
          extras: ref.extras_detalle
        });
      }
    }
    ventasPerf.add('detalle_pedido_insert_ms', detallePedidoInsertStart);
    ventasPerf.add('detalle_pedido_ms', detallePedidoStart);
    const facturaInsertStart = ventasPerf.now();
    const facturaResult = await client.query(
      `
        INSERT INTO facturas (
          id_caja,
          id_pedido,
          id_sucursal,
          id_usuario,
          id_cliente,
          codigo_venta,
          fecha_operacion,
          efectivo_entregado,
          cambio,
          fecha_hora_facturacion,
          isv_15,
          isv_18,
          id_sesion_caja
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, (NOW() AT TIME ZONE 'America/Tegucigalpa'), $10, 0, $11)
        RETURNING id_factura, fecha_hora_facturacion, fecha_operacion
      `,
      [
        venta.id_caja,
        idPedido,
        venta.id_sucursal,
        venta.id_usuario,
        venta.id_cliente,
        correlativoVenta.codigo,
        correlativoVenta.fecha_operacion,
        venta.efectivo_entregado,
        venta.cambio,
        venta.isv,
        venta.id_sesion_caja
      ]
    );

    const facturaRow = facturaResult.rows[0] || {};
    const idFactura = Number(facturaRow.id_factura || 0);
    const fechaHoraFacturacion = facturaRow.fecha_hora_facturacion || fechaHoraPedido || null;
    ventasPerf.add('factura_insert_ms', facturaInsertStart);
    ventasPerf.add('factura_ms', facturaInsertStart);

    const facturaSnapshotStart = ventasPerf.now();
    const facturacionVenta = await obtenerConfigFacturacionParaVenta(client, venta.id_sucursal, {
      perf: ventasPerf
    });
    await aplicarSnapshotEnFactura(
      client,
      idFactura,
      facturacionVenta.snapshot,
      facturacionVenta.idConfig
    );
    ventasPerf.add('factura_snapshot_ms', facturaSnapshotStart);
    ventasPerf.add('factura_ms', facturaSnapshotStart);

    const cobroStart = ventasPerf.now();
    const idMetodoPago = parseOptionalPositiveInt(venta.id_metodo_pago);
    if (!idMetodoPago) {
      throw {
        httpStatus: 409,
        code: 'VENTAS_METODO_PAGO_INVALIDO',
        publicMessage: 'No se pudo resolver el metodo de pago de la venta.'
      };
    }

    if (!cuentaDivisionPlan) {
      await client.query(
        `
          INSERT INTO facturas_cobros (
            id_factura,
            id_sesion_caja,
            id_caja,
            id_sucursal,
            id_usuario_ejecutor,
            id_metodo_pago,
            monto,
            referencia,
            fecha_cobro,
            fecha_creacion
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (NOW() AT TIME ZONE 'America/Tegucigalpa'), (NOW() AT TIME ZONE 'America/Tegucigalpa'))
        `,
        [
          idFactura,
          venta.id_sesion_caja,
          venta.id_caja,
          venta.id_sucursal,
          venta.id_usuario,
          idMetodoPago,
          venta.total,
          venta.referencia_pago
        ]
      );
    }
    ventasPerf.add('cobro_ms', cobroStart);

    const detalleFacturaStart = ventasPerf.now();
    const detalleFacturaRows = venta.all_lines.map((line, index) => {
      const pedidoRef = pedidoLineRefs[index] || null;
      const complementSnapshot = buildComplementSnapshot(line);
      const tipoItem = pedidoRef?.tipo_item || normalizeTipoItem(line.kind);
      const origenSnapshot = pedidoRef?.origen_snapshot || {
        tipo_item: tipoItem,
        nombre_item: line.nombre_item || null,
        id_producto: line.id_producto || null,
        id_receta: line.id_receta || null,
        id_combo: line.id_combo || null,
        cantidad: Number(line.cantidad || 0),
        precio_unitario: roundMoney(line.precio_unitario),
        total_detalle: roundMoney(line.total_linea),
        subtotal_extras: roundMoney(line.subtotal_extras),
        descuento: roundMoney(line.descuento),
        descuento_linea: roundMoney(line.descuento_linea),
        descuento_global: roundMoney(line.descuento_global),
        id_descuento_catalogo_linea: line.id_descuento_catalogo_linea_aplicado || null,
        id_descuento_catalogo_global: line.id_descuento_catalogo_global || null,
        observacion: line.observacion || null,
        componentes: complementSnapshot,
        extras: Array.isArray(line.extras_detalle) ? line.extras_detalle : []
      };

      return {
        line,
        pedidoRef,
        tipoItem,
        origenSnapshot
      };
    });

    let detalleFacturaResult = { rows: [] };
    if (detalleFacturaRows.length > 0) {
      const detalleFacturaInsertStart = ventasPerf.now();
      const detalleFacturaParams = [];
      const detalleFacturaValues = buildBatchPlaceholders(detalleFacturaRows.length, 13, {
        12: '::jsonb'
      });
      for (const { line, pedidoRef, tipoItem, origenSnapshot } of detalleFacturaRows) {
        detalleFacturaParams.push(
          idFactura,
          line.id_producto,
          line.id_descuento,
          line.cantidad,
          line.precio_unitario,
          line.sub_total,
          line.total_linea,
          idPedido,
          pedidoRef?.id_detalle_pedido || null,
          tipoItem,
          line.id_receta,
          line.id_combo,
          JSON.stringify(origenSnapshot)
        );
      }

      detalleFacturaResult = await client.query(
        `
          INSERT INTO detalle_facturas (
            id_factura,
            id_producto,
            id_descuento,
            cantidad,
            precio_unitario,
            sub_total,
            total_detalle,
            id_pedido,
            id_detalle_pedido,
            tipo_item,
            id_receta,
            id_combo,
            origen_snapshot
          )
          VALUES ${detalleFacturaValues}
          RETURNING
            id_detalle_factura,
            id_detalle_pedido,
            tipo_item,
            id_producto,
            id_receta,
            id_combo,
            origen_snapshot
        `,
        detalleFacturaParams
      );
      ventasPerf.add('detalle_factura_insert_ms', detalleFacturaInsertStart);

      const detalleFacturaOrigenStart = ventasPerf.now();
      const detalleFacturaOrigenRows = detalleFacturaResult.rows.filter((row) =>
        Number(row.id_detalle_factura || 0) > 0
      );
      if (detalleFacturaOrigenRows.length > 0) {
        const detalleFacturaOrigenParams = [];
        const detalleFacturaOrigenValues = buildBatchPlaceholders(detalleFacturaOrigenRows.length, 7, {
          6: '::jsonb'
        });
        for (const row of detalleFacturaOrigenRows) {
          detalleFacturaOrigenParams.push(
            Number(row.id_detalle_factura || 0),
            row.id_detalle_pedido || null,
            row.tipo_item || 'ITEM',
            row.id_producto || null,
            row.id_receta || null,
            row.id_combo || null,
            JSON.stringify(row.origen_snapshot || {})
          );
        }

        await client.query(
          `
            INSERT INTO public.detalle_facturas_origen (
              id_detalle_factura,
              id_detalle_pedido,
              tipo_item,
              id_producto,
              id_receta,
              id_combo,
              origen_snapshot
            )
            VALUES ${detalleFacturaOrigenValues}
            ON CONFLICT (id_detalle_factura)
            DO UPDATE SET
              id_detalle_pedido = EXCLUDED.id_detalle_pedido,
              tipo_item = EXCLUDED.tipo_item,
              id_producto = EXCLUDED.id_producto,
              id_receta = EXCLUDED.id_receta,
              id_combo = EXCLUDED.id_combo,
              origen_snapshot = EXCLUDED.origen_snapshot
          `,
          detalleFacturaOrigenParams
        );
      }
      ventasPerf.add('detalle_factura_origen_ms', detalleFacturaOrigenStart);
    }
    ventasPerf.add('detalle_factura_ms', detalleFacturaStart);

    let cuentaDivididaResponse = null;
    if (cuentaDivisionPlan) {
      const lineRefs = detalleFacturaRows.map((entry, index) => ({
        id_detalle_factura: parseOptionalPositiveInt(detalleFacturaResult.rows?.[index]?.id_detalle_factura),
        id_detalle_pedido: parseOptionalPositiveInt(entry?.pedidoRef?.id_detalle_pedido)
      }));
      const persistedDivisions = await persistCuentaDividida({
        client,
        plan: cuentaDivisionPlan,
        idFactura,
        idPedido,
        lineRefs,
        estadoInicial: 'PAGADA'
      });
      await insertCuentaDivisionCobros({
        client,
        idFactura,
        idSesionCaja: venta.id_sesion_caja,
        idCaja: venta.id_caja,
        idSucursal: venta.id_sucursal,
        idUsuario: venta.id_usuario,
        idMetodoPago,
        referencia: venta.referencia_pago,
        divisions: persistedDivisions
      });
      cuentaDivididaResponse = await fetchCuentaDividida(client, { idFactura, idPedido });
    }

    const fidelizacionStart = ventasPerf.now();
    const acumulacionFidelizacion = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura,
      idPedido,
      idCliente: venta.id_cliente,
      idSucursal: venta.id_sucursal,
      idUsuarioEjecutor: venta.id_usuario,
      montoFactura: venta.total
    });
    ventasPerf.add('fidelizacion_ms', fidelizacionStart);

    const ticketResponseStart = ventasPerf.now();
    const facturacionNormalizada = await normalizarDatosTicketDesdeSnapshot({
      client,
      factura: {
        id_sucursal: venta.id_sucursal,
        facturacion_snapshot: facturacionVenta.snapshot
      }
    });
    const createDetailContext = await fetchCreateVentaDetailContext(client, {
      idCliente: venta.id_cliente,
      idUsuario: venta.id_usuario,
      idCaja: venta.id_caja
    });
    createDetailContext.nombre_sucursal = facturacionVenta.sucursal?.nombre_sucursal || null;
    const createDetailItems = buildCreatedVentaDetailItems({
      detalleFacturaRows,
      detalleFacturaRowsInserted: detalleFacturaResult.rows
    });
    const createVentaResponse = buildCreateVentaDetailResponse({
      idFactura,
      idPedido,
      venta,
      correlativoVenta,
      fechaHoraPedido,
      fechaHoraFacturacion,
      facturacion: facturacionNormalizada,
      context: createDetailContext,
      items: createDetailItems,
      fidelizacion: acumulacionFidelizacion,
      cuentaDividida: cuentaDivididaResponse
    });
    ventasPerf.add('ticket_response_build_ms', ticketResponseStart);

    const commitStart = ventasPerf.now();
    await client.query('COMMIT');
    ventasPerf.add('commit_ms', commitStart);
    ventasPerf.log(ventasPerfContext);

    res.status(201).json(createVentaResponse);
  } catch (err) {
    await client.query('ROLLBACK');
    ventasPerf.log({
      ...ventasPerfContext,
      status: Number.isInteger(err?.httpStatus) ? err.httpStatus : 500,
      error_code: err?.code || 'VENTAS_CREATE_ERROR'
    });
    console.error('Error al crear venta:', err);
    if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 500) {
      return res.status(err.httpStatus).json({
        error: true,
        code: err.code || 'VENTAS_CREATE_ERROR',
        message: err.publicMessage || 'No se pudo completar la venta.'
      });
    }
    res.status(500).json({ error: true, message: 'No se pudo completar la venta.' });
  } finally {
    ventasPerf.logIfMissing({
      ...ventasPerfContext,
      status: res.statusCode || null,
      error_code: res.statusCode >= 400 ? 'VENTAS_CREATE_NO_LOG' : null,
      completion: 'finally'
    });
    client.release();
  }
});


export default router;
