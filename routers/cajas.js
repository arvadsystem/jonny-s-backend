import express from 'express';
import { enviarCorreo } from '../utils/emailService.js';
import { buildCajaCierrePdfBuffer, buildCajaCierrePdfFilename } from '../utils/cajaCierreReportePdf.js';
import pool from '../config/db-connection.js';
import { getClientIp } from '../utils/security/clientInfo.js';
import {
  checkPermission,
  requestHasAnyPermission,
  requestHasAnyRole
} from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const router = express.Router();
const CAJAS_SCOPE_PERMISSION = 'VENTAS_CAJAS_MULTISUCURSAL_VER';
const ADMIN_ROLE_CODES = ['ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN'];
const CAJA_ADMIN_EMAIL_TO = 'gersonmz@jonnyshn.com';
const CAJA_APERTURA_EMAIL_TO = CAJA_ADMIN_EMAIL_TO;
const MANUAL_MOVEMENT_EXCLUDED_CODES = new Set(['APERTURA', 'REVERSION', 'REVERSO']);

const CATALOGS = Object.freeze({
  SESSION_STATES: { table: 'public.cat_cajas_sesiones_estados', id: 'id_estado_sesion_caja' },
  PARTICIPATION_ROLES: { table: 'public.cat_cajas_roles_participacion', id: 'id_rol_participacion_caja' },
  MOVEMENT_TYPES: { table: 'public.cat_cajas_movimientos_tipos', id: 'id_tipo_movimiento_caja' },
  RESOLUTIONS: { table: 'public.cat_cajas_resoluciones_cierre', id: 'id_resolucion_cierre_caja' },
  ARQUEO_TYPES: { table: 'public.cat_cajas_arqueos_tipos', id: 'id_tipo_arqueo_caja' },
  INCIDENT_TYPES: { table: 'public.cat_cajas_incidencias_tipos', id: 'id_tipo_incidencia_caja' },
  INCIDENT_STATES: { table: 'public.cat_cajas_incidencias_estados', id: 'id_estado_incidencia_caja' }
});

const USER_DISPLAY_SQL = `
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
    u.nombre_usuario
  )
`;
const ROLE_NORMALIZED_SQL = `UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g'))`;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseNullablePositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parsePositiveInt(value);
};

const parseNonNegativeAmount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
};

const parseNullableNonNegativeAmount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parseNonNegativeAmount(value);
};

const normalizeText = (value, maxLength = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const parseBooleanish = (value) =>
  value === true || value === 'true' || value === 1 || value === '1';

const parseBooleanWithDefault = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  return parseBooleanish(value);
};

const normalizeCajaCode = (value, maxLength = 40) => {
  const normalized = normalizeText(value, maxLength);
  if (!normalized) return null;
  return normalized.toUpperCase();
};

const createCajaError = (httpStatus, code, publicMessage, details = null) => {
  const error = new Error(publicMessage);
  error.httpStatus = httpStatus;
  error.code = code;
  error.publicMessage = publicMessage;
  if (details && typeof details === 'object') error.details = details;
  return error;
};

const createArqueoObservationRequiredError = (methodCode, message = null) => {
  const normalizedMethodCode = normalizeCajaCode(methodCode, 40) || 'EFECTIVO';
  return createCajaError(
    400,
    'VENTAS_CAJAS_ARQUEO_OBSERVACION_REQUIRED',
    message || `Debe indicar observación para ${normalizedMethodCode} cuando existe diferencia.`,
    {
      metodo_pago_codigo: normalizedMethodCode,
      field: 'observacion',
      focus_target: `arqueos.${normalizedMethodCode}.observacion`,
      step: normalizedMethodCode
    }
  );
};

const mapCajaAssignmentPgError = (err) => {
  if (err?.code === '23505') {
    if (err.constraint === 'uq_cajas_usuarios_autorizados_usuario_activo') {
      return createCajaError(
        409,
        'VENTAS_CAJAS_ASSIGN_USER_ACTIVE_DUPLICATE',
        'El usuario ya tiene una caja activa asignada.'
      );
    }
    if (err.constraint === 'uq_cajas_usuarios_autorizados_responsable_activo') {
      return createCajaError(
        409,
        'VENTAS_CAJAS_ASSIGN_RESPONSABLE_DUPLICATE',
        'La caja ya tiene un responsable activo asignado.'
      );
    }
  }

  if (
    err?.code === '23514' &&
    err.constraint === 'ck_cajas_usuarios_autorizados_rol_activo_exclusivo'
  ) {
    return createCajaError(
      409,
      'VENTAS_CAJAS_ASSIGN_ROLE_INVALID',
      'La asignacion activa debe ser responsable o auxiliar, nunca ambos.'
    );
  }

  return err;
};

const sendInternalError = (
  res,
  err,
  defaultCode = 'VENTAS_CAJAS_INTERNAL_ERROR',
  defaultMessage = 'No se pudo procesar la solicitud de Gestion de cajas.'
) => {
  if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 500) {
    console.warn('[cajas]', {
      status: err.httpStatus,
      code: err.code || defaultCode,
      message: err.publicMessage || defaultMessage
    });
    const payload = {
      error: true,
      code: err.code || defaultCode,
      message: err.publicMessage || defaultMessage
    };
    if (err.details && typeof err.details === 'object') payload.details = err.details;
    return res.status(err.httpStatus).json(payload);
  }

  console.error('[cajas]', err);

  return res.status(500).json({
    error: true,
    code: defaultCode,
    message: defaultMessage
  });
};

const getCatalogId = async (client, catalogKey, code) => {
  const catalog = CATALOGS[catalogKey];
  if (!catalog) {
    throw createCajaError(500, 'VENTAS_CAJAS_CATALOG_CONFIG_ERROR', 'No se pudo procesar la solicitud de Gestion de cajas.');
  }

  const result = await client.query(
    `SELECT ${catalog.id} AS id FROM ${catalog.table} WHERE UPPER(TRIM(codigo)) = UPPER($1) LIMIT 1`,
    [code]
  );

  return Number(result.rows?.[0]?.id || 0) || null;
};

const getCatalogCodeById = async (client, catalogKey, id) => {
  const catalog = CATALOGS[catalogKey];
  const safeId = parsePositiveInt(id);
  if (!catalog || !safeId) return null;
  const result = await client.query(
    `SELECT UPPER(TRIM(codigo)) AS codigo FROM ${catalog.table} WHERE ${catalog.id} = $1 LIMIT 1`,
    [safeId]
  );
  return String(result.rows?.[0]?.codigo || '').trim().toUpperCase() || null;
};

const getResolutionByCode = async (client, code) => {
  const normalizedCode = normalizeCajaCode(code, 80);
  if (!normalizedCode) return null;

  const result = await client.query(
    `
      SELECT id_resolucion_cierre_caja, UPPER(TRIM(codigo)) AS codigo, nombre
      FROM public.cat_cajas_resoluciones_cierre
      WHERE UPPER(TRIM(codigo)) = $1
        AND COALESCE(estado, true) = true
      LIMIT 1
    `,
    [normalizedCode]
  );

  return result.rows[0] || null;
};

const ALLOWED_NEW_ARQUEO_CODES = new Set(['CIERRE', 'EXTRAORDINARIO']);
const SEGMENTED_ARQUEO_METHOD_CODES = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA'];
const EGRESO_MOVEMENT_TYPE_CODES = ['EGRESO_MANUAL', 'EGRESO', 'RETIRO', 'SALIDA_CAJA'];
const INGRESO_MOVEMENT_TYPE_CODES = ['INGRESO_MANUAL', 'INGRESO', 'ENTRADA_CAJA', 'ENTRADA', 'AJUSTE_POSITIVO'];
const CLOSE_DIFFERENCE_THRESHOLD = Number.isFinite(Number(process.env.CAJAS_CIERRE_DIFERENCIA_UMBRAL))
  ? Number(process.env.CAJAS_CIERRE_DIFERENCIA_UMBRAL)
  : 0;

const roundMoney = (value) => Number((Number(value || 0)).toFixed(2));

const normalizeMethodCode = (value) => String(value || '').trim().toUpperCase();

const resolveArqueoResultado = (diferencia) => {
  const normalized = roundMoney(diferencia);
  if (normalized === 0) return 'CUADRADO';
  return normalized < 0 ? 'FALTANTE' : 'SOBRANTE';
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatMoneyLabel = (value) => `L ${roundMoney(value).toFixed(2)}`;

const parseUtcTimestampForDisplay = (value) => {
  if (!value || value instanceof Date) return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(text)) {
    return `${text.replace(' ', 'T')}Z`;
  }
  return value;
};

const formatDateTimeLabel = (value) => {
  if (!value) return 'No disponible';
  const date = new Date(parseUtcTimestampForDisplay(value));
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-HN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Tegucigalpa'
  }).format(date);
};

const fetchSegmentedMethodCatalog = async (client) => {
  const result = await client.query(
    `
      SELECT id_metodo_pago, UPPER(TRIM(codigo)) AS codigo, nombre, COALESCE(afecta_efectivo, false) AS afecta_efectivo
      FROM public.cat_metodos_pago
      WHERE COALESCE(estado, true) = true
        AND UPPER(TRIM(codigo)) = ANY($1::text[])
      ORDER BY id_metodo_pago ASC
    `,
    [SEGMENTED_ARQUEO_METHOD_CODES]
  );
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const byCode = new Map(rows.map((row) => [String(row.codigo || '').trim().toUpperCase(), row]));
  for (const requiredCode of SEGMENTED_ARQUEO_METHOD_CODES) {
    if (!byCode.has(requiredCode)) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_METODO_CATALOGO_INCOMPLETO',
        `No se encontro el metodo de pago requerido: ${requiredCode}.`
      );
    }
  }
  return rows;
};

const fetchSessionMethodFinancialSummary = async (client, idSesionCaja) => {
  const sessionResult = await client.query(
    `
      SELECT monto_apertura
      FROM public.cajas_sesiones
      WHERE id_sesion_caja = $1
      LIMIT 1
    `,
    [idSesionCaja]
  );

  const salesResult = await client.query(
    `
      SELECT UPPER(TRIM(mp.codigo)) AS metodo_pago_codigo, COALESCE(SUM(fc.monto), 0)::numeric(12,2) AS monto
      FROM public.facturas_cobros fc
      INNER JOIN public.cat_metodos_pago mp ON mp.id_metodo_pago = fc.id_metodo_pago
      WHERE fc.id_sesion_caja = $1
      GROUP BY UPPER(TRIM(mp.codigo))
    `,
    [idSesionCaja]
  );

  const reversionsResult = await client.query(
    `
      SELECT
        fr.id_reversion,
        COALESCE(fr.monto_reversado, 0)::numeric(12,2) AS monto_reversado,
        fc.id_factura_cobro,
        COALESCE(fc.monto, 0)::numeric(12,2) AS monto_cobro,
        UPPER(TRIM(mp.codigo)) AS metodo_pago_codigo
      FROM public.facturas_reversiones fr
      INNER JOIN public.facturas_cobros fc
        ON fc.id_factura = fr.id_factura_original
      INNER JOIN public.cat_metodos_pago mp
        ON mp.id_metodo_pago = fc.id_metodo_pago
      WHERE COALESCE(fr.id_sesion_caja_original, fc.id_sesion_caja) = $1
        AND UPPER(TRIM(COALESCE(fr.estado, ''))) = 'APLICADA'
      ORDER BY fr.id_reversion ASC, fc.id_factura_cobro ASC
    `,
    [idSesionCaja]
  );

  const reversionTotalsResult = await client.query(
    `
      SELECT
        fr.id_reversion,
        COALESCE(SUM(fc.monto), 0)::numeric(12,2) AS total_cobrado
      FROM public.facturas_reversiones fr
      INNER JOIN public.facturas_cobros fc
        ON fc.id_factura = fr.id_factura_original
      WHERE COALESCE(fr.id_sesion_caja_original, fc.id_sesion_caja) = $1
        AND UPPER(TRIM(COALESCE(fr.estado, ''))) = 'APLICADA'
      GROUP BY fr.id_reversion
    `,
    [idSesionCaja]
  );

  const reversionTotalsById = new Map();
  for (const row of reversionTotalsResult.rows || []) {
    reversionTotalsById.set(Number(row.id_reversion), roundMoney(row.total_cobrado));
  }

  const reversionRowsById = new Map();
  for (const row of reversionsResult.rows || []) {
    const idReversion = Number(row.id_reversion || 0);
    if (!idReversion) continue;
    const rows = reversionRowsById.get(idReversion) || [];
    rows.push(row);
    reversionRowsById.set(idReversion, rows);
  }

  const allocatedReversionsByCode = new Map();
  for (const [idReversion, rows] of reversionRowsById.entries()) {
    const totalCobrado = Number(reversionTotalsById.get(idReversion) || 0);
    const montoReversado = roundMoney(rows[0]?.monto_reversado || 0);
    if (montoReversado <= 0 || totalCobrado <= 0) continue;

    let allocated = 0;
    rows.forEach((row, index) => {
      const code = normalizeMethodCode(row.metodo_pago_codigo);
      if (!code) return;
      const isLast = index === rows.length - 1;
      const monto = isLast
        ? roundMoney(montoReversado - allocated)
        : roundMoney((Number(row.monto_cobro || 0) / totalCobrado) * montoReversado);
      allocated = roundMoney(allocated + monto);
      allocatedReversionsByCode.set(code, roundMoney(Number(allocatedReversionsByCode.get(code) || 0) + monto));
    });
  }

  const movementsResult = await client.query(
    `
      SELECT
        COALESCE(SUM(
          CASE
            WHEN mt.signo = 1
              AND UPPER(TRIM(mt.codigo)) <> 'APERTURA'
              AND UPPER(TRIM(mt.codigo)) NOT LIKE '%REVERSION%'
            THEN cm.monto
            ELSE 0
          END
        ), 0)::numeric(12,2) AS ingresos_manuales,
        COALESCE(SUM(
          CASE
            WHEN mt.signo = -1
              AND UPPER(TRIM(mt.codigo)) NOT LIKE '%REVERSION%'
            THEN cm.monto
            ELSE 0
          END
        ), 0)::numeric(12,2) AS egresos_manuales
      FROM public.cajas_movimientos cm
      INNER JOIN public.cat_cajas_movimientos_tipos mt ON mt.id_tipo_movimiento_caja = cm.id_tipo_movimiento_caja
      WHERE cm.id_sesion_caja = $1
    `,
    [idSesionCaja]
  );

  const salesByCode = new Map();
  for (const row of salesResult.rows || []) {
    salesByCode.set(normalizeMethodCode(row.metodo_pago_codigo), roundMoney(row.monto));
  }

  const reversionsByCode = new Map();
  for (const [code, amount] of allocatedReversionsByCode.entries()) {
    reversionsByCode.set(code, roundMoney(amount));
  }

  const ingresosManuales = roundMoney(movementsResult.rows?.[0]?.ingresos_manuales || 0);
  const egresosManuales = roundMoney(movementsResult.rows?.[0]?.egresos_manuales || 0);
  const montoApertura = roundMoney(sessionResult.rows?.[0]?.monto_apertura || 0);

  const salesNetByCode = new Map();
  const methodCodes = new Set([
    ...SEGMENTED_ARQUEO_METHOD_CODES,
    ...salesByCode.keys(),
    ...reversionsByCode.keys()
  ]);
  for (const code of methodCodes) {
    salesNetByCode.set(
      code,
      roundMoney(Number(salesByCode.get(code) || 0) - Number(reversionsByCode.get(code) || 0))
    );
  }

  const ventasEfectivoNetas = roundMoney(salesNetByCode.get('EFECTIVO') || 0);
  const ventasTarjetaNetas = roundMoney(salesNetByCode.get('TARJETA') || 0);
  const ventasTransferenciaNetas = roundMoney(salesNetByCode.get('TRANSFERENCIA') || 0);
  const ventasNoEfectivoNetas = roundMoney(
    [...salesNetByCode.entries()]
      .filter(([code]) => code !== 'EFECTIVO')
      .reduce((sum, [, amount]) => sum + Number(amount || 0), 0)
  );
  const efectivoTeorico = roundMoney(montoApertura + ventasEfectivoNetas + ingresosManuales - egresosManuales);
  const tarjetaTeorico = ventasTarjetaNetas;
  const transferenciaTeorico = ventasTransferenciaNetas;
  const totalTeorico = roundMoney(efectivoTeorico + tarjetaTeorico + transferenciaTeorico);

  return {
    salesByCode,
    reversionsByCode,
    salesNetByCode,
    montoApertura,
    ventasEfectivoNetas,
    ventasTarjetaNetas,
    ventasTransferenciaNetas,
    ventasNoEfectivoNetas,
    ingresosManuales,
    egresosManuales,
    efectivoTeorico,
    tarjetaTeorico,
    transferenciaTeorico,
    totalTeorico
  };
};

const buildSegmentedArqueoComputation = async ({
  client,
  idSesionCaja,
  payloadRows,
  threshold,
  requireObservacionOnDifference = true
}) => {
  const methodCatalog = await fetchSegmentedMethodCatalog(client);
  const methodCodes = new Set(methodCatalog.map((row) => normalizeMethodCode(row.codigo)));
  const declaredByCode = new Map();
  for (const row of payloadRows) {
    const code = normalizeMethodCode(row?.metodo_pago_codigo);
    if (!code || !methodCodes.has(code)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_METODO_INVALID', 'El metodo_pago_codigo del arqueo es invalido.');
    }
    if (declaredByCode.has(code)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_METODO_DUPLICATE', `No se permite repetir arqueos para ${code}.`);
    }
    const montoDeclarado = parseNullableNonNegativeAmount(row?.monto_declarado);
    if (montoDeclarado === null) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_AMOUNT_INVALID', `monto_declarado es obligatorio para ${code}.`);
    }
    const cantidadReferencias = row?.cantidad_referencias === null || row?.cantidad_referencias === undefined || row?.cantidad_referencias === ''
      ? null
      : Number.parseInt(String(row.cantidad_referencias), 10);
    if (cantidadReferencias !== null && (!Number.isInteger(cantidadReferencias) || cantidadReferencias < 0)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_REFERENCIAS_INVALID', `cantidad_referencias invalida para ${code}.`);
    }
    declaredByCode.set(code, {
      monto_declarado: Number(montoDeclarado),
      cantidad_referencias: cantidadReferencias,
      observacion: normalizeText(row?.observacion, 500)
    });
  }

  const financialSummary = await fetchSessionMethodFinancialSummary(client, idSesionCaja);
  const normalizedThreshold = Number.isFinite(Number(threshold)) && Number(threshold) >= 0
    ? Number(threshold)
    : 0;

  let totalTeorico = 0;
  let totalDeclarado = 0;
  const rows = [];
  for (const method of methodCatalog) {
    const code = normalizeMethodCode(method.codigo);
    const salesGross = Number(financialSummary.salesByCode.get(code) || 0);
    const reversions = Number(financialSummary.reversionsByCode.get(code) || 0);
    let montoTeoricoMetodo = roundMoney(financialSummary.salesNetByCode.get(code) || 0);
    if (code === 'EFECTIVO') {
      montoTeoricoMetodo = financialSummary.efectivoTeorico;
    } else if (code === 'TARJETA') {
      montoTeoricoMetodo = financialSummary.tarjetaTeorico;
    } else if (code === 'TRANSFERENCIA') {
      montoTeoricoMetodo = financialSummary.transferenciaTeorico;
    }

    const declaredEntry = declaredByCode.get(code);
    const autoComplete = !declaredEntry && montoTeoricoMetodo === 0;
    if (!declaredEntry && !autoComplete) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_METODO_REQUIRED', `Debe declarar arqueo para ${code}.`);
    }

    const montoDeclaradoMetodo = autoComplete
      ? 0
      : Number(declaredEntry.monto_declarado);
    const diferenciaMetodo = roundMoney(montoDeclaradoMetodo - montoTeoricoMetodo);
    const requiereRevision = Math.abs(diferenciaMetodo) > normalizedThreshold;
    const observacionMetodo = autoComplete ? null : declaredEntry.observacion;
    const cantidadReferenciasMetodo = autoComplete ? null : declaredEntry.cantidad_referencias;

    if ((code === 'TARJETA' || code === 'TRANSFERENCIA') && salesGross > 0 && cantidadReferenciasMetodo === null) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_ARQUEO_REFERENCIAS_REQUIRED',
        `Debe indicar cantidad_referencias para ${code} cuando existen ventas del metodo.`
      );
    }
    if (requireObservacionOnDifference && requiereRevision && !observacionMetodo) {
      throw createArqueoObservationRequiredError(code);
    }

    totalTeorico = roundMoney(totalTeorico + montoTeoricoMetodo);
    totalDeclarado = roundMoney(totalDeclarado + montoDeclaradoMetodo);
    rows.push({
      id_metodo_pago: Number(method.id_metodo_pago),
      metodo_pago_codigo: code,
      monto_teorico: montoTeoricoMetodo,
      monto_declarado: montoDeclaradoMetodo,
      diferencia: diferenciaMetodo,
      cantidad_referencias: cantidadReferenciasMetodo,
      observacion: observacionMetodo,
      requiere_revision: requiereRevision,
      observacion_requerida: requiereRevision,
      observacion_presente: Boolean(observacionMetodo),
      resultado: resolveArqueoResultado(diferenciaMetodo),
      completado_automaticamente: autoComplete
    });
  }

  return {
    rows,
    monto_teorico_total: totalTeorico,
    monto_declarado_total: totalDeclarado,
    diferencia_total: roundMoney(totalDeclarado - totalTeorico)
  };
};

const getScopeContext = async (req, client, requestedSucursalId = null, allowGlobal = false) => {
  const scope = await resolveRequestUserSucursalScope(req, client);
  const idUsuario = parsePositiveInt(scope.idUsuario);
  if (!idUsuario) {
    throw createCajaError(401, 'VENTAS_CAJAS_UNAUTHORIZED', 'No autorizado.');
  }

  const userSucursalId = parsePositiveInt(scope.userSucursalId);
  const allowedSucursalIds = Array.isArray(scope.allowedSucursalIds)
    ? scope.allowedSucursalIds.map((value) => parsePositiveInt(value)).filter((value) => value !== null)
    : [];
  const hasMultisucursalAccess =
    Boolean(scope.isSuperAdmin) || (await requestHasAnyPermission(req, CAJAS_SCOPE_PERMISSION));

  let targetSucursalId = null;
  if (requestedSucursalId) {
    if (!scope.isSuperAdmin && !allowedSucursalIds.includes(requestedSucursalId)) {
      throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_FORBIDDEN', 'No tiene acceso a la sucursal solicitada.');
    }
    if (!scope.isSuperAdmin && requestedSucursalId !== userSucursalId && !hasMultisucursalAccess) {
      throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_FORBIDDEN', 'No tiene acceso a la sucursal solicitada.');
    }
    targetSucursalId = requestedSucursalId;
  } else if (allowGlobal && scope.isSuperAdmin && hasMultisucursalAccess) {
    targetSucursalId = null;
  } else if (userSucursalId) {
    targetSucursalId = userSucursalId;
  } else if (!scope.isSuperAdmin && allowedSucursalIds.length === 1) {
    targetSucursalId = allowedSucursalIds[0];
  } else if (!scope.isSuperAdmin) {
    throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'No se pudo resolver la sucursal operativa del usuario.');
  }

  return {
    idUsuario,
    isSuperAdmin: Boolean(scope.isSuperAdmin),
    userSucursalId,
    allowedSucursalIds,
    hasMultisucursalAccess,
    targetSucursalId
  };
};

const assertSucursalAllowed = (scopeContext, idSucursal) => {
  const target = parsePositiveInt(idSucursal);
  if (!target) {
    throw createCajaError(409, 'VENTAS_CAJAS_SCOPE_INVALID', 'No se pudo determinar la sucursal operativa.');
  }
  if (scopeContext.isSuperAdmin) return;
  if (!scopeContext.allowedSucursalIds.includes(target)) {
    throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_FORBIDDEN', 'No tiene acceso a la sucursal solicitada.');
  }
};

const ensureAdminOrSuperAdmin = async (req) => {
  const isAllowed = await requestHasAnyRole(req, ADMIN_ROLE_CODES);
  if (!isAllowed) {
    throw createCajaError(403, 'VENTAS_CAJAS_ROLE_FORBIDDEN', 'Accion exclusiva para ADMIN o SUPER_ADMIN.');
  }
};

const ensureActiveAssignmentBusinessRules = async (
  client,
  {
    idCaja,
    idUsuario,
    idSucursal,
    puedeResponsable,
    estado = true,
    excludeAssignmentId = null
  }
) => {
  if (!parseBooleanish(estado)) return;

  const userConflictResult = await client.query(
    `
      SELECT
        cua.id_caja_usuario_autorizado,
        cua.id_caja,
        c.codigo_caja,
        c.nombre_caja,
        s.id_sucursal,
        s.nombre_sucursal
      FROM public.cajas_usuarios_autorizados cua
      INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
      INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
      WHERE cua.id_usuario = $1
        AND cua.id_caja <> $2
        AND COALESCE(cua.estado, true) = true
        AND COALESCE(c.estado, true) = true
        AND ($3::int IS NULL OR cua.id_caja_usuario_autorizado <> $3)
      LIMIT 1
      FOR UPDATE
    `,
    [idUsuario, idCaja, excludeAssignmentId]
  );
  if (userConflictResult.rowCount > 0) {
    const conflict = userConflictResult.rows[0] || {};
    const codigoCaja = normalizeText(conflict.codigo_caja, 80);
    const nombreCaja = normalizeText(conflict.nombre_caja, 120);
    const nombreSucursal = normalizeText(conflict.nombre_sucursal, 120);
    const cajaLabel = [nombreCaja, codigoCaja ? `(${codigoCaja})` : null].filter(Boolean).join(' ');
    const ubicacionLabel = nombreSucursal ? ` en ${nombreSucursal}` : '';
    throw createCajaError(
      409,
      'VENTAS_CAJAS_ASSIGN_USER_ACTIVE_DUPLICATE',
      `El usuario ya tiene otra caja activa asignada${cajaLabel ? `: ${cajaLabel}` : ''}${ubicacionLabel}.`
    );
  }

  if (!parseBooleanish(puedeResponsable)) return;

  const responsibleConflictResult = await client.query(
    `
      SELECT cua.id_caja_usuario_autorizado
      FROM public.cajas_usuarios_autorizados cua
      INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
      WHERE cua.id_caja = $1
        AND COALESCE(cua.estado, true) = true
        AND COALESCE(cua.puede_responsable, false) = true
        AND COALESCE(c.estado, true) = true
        AND e.id_sucursal = $2
        AND ($3::int IS NULL OR cua.id_caja_usuario_autorizado <> $3)
      LIMIT 1
      FOR UPDATE
    `,
    [idCaja, idSucursal, excludeAssignmentId]
  );
  if (responsibleConflictResult.rowCount > 0) {
    throw createCajaError(
      409,
      'VENTAS_CAJAS_ASSIGN_RESPONSABLE_DUPLICATE',
      'La caja ya tiene un responsable activo asignado.'
    );
  }
};

const fetchAssignableCajaUserById = async (client, idUsuario) => {
  const result = await client.query(
    `
      SELECT u.id_usuario, u.nombre_usuario, e.id_empleado, e.id_sucursal,
             COALESCE(
               NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
               u.nombre_usuario
             ) AS nombre_completo,
             ARRAY_AGG(DISTINCT ${ROLE_NORMALIZED_SQL}) AS roles_normalizados
      FROM public.usuarios u
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
      INNER JOIN public.roles r ON r.id_rol = ru.id_rol
      LEFT JOIN public.personas per ON per.id_persona = e.id_persona
      WHERE u.id_usuario = $1
        AND COALESCE(u.estado, true) = true
        AND COALESCE(e.estado, true) = true
      GROUP BY u.id_usuario, u.nombre_usuario, e.id_empleado, e.id_sucursal, per.nombre, per.apellido
      LIMIT 1
     `,
    [idUsuario]
  );
  const user = result.rows[0] || null;
  if (!user) return null;
  const roleCodes = Array.isArray(user.roles_normalizados)
    ? user.roles_normalizados.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
    : [];
  return {
    ...user,
    roles_normalizados: roleCodes
  };
};

const normalizeRoleCodes = (roleCodes) =>
  (Array.isArray(roleCodes) ? roleCodes : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);

const hasAnyRoleCode = (roleCodes, candidates) => {
  const normalizedRoles = new Set(normalizeRoleCodes(roleCodes));
  return (Array.isArray(candidates) ? candidates : []).some((candidate) =>
    normalizedRoles.has(String(candidate || '').trim().toUpperCase())
  );
};

const isCajaUserCajero = (roleCodes) => hasAnyRoleCode(roleCodes, ['CAJERO']);

const isCajaUserAdminLike = (roleCodes) =>
  hasAnyRoleCode(roleCodes, ['SUPER_ADMIN', 'ADMIN', 'ADMINISTRADOR']);

const requestIsRestrictedCajero = async (req) => {
  const isCajero = await requestHasAnyRole(req, ['CAJERO']);
  if (!isCajero) return false;
  return !(await requestHasAnyRole(req, ADMIN_ROLE_CODES));
};

const isCashierOnlyRequest = async (req) => requestIsRestrictedCajero(req);

const isOperationalCajaDetailContext = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return ['ARQUEO', 'CIERRE', 'OPERACION'].includes(normalized);
};

const maskCajaFinancialMethod = (row = {}) => ({
  ...row,
  visible_para_cajero: false,
  comparacion_visible: false,
  monto_teorico: null,
  diferencia: null
});

const maskCajaFinancialSummary = (row = {}) => ({
  ...row,
  visible_para_cajero: false,
  comparacion_visible: false,
  ventas_efectivo: null,
  ventas_no_efectivo: null,
  monto_ventas_efectivo: null,
  monto_ventas_no_efectivo: null,
  ingresos_manuales: null,
  egresos_manuales: null,
  monto_ingresos_manuales: null,
  monto_egresos_manuales: null,
  total_responsable: null,
  total_auxiliares: null,
  total_otros_ejecutores: null,
  efectivo_teorico: null,
  total_teorico: null,
  monto_teorico: null,
  monto_teorico_cierre: null,
  diferencia: null,
  diferencia_cierre: null,
  ultimo_arqueo_cierre: row?.ultimo_arqueo_cierre
    ? maskCajaFinancialMethod(row.ultimo_arqueo_cierre)
    : row?.ultimo_arqueo_cierre
});

const maskCajaCobroUsuarioForCajero = (row = {}) => ({
  ...row,
  visible_para_cajero: false,
  comparacion_visible: false,
  total_efectivo: null,
  total_no_efectivo: null,
  ventas_efectivo: null,
  ventas_no_efectivo: null
});

const maskCajaSessionRowForCajero = (row = {}) => maskCajaFinancialSummary(row);

const maskCajaClosePreviewForCajero = (computation) => ({
  message: 'Vista previa de cierre calculada correctamente.',
  comparacion_visible: false,
  resumen: {
    total_declarado: computation?.monto_declarado_total ?? null
  },
  observaciones_requeridas: []
});

const maskCajaCloseResponseForCajero = (payload = {}) => ({
  ...payload,
  visible_para_cajero: false,
  comparacion_visible: false,
  diferencia: null,
  arqueos_metodos: (Array.isArray(payload.arqueos_metodos) ? payload.arqueos_metodos : []).map(maskCajaFinancialMethod)
});

const maskCajaCloseValidationForCajero = (row = {}) => ({
  ...row,
  total_teorico: null,
  diferencia_total: null,
  metodos: (Array.isArray(row.metodos) ? row.metodos : []).map(maskCajaFinancialMethod)
});

const maskCajaDetailPayloadForCajero = (payload = {}) => ({
  ...payload,
  resumen_operativo: maskCajaFinancialSummary(payload.resumen_operativo || {}),
  cobros_por_usuario: (Array.isArray(payload.cobros_por_usuario) ? payload.cobros_por_usuario : []).map(maskCajaCobroUsuarioForCajero),
  arqueos: (Array.isArray(payload.arqueos) ? payload.arqueos : []).map(maskCajaFinancialMethod),
  arqueos_metodos: (Array.isArray(payload.arqueos_metodos) ? payload.arqueos_metodos : []).map(maskCajaFinancialMethod),
  recuentos: (Array.isArray(payload.recuentos) ? payload.recuentos : []).map(maskCajaCloseValidationForCajero),
  validaciones_cierre: (Array.isArray(payload.validaciones_cierre) ? payload.validaciones_cierre : []).map(maskCajaCloseValidationForCajero),
  cierre: payload.cierre ? maskCajaFinancialSummary(payload.cierre) : payload.cierre
});

const requestIsSuperAdminReal = async (client, req) => {
  const idUsuario = parsePositiveInt(req?.user?.id_usuario);
  if (!idUsuario) return false;
  const result = await client.query(
    `
      SELECT 1
      FROM public.roles_usuarios ru
      INNER JOIN public.roles r ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = $1
        AND ${ROLE_NORMALIZED_SQL} = 'SUPER_ADMIN'
      LIMIT 1
    `,
    [idUsuario]
  );
  return result.rowCount > 0;
};

const requestHasPermissionReal = async (client, req, permissionCode) => {
  const idUsuario = parsePositiveInt(req?.user?.id_usuario);
  const normalizedPermission = normalizeCajaCode(permissionCode, 120);
  if (!idUsuario || !normalizedPermission) return false;
  const result = await client.query(
    `
      SELECT 1
      FROM public.roles_usuarios ru
      INNER JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
      INNER JOIN public.permisos p ON p.id_permiso = rp.id_permiso
      WHERE ru.id_usuario = $1
        AND UPPER(TRIM(p.nombre_permiso)) = $2
      LIMIT 1
    `,
    [idUsuario, normalizedPermission]
  );
  return result.rowCount > 0;
};

const assertCanOpenCajaSession = async ({
  client,
  req,
  scopeContext,
  caja,
  modoApertura
}) => {
  assertSucursalAllowed(scopeContext, caja.id_sucursal);
  if (modoApertura !== 'CONTINGENCIA_SUPER_ADMIN') return;

  const isSuperAdminReal = await requestIsSuperAdminReal(client, req);
  const hasOpenPermission = await requestHasPermissionReal(client, req, 'VENTAS_CAJAS_SESION_ABRIR');
  if (!isSuperAdminReal || !hasOpenPermission) {
    throw createCajaError(
      403,
      'VENTAS_CAJAS_CONTINGENCY_OPEN_FORBIDDEN',
      'Solo un SUPER_ADMIN con permiso de apertura puede abrir una caja por contingencia.'
    );
  }
};

const assertCanCloseCajaSession = async ({
  client,
  req,
  scopeContext,
  session,
  observacionCierre = null
}) => {
  if (Number(session.id_usuario_responsable) === Number(scopeContext.idUsuario)) {
    return { administrativeClose: false };
  }

  const isSuperAdminReal = await requestIsSuperAdminReal(client, req);
  const hasClosePermission = await requestHasPermissionReal(client, req, 'VENTAS_CAJAS_SESION_CERRAR');
  if (!isSuperAdminReal || !hasClosePermission) {
    throw createCajaError(
      403,
      'VENTAS_CAJAS_CLOSE_RESPONSABLE_OR_SUPER_ADMIN_ONLY',
      'Solo el responsable o un SUPER_ADMIN con permiso puede cerrar esta sesion.'
    );
  }

  if (!normalizeText(observacionCierre, 500)) {
    throw createCajaError(
      400,
      'VENTAS_CAJAS_ADMIN_CLOSE_OBSERVATION_REQUIRED',
      'Debe indicar una observacion para cerrar una sesion ajena por contingencia.'
    );
  }

  return { administrativeClose: true };
};

const findDetallePlanillaByUsuarioAndMonth = async ({
  client,
  idUsuario,
  idSucursal,
  fechaReferencia
}) => {
  const result = await client.query(
    `
      SELECT dp.id_detalle_planilla,
             dp.id_planilla,
             COALESCE(ep.descripcion, '') AS estado_planilla
      FROM public.usuarios u
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      INNER JOIN public.detalle_planilla dp ON dp.id_empleado = e.id_empleado
      INNER JOIN public.planillas p ON p.id_planilla = dp.id_planilla
      LEFT JOIN public.estado_planilla ep ON ep.id_estado_planilla = p.id_estado_planilla
      WHERE u.id_usuario = $1
        AND p.id_sucursal = $2
        AND date_trunc('month', p.fecha_creacion) = date_trunc('month', $3::timestamp)
      ORDER BY
        CASE
          WHEN UPPER(TRIM(COALESCE(ep.descripcion, ''))) IN ('BORRADOR', 'CALCULADA') THEN 0
          ELSE 1
        END,
        p.fecha_creacion DESC,
        p.id_planilla DESC,
        dp.id_detalle_planilla DESC
      LIMIT 1
    `,
    [idUsuario, idSucursal, fechaReferencia]
  );
  return result.rows[0] || null;
};

const isEditablePayrollState = (value) =>
  ['BORRADOR', 'CALCULADA'].includes(normalizeCajaCode(value, 40));

const syncPayrollDeductionForClose = async ({
  client,
  idCierreCaja,
  idUsuarioResponsable,
  idUsuarioDeduccion = null,
  idSucursal,
  fechaCierre,
  diferencia,
  resolucionCodigo
}) => {
  const normalizedResolution = String(resolucionCodigo || '').trim().toUpperCase();
  const absDiferencia = Number(Math.abs(Number(diferencia || 0)).toFixed(2));

  const mappingResult = await client.query(
    `
      SELECT id_cierre_planilla_movimiento, id_movimiento_planilla, activo
      FROM public.cajas_cierres_planilla_movimientos
      WHERE id_cierre_caja = $1
      LIMIT 1
      FOR UPDATE
    `,
    [idCierreCaja]
  );
  const existing = mappingResult.rows[0] || null;

  const shouldApplyDeduction =
    normalizedResolution === 'DESCUENTO_EMPLEADO' && absDiferencia > 0;

  if (!shouldApplyDeduction) {
    if (existing?.id_movimiento_planilla) {
      await client.query(
        `
          UPDATE public.movimiento_planilla
          SET estado = false
          WHERE id_movimiento_planilla = $1
        `,
        [existing.id_movimiento_planilla]
      );
      await client.query(
        `
          UPDATE public.cajas_cierres_planilla_movimientos
          SET activo = false, fecha_actualizacion = NOW()
          WHERE id_cierre_planilla_movimiento = $1
        `,
        [existing.id_cierre_planilla_movimiento]
      );
    }
    return { synced: true, reason: 'NOT_REQUIRED' };
  }

  const targetPayrollUserId = parsePositiveInt(idUsuarioDeduccion) || parsePositiveInt(idUsuarioResponsable);
  if (!targetPayrollUserId) {
    return { synced: false, reason: 'RESPONSABLE_CAJA_NO_DETERMINADO' };
  }

  const detallePlanilla = await findDetallePlanillaByUsuarioAndMonth({
    client,
    idUsuario: targetPayrollUserId,
    idSucursal,
    fechaReferencia: fechaCierre
  });

  if (!detallePlanilla?.id_detalle_planilla) {
    return { synced: false, reason: 'PLANILLA_DETAIL_NOT_FOUND' };
  }

  if (!isEditablePayrollState(detallePlanilla.estado_planilla)) {
    return {
      synced: false,
      reason: 'PLANILLA_NOT_EDITABLE',
      estado_planilla: detallePlanilla.estado_planilla || null
    };
  }

  const concepto = `Descuento cierre caja #${idCierreCaja}`;
  const observacion = `Deduccion automatica por diferencia de cierre de caja.`;
  let idMovimientoPlanilla = parsePositiveInt(existing?.id_movimiento_planilla);

  try {
    if (idMovimientoPlanilla) {
      await client.query(
        `
          UPDATE public.movimiento_planilla
          SET tipo_movimiento = 'DEDUCCION',
              concepto = $1,
              monto = $2,
              observacion = $3,
              estado = true,
              fecha_registro = NOW()
          WHERE id_movimiento_planilla = $4
        `,
        [concepto, absDiferencia, observacion, idMovimientoPlanilla]
      );
    } else {
      const insertMovimiento = await client.query(
        `
          INSERT INTO public.movimiento_planilla (
            id_detalle_planilla, tipo_movimiento, concepto, monto, observacion, fecha_registro, estado
          )
          VALUES ($1, 'DEDUCCION', $2, $3, $4, NOW(), true)
          RETURNING id_movimiento_planilla
        `,
        [detallePlanilla.id_detalle_planilla, concepto, absDiferencia, observacion]
      );
      idMovimientoPlanilla = parsePositiveInt(insertMovimiento.rows?.[0]?.id_movimiento_planilla);
    }

    if (!idMovimientoPlanilla) {
      return { synced: false, reason: 'PAYROLL_DEDUCTION_NOT_CREATED' };
    }

    await client.query(
      `SELECT public.fn_recalcular_detalle_planilla($1)`,
      [detallePlanilla.id_detalle_planilla]
    );
  } catch (err) {
    throw createCajaError(
      409,
      'PAYROLL_DEDUCTION_NOT_CREATED',
      'No se pudo registrar la deduccion en planilla. El cierre no fue resuelto.',
      {
        db_code: err?.code || null,
        db_message: err?.message || null,
        monto_deduccion: absDiferencia
      }
    );
  }

  if (existing?.id_cierre_planilla_movimiento) {
    await client.query(
      `
        UPDATE public.cajas_cierres_planilla_movimientos
        SET id_movimiento_planilla = $1,
            id_planilla = $2,
            activo = true,
            fecha_actualizacion = NOW()
        WHERE id_cierre_planilla_movimiento = $3
      `,
      [idMovimientoPlanilla, detallePlanilla.id_planilla, existing.id_cierre_planilla_movimiento]
    );
  } else {
    await client.query(
      `
        INSERT INTO public.cajas_cierres_planilla_movimientos (
          id_cierre_caja, id_movimiento_planilla, id_planilla, activo, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1, $2, $3, true, NOW(), NOW())
      `,
      [idCierreCaja, idMovimientoPlanilla, detallePlanilla.id_planilla]
    );
  }

  return { synced: true, reason: 'UPDATED', id_movimiento_planilla: idMovimientoPlanilla };
};

const userBelongsToSucursal = async (client, idUsuario, idSucursal) => {
  const targetSucursal = parsePositiveInt(idSucursal);
  if (!targetSucursal) return false;

  const allowedIds = new Set();
  const appendRows = (rows) => {
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const parsed = parsePositiveInt(row?.id_sucursal);
      if (parsed) allowedIds.add(parsed);
    });
  };

  const baseResult = await client.query(
    `
      SELECT e.id_sucursal
      FROM public.usuarios u
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      WHERE u.id_usuario = $1
        AND e.id_sucursal IS NOT NULL
    `,
    [idUsuario]
  );
  appendRows(baseResult.rows);

  const optionalQueries = [
    {
      relation: 'public.v_usuarios_sucursales_scope',
      sql: `
        SELECT vus.id_sucursal
        FROM public.v_usuarios_sucursales_scope vus
        WHERE vus.id_usuario = $1
      `
    },
    {
      relation: 'public.empleados_sucursales',
      sql: `
        SELECT es.id_sucursal
        FROM public.usuarios u
        INNER JOIN public.empleados_sucursales es ON es.id_empleado = u.id_empleado
        WHERE u.id_usuario = $1
      `
    },
    {
      relation: 'public.usuarios_sucursales',
      sql: `
        SELECT us.id_sucursal
        FROM public.usuarios_sucursales us
        WHERE us.id_usuario = $1
      `
    }
  ];

  for (const queryDef of optionalQueries) {
    const relationResult = await client.query('SELECT to_regclass($1) AS relation_name', [queryDef.relation]);
    if (!relationResult.rows?.[0]?.relation_name) {
      continue;
    }

    const result = await client.query(queryDef.sql, [idUsuario]);
    appendRows(result.rows);
  }

  return allowedIds.has(targetSucursal);
};

const assertUserBelongsToSucursal = async (client, idUsuario, idSucursal) => {
  const belongs = await userBelongsToSucursal(client, idUsuario, idSucursal);
  if (!belongs) {
    throw createCajaError(
      409,
      'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
      'El usuario seleccionado no pertenece a la sucursal operativa de la caja.'
    );
  }
};

const upsertCajaAuthorization = async (
  client,
  {
    idCaja,
    idSucursal,
    idUsuario,
    puedeResponsable = true,
    puedeAuxiliar = true,
    observacion = null
  }
) => {
  const normalizedObservacion = normalizeText(observacion, 300);
  const activeResult = await client.query(
    `
      SELECT id_caja_usuario_autorizado
      FROM public.cajas_usuarios_autorizados
      WHERE id_caja = $1
        AND id_usuario = $2
        AND COALESCE(estado, true) = true
      LIMIT 1
      FOR UPDATE
    `,
    [idCaja, idUsuario]
  );

  const excludedAssignmentId = Number(activeResult.rows?.[0]?.id_caja_usuario_autorizado || 0) || null;
  await ensureActiveAssignmentBusinessRules(client, {
    idCaja,
    idUsuario,
    idSucursal,
    puedeResponsable,
    estado: true,
    excludeAssignmentId: excludedAssignmentId
  });

  if (activeResult.rowCount > 0) {
    const idAsignacion = Number(activeResult.rows[0].id_caja_usuario_autorizado);
    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET id_sucursal = $1,
            puede_responsable = $2,
            puede_auxiliar = $3,
            observacion = $4,
            fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $5
      `,
      [idSucursal, Boolean(puedeResponsable), Boolean(puedeAuxiliar), normalizedObservacion, idAsignacion]
    );
    return idAsignacion;
  }

  const inactiveResult = await client.query(
    `
      SELECT id_caja_usuario_autorizado
      FROM public.cajas_usuarios_autorizados
      WHERE id_caja = $1
        AND id_usuario = $2
        AND COALESCE(estado, true) = false
      ORDER BY id_caja_usuario_autorizado DESC
      LIMIT 1
      FOR UPDATE
    `,
    [idCaja, idUsuario]
  );

  if (inactiveResult.rowCount > 0) {
    const idAsignacion = Number(inactiveResult.rows[0].id_caja_usuario_autorizado);
    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET id_sucursal = $1,
            puede_responsable = $2,
            puede_auxiliar = $3,
            estado = true,
            observacion = $4,
            fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $5
      `,
      [idSucursal, Boolean(puedeResponsable), Boolean(puedeAuxiliar), normalizedObservacion, idAsignacion]
    );
    return idAsignacion;
  }

  const insertResult = await client.query(
    `
      INSERT INTO public.cajas_usuarios_autorizados (
        id_caja,
        id_sucursal,
        id_usuario,
        puede_responsable,
        puede_auxiliar,
        estado,
        observacion,
        fecha_creacion,
        fecha_actualizacion
      )
      VALUES ($1, $2, $3, $4, $5, true, $6, NOW(), NOW())
      RETURNING id_caja_usuario_autorizado
    `,
    [
      idCaja,
      idSucursal,
      idUsuario,
      Boolean(puedeResponsable),
      Boolean(puedeAuxiliar),
      normalizedObservacion
    ]
  );

  return Number(insertResult.rows?.[0]?.id_caja_usuario_autorizado || 0) || null;
};

const fetchCajaDefaultResponsible = async (client, idCaja, idSucursal) => {
  const result = await client.query(
    `
      SELECT cua.id_usuario
      FROM public.cajas_usuarios_autorizados cua
      INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      WHERE cua.id_caja = $1
        AND cua.id_sucursal = $2
        AND COALESCE(cua.estado, true) = true
        AND COALESCE(cua.puede_responsable, false) = true
        AND COALESCE(u.estado, true) = true
        AND COALESCE(e.estado, true) = true
      ORDER BY cua.fecha_actualizacion DESC, cua.id_caja_usuario_autorizado DESC
      LIMIT 1
    `,
    [idCaja, idSucursal]
  );
  return Number(result.rows?.[0]?.id_usuario || 0) || null;
};

const fetchCajaById = async (client, idCaja) => {
  const result = await client.query(
    `
      SELECT id_caja, id_sucursal, codigo_caja, nombre_caja, COALESCE(estado, true) AS estado
      FROM public.cajas
      WHERE id_caja = $1
      LIMIT 1
    `,
    [idCaja]
  );
  return result.rows[0] || null;
};

const fetchCajaAuthorization = async (client, idCaja, idUsuario) => {
  const result = await client.query(
    `
      SELECT id_caja_usuario_autorizado, id_sucursal,
             COALESCE(puede_responsable, false) AS puede_responsable,
             COALESCE(puede_auxiliar, false) AS puede_auxiliar
      FROM public.cajas_usuarios_autorizados
      WHERE id_caja = $1
        AND id_usuario = $2
        AND COALESCE(estado, true) = true
      LIMIT 1
    `,
    [idCaja, idUsuario]
  );
  return result.rows[0] || null;
};

const assertCajaAuthorization = async (client, idCaja, idUsuario, roleCode) => {
  const authorization = await fetchCajaAuthorization(client, idCaja, idUsuario);
  if (!authorization) {
    throw createCajaError(403, 'VENTAS_CAJAS_USER_NOT_AUTHORIZED', 'El usuario no esta autorizado para operar esta caja.');
  }
  if (roleCode === 'RESPONSABLE' && !parseBooleanish(authorization.puede_responsable)) {
    throw createCajaError(403, 'VENTAS_CAJAS_RESPONSABLE_FORBIDDEN', 'El usuario no tiene autorizacion como responsable para esta caja.');
  }
  if (roleCode === 'AUXILIAR' && !parseBooleanish(authorization.puede_auxiliar)) {
    throw createCajaError(403, 'VENTAS_CAJAS_AUXILIAR_FORBIDDEN', 'El usuario no tiene autorizacion como auxiliar para esta caja.');
  }
  return authorization;
};

const fetchMiCajaAsignadaActiva = async (client, scopeContext, { forUpdate = false } = {}) => {
  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  const params = [scopeContext.idUsuario, idEstadoAbierta];
  const filters = [
    'cua.id_usuario = $1',
    'COALESCE(cua.estado, true) = true',
    'COALESCE(c.estado, true) = true',
    '(COALESCE(cua.puede_responsable, false) = true OR COALESCE(cua.puede_auxiliar, false) = true)'
  ];

  if (scopeContext.targetSucursalId && !scopeContext.hasMultisucursalAccess) {
    params.push(scopeContext.targetSucursalId);
    filters.push(`c.id_sucursal = $${params.length}`);
  } else if (!scopeContext.isSuperAdmin) {
    params.push(scopeContext.allowedSucursalIds);
    filters.push(`c.id_sucursal = ANY($${params.length}::int[])`);
  }

  const result = await client.query(
    `
      SELECT
        cua.id_caja_usuario_autorizado,
        cua.id_caja,
        c.codigo_caja,
        c.nombre_caja,
        c.id_sucursal,
        s.nombre_sucursal,
        COALESCE(cua.puede_responsable, false) AS puede_responsable,
        COALESCE(cua.puede_auxiliar, false) AS puede_auxiliar,
        sesion_usuario.id_sesion_caja,
        sesion_usuario.estado_codigo,
        sesion_usuario.fecha_apertura,
        sesion_usuario.monto_apertura,
        sesion_caja.id_sesion_caja AS id_sesion_caja_abierta,
        sesion_caja.id_usuario_responsable AS id_usuario_responsable_abierta,
        sesion_caja.fecha_apertura AS fecha_apertura_abierta,
        sesion_caja.monto_apertura AS monto_apertura_abierta
      FROM public.cajas_usuarios_autorizados cua
      INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
      INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
      LEFT JOIN LATERAL (
        SELECT
          cs.id_sesion_caja,
          estado.codigo AS estado_codigo,
          cs.fecha_apertura,
          cs.monto_apertura
        FROM public.cajas_sesiones cs
        INNER JOIN public.cat_cajas_sesiones_estados estado
          ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
        WHERE cs.id_caja = cua.id_caja
          AND cs.id_estado_sesion_caja = $2
          AND (
            cs.id_usuario_responsable = $1
            OR EXISTS (
              SELECT 1
              FROM public.cajas_sesiones_participantes csp
              WHERE csp.id_sesion_caja = cs.id_sesion_caja
                AND csp.id_usuario = $1
                AND COALESCE(csp.activo, true) = true
            )
          )
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
        LIMIT 1
      ) sesion_usuario ON true
      LEFT JOIN LATERAL (
        SELECT cs.id_sesion_caja, cs.id_usuario_responsable, cs.fecha_apertura, cs.monto_apertura
        FROM public.cajas_sesiones cs
        WHERE cs.id_caja = cua.id_caja
          AND cs.id_estado_sesion_caja = $2
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
        LIMIT 1
      ) sesion_caja ON true
      WHERE ${filters.join(' AND ')}
      ORDER BY
        COALESCE(cua.puede_responsable, false) DESC,
        COALESCE(cua.puede_auxiliar, false) DESC,
        cua.fecha_actualizacion DESC,
        cua.id_caja_usuario_autorizado DESC
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE OF cua' : ''}
    `,
    params
  );

  const row = result.rows?.[0] || null;
  if (row) assertSucursalAllowed(scopeContext, row.id_sucursal);
  return row;
};

const buildCajaSessionPayload = (sessionLike, fallback = {}) => {
  const source = sessionLike || fallback;
  if (!source?.id_sesion_caja) return {};
  return {
    id_sesion_caja: Number(source.id_sesion_caja),
    id_caja: Number(source.id_caja ?? fallback.id_caja),
    codigo_caja: source.codigo_caja ?? fallback.codigo_caja,
    nombre_caja: source.nombre_caja ?? fallback.nombre_caja,
    id_sucursal: Number(source.id_sucursal ?? fallback.id_sucursal),
    nombre_sucursal: source.nombre_sucursal ?? fallback.nombre_sucursal,
    rol_codigo: source.rol_codigo ?? source.rol_participacion ?? fallback.rol_codigo ?? fallback.rol_participacion ?? null,
    rol_participacion: source.rol_participacion ?? source.rol_codigo ?? fallback.rol_participacion ?? fallback.rol_codigo ?? null,
    id_usuario_responsable: source.id_usuario_responsable ?? fallback.id_usuario_responsable ?? null,
    responsable_usuario: source.responsable_usuario ?? fallback.responsable_usuario ?? null,
    responsable_nombre: source.responsable_nombre ?? fallback.responsable_nombre ?? null,
    monto_apertura: roundMoney(source.monto_apertura ?? fallback.monto_apertura ?? 0),
    fecha_apertura: source.fecha_apertura ?? fallback.fecha_apertura ?? null
  };
};

const fetchMiSesionOperativaActiva = async (client, scopeContext) => {
  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  const params = [scopeContext.idUsuario, idEstadoAbierta];
  const filters = [
    'cs.id_estado_sesion_caja = $2',
    '(cs.id_usuario_responsable = $1 OR participante.id_participacion_caja IS NOT NULL)'
  ];

  if (scopeContext.targetSucursalId) {
    params.push(scopeContext.targetSucursalId);
    filters.push(`cs.id_sucursal = $${params.length}`);
  } else if (!scopeContext.isSuperAdmin) {
    params.push(scopeContext.allowedSucursalIds);
    filters.push(`cs.id_sucursal = ANY($${params.length}::int[])`);
  }

  const result = await client.query(
    `
      SELECT
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        c.codigo_caja,
        c.nombre_caja,
        s.nombre_sucursal,
        cs.id_usuario_responsable,
        resp.nombre_usuario AS responsable_usuario,
        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_resp.nombre, per_resp.apellido)), ''), resp.nombre_usuario) AS responsable_nombre,
        COALESCE(
          participante.rol_codigo,
          CASE WHEN cs.id_usuario_responsable = $1 THEN 'RESPONSABLE' END
        ) AS rol_participacion,
        cs.fecha_apertura,
        cs.monto_apertura
      FROM public.cajas_sesiones cs
      INNER JOIN public.cajas c
        ON c.id_caja = cs.id_caja
      INNER JOIN public.sucursales s
        ON s.id_sucursal = cs.id_sucursal
      INNER JOIN public.usuarios resp
        ON resp.id_usuario = cs.id_usuario_responsable
      LEFT JOIN public.empleados e_resp
        ON e_resp.id_empleado = resp.id_empleado
      LEFT JOIN public.personas per_resp
        ON per_resp.id_persona = e_resp.id_persona
      LEFT JOIN LATERAL (
        SELECT
          csp.id_participacion_caja,
          crp.codigo AS rol_codigo
        FROM public.cajas_sesiones_participantes csp
        LEFT JOIN public.cat_cajas_roles_participacion crp
          ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
        WHERE csp.id_sesion_caja = cs.id_sesion_caja
          AND csp.id_usuario = $1
          AND COALESCE(csp.activo, true) = true
        ORDER BY csp.fecha_inicio DESC NULLS LAST, csp.id_participacion_caja DESC
        LIMIT 1
      ) participante ON true
      WHERE ${filters.join(' AND ')}
      ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
      LIMIT 1
    `,
    params
  );

  const session = result.rows?.[0] || null;
  if (session) assertSucursalAllowed(scopeContext, session.id_sucursal);
  return session;
};

const buildMiCajaAsignadaPayload = (assignment) => {
  const sessionForUser = assignment.id_sesion_caja
    ? buildCajaSessionPayload(
        {
          id_sesion_caja: assignment.id_sesion_caja,
          id_caja: assignment.id_caja,
          codigo_caja: assignment.codigo_caja,
          nombre_caja: assignment.nombre_caja,
          id_sucursal: assignment.id_sucursal,
          nombre_sucursal: assignment.nombre_sucursal,
          monto_apertura: assignment.monto_apertura,
          fecha_apertura: assignment.fecha_apertura
        }
      )
    : null;

  const sessionOpenedByOther = !sessionForUser && assignment.id_sesion_caja_abierta
    ? buildCajaSessionPayload(
        {
          id_sesion_caja: assignment.id_sesion_caja_abierta,
          id_caja: assignment.id_caja,
          codigo_caja: assignment.codigo_caja,
          nombre_caja: assignment.nombre_caja,
          id_sucursal: assignment.id_sucursal,
          nombre_sucursal: assignment.nombre_sucursal,
          monto_apertura: assignment.monto_apertura_abierta,
          fecha_apertura: assignment.fecha_apertura_abierta
        }
      )
    : null;

  return {
    id_caja: Number(assignment.id_caja),
    codigo_caja: assignment.codigo_caja,
    nombre_caja: assignment.nombre_caja,
    id_sucursal: Number(assignment.id_sucursal),
    nombre_sucursal: assignment.nombre_sucursal,
    puede_responsable: Boolean(assignment.puede_responsable),
    puede_auxiliar: Boolean(assignment.puede_auxiliar),
    estado_operativo: sessionForUser
      ? 'SESION_ACTIVA_USUARIO'
      : sessionOpenedByOther
        ? 'ABIERTA_POR_OTRO_RESPONSABLE'
        : 'ASIGNADA_SIN_SESION',
    puede_operar: Boolean(sessionForUser),
    puede_abrir: Boolean(!sessionForUser && !sessionOpenedByOther && assignment.puede_responsable),
    caja_abierta_por_otro_responsable: Boolean(sessionOpenedByOther),
    id_usuario_responsable_abierta: sessionOpenedByOther
      ? Number(assignment.id_usuario_responsable_abierta)
      : null,
    ...(sessionForUser
      ? {
          ...sessionForUser,
          estado_codigo: assignment.estado_codigo
        }
      : {}),
    ...(sessionOpenedByOther
      ? {
          sesion_abierta: sessionOpenedByOther
        }
      : {})
  };
};

const fetchUsuarioSesionAbierta = async (client, idUsuario, { forUpdate = false } = {}) => {
  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  const result = await client.query(
    `
      SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.fecha_apertura, cs.monto_apertura
      FROM public.cajas_sesiones cs
      WHERE cs.id_estado_sesion_caja = $2
        AND (
          cs.id_usuario_responsable = $1
          OR EXISTS (
            SELECT 1
            FROM public.cajas_sesiones_participantes csp
            WHERE csp.id_sesion_caja = cs.id_sesion_caja
              AND csp.id_usuario = $1
              AND COALESCE(csp.activo, true) = true
          )
        )
      ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE OF cs' : ''}
    `,
    [idUsuario, idEstadoAbierta]
  );
  return result.rows?.[0] || null;
};

const fetchCajaOpeningEmailPayload = async (client, idSesionCaja) => {
  const result = await client.query(
    `
      SELECT
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        cs.id_usuario_responsable,
        cs.fecha_apertura,
        cs.monto_apertura,
        cs.observacion_apertura,
        c.codigo_caja,
        c.nombre_caja,
        s.nombre_sucursal,
        u.nombre_usuario,
        ${USER_DISPLAY_SQL} AS empleado_nombre,
        COALESCE(
          NULLIF(STRING_AGG(DISTINCT ${ROLE_NORMALIZED_SQL}, ', ') FILTER (WHERE r.id_rol IS NOT NULL), ''),
          'Sin rol'
        ) AS roles_usuario
      FROM public.cajas_sesiones cs
      INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
      INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
      INNER JOIN public.usuarios u ON u.id_usuario = cs.id_usuario_responsable
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN public.personas per ON per.id_persona = e.id_persona
      LEFT JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
      LEFT JOIN public.roles r ON r.id_rol = ru.id_rol
      WHERE cs.id_sesion_caja = $1
      GROUP BY
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        cs.id_usuario_responsable,
        cs.fecha_apertura,
        cs.monto_apertura,
        cs.observacion_apertura,
        c.codigo_caja,
        c.nombre_caja,
        s.nombre_sucursal,
        u.nombre_usuario,
        per.nombre,
        per.apellido
      LIMIT 1
    `,
    [idSesionCaja]
  );
  return result.rows?.[0] || null;
};

const buildCajaAperturaEmailHtml = (payload) => `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif; color:#1f2933; line-height:1.5;">
  <h2 style="margin:0 0 12px;">Apertura de caja</h2>
  <p>Se registro una nueva apertura de caja en JONNY'S SmartOrder.</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
    <tr><td><strong>Empleado</strong></td><td>${escapeHtml(payload.empleado_nombre || 'No disponible')}</td></tr>
    <tr><td><strong>Rol</strong></td><td>${escapeHtml(payload.roles_usuario || 'No disponible')}</td></tr>
    <tr><td><strong>Usuario</strong></td><td>${escapeHtml(payload.nombre_usuario || 'No disponible')}</td></tr>
    <tr><td><strong>Codigo de caja</strong></td><td>${escapeHtml(payload.codigo_caja || payload.id_caja)}</td></tr>
    <tr><td><strong>Nombre de caja</strong></td><td>${escapeHtml(payload.nombre_caja || 'No disponible')}</td></tr>
    <tr><td><strong>Sucursal</strong></td><td>${escapeHtml(payload.nombre_sucursal || payload.id_sucursal)}</td></tr>
    <tr><td><strong>Valor inicial</strong></td><td>${escapeHtml(formatMoneyLabel(payload.monto_apertura))}</td></tr>
    <tr><td><strong>Fecha/hora</strong></td><td>${escapeHtml(formatDateTimeLabel(payload.fecha_apertura))}</td></tr>
    <tr><td><strong>Observacion</strong></td><td>${escapeHtml(payload.observacion_apertura || 'N/A')}</td></tr>
  </table>
</body>
</html>`;

const sendCajaAperturaEmail = async (idSesionCaja) => {
  const payload = await fetchCajaOpeningEmailPayload(pool, idSesionCaja);
  if (!payload) {
    console.warn('[cajas] No se encontro informacion para correo de apertura de caja.', { idSesionCaja });
    return;
  }
  await enviarCorreo(
    CAJA_APERTURA_EMAIL_TO,
    'Nueva sesion de caja aperturada',
    buildCajaAperturaEmailHtml(payload),
    {
      id_usuario: payload.id_usuario_responsable,
      tipo_correo: 'caja_apertura',
      fromKey: 'ADMON'
    }
  );
};

const formatPayrollSyncLabel = (payrollSync) => {
  if (!payrollSync) return 'No disponible';
  const reason = String(payrollSync.reason || '').trim().toUpperCase();

  if (reason === 'NOT_REQUIRED') return 'No requerida';
  if (reason === 'UPDATED') return 'Deduccion sincronizada';
  if (reason === 'RESPONSABLE_CAJA_NO_DETERMINADO') return 'No sincronizada: responsable no determinado';
  if (reason === 'PLANILLA_DETAIL_NOT_FOUND') return 'No sincronizada: planilla no encontrada';
  if (reason === 'PLANILLA_NOT_EDITABLE') return 'No sincronizada: planilla no editable';
  if (reason === 'PAYROLL_DEDUCTION_NOT_CREATED') return 'No sincronizada: deduccion no creada';

  return payrollSync.synced
    ? `Sincronizada (${reason || 'OK'})`
    : `No sincronizada (${reason || 'sin motivo'})`;
};

const fetchCajaCloseEmailActors = async (client, { idUsuarioResponsable, idUsuarioCierre }) => {
  const ids = [
    parsePositiveInt(idUsuarioResponsable),
    parsePositiveInt(idUsuarioCierre)
  ].filter(Boolean);
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};

  const result = await client.query(
    `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        ${USER_DISPLAY_SQL} AS nombre_completo
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN public.personas per ON per.id_persona = e.id_persona
      WHERE u.id_usuario = ANY($1::int[])
    `,
    [uniqueIds]
  );
  const usersById = new Map(
    result.rows.map((row) => [Number(row.id_usuario), row])
  );
  const responsable = usersById.get(parsePositiveInt(idUsuarioResponsable));
  const cierre = usersById.get(parsePositiveInt(idUsuarioCierre));

  return {
    responsable_nombre: responsable?.nombre_completo || null,
    responsable_usuario: responsable?.nombre_usuario || null,
    cierre_nombre: cierre?.nombre_completo || null,
    cierre_usuario: cierre?.nombre_usuario || null
  };
};

const resolveCajaEmailActorLabel = (actors, primaryNameKey, primaryUserKey, fallback) =>
  actors?.[primaryNameKey] || actors?.[primaryUserKey] || fallback || 'No disponible';

const normalizeManualMovement = (row) => ({
  fecha_hora: row.fecha_movimiento || row.fecha_creacion || null,
  tipo_codigo: normalizeCajaCode(row.tipo_codigo, 80) || 'N/A',
  tipo: row.tipo_nombre || row.tipo_codigo || 'N/A',
  monto: Number(row.monto || 0),
  observacion: row.observacion || 'N/A',
  referencia: row.referencia || 'N/A',
  usuario_ejecutor: row.usuario_ejecutor_nombre || row.nombre_usuario || 'No disponible',
  signo: Number(row.signo || 0)
});

const splitManualMovements = (rows = []) => {
  const manualRows = (Array.isArray(rows) ? rows : [])
    .map(normalizeManualMovement)
    .filter((row) => !MANUAL_MOVEMENT_EXCLUDED_CODES.has(row.tipo_codigo));

  return {
    ingresos: manualRows.filter((row) => row.signo > 0),
    egresos: manualRows.filter((row) => row.signo < 0)
  };
};

const fetchCajaCloseManualMovements = async (client, idSesionCaja) => {
  const result = await client.query(
    `
      SELECT
        cm.fecha_movimiento,
        cm.fecha_creacion,
        cm.monto,
        cm.observacion,
        cm.referencia,
        mt.codigo AS tipo_codigo,
        mt.nombre AS tipo_nombre,
        mt.signo,
        u.nombre_usuario,
        ${USER_DISPLAY_SQL} AS usuario_ejecutor_nombre
      FROM public.cajas_movimientos cm
      INNER JOIN public.cat_cajas_movimientos_tipos mt
        ON mt.id_tipo_movimiento_caja = cm.id_tipo_movimiento_caja
      LEFT JOIN public.usuarios u ON u.id_usuario = cm.id_usuario_ejecutor
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN public.personas per ON per.id_persona = e.id_persona
      WHERE cm.id_sesion_caja = $1
        AND UPPER(TRIM(mt.codigo)) <> ALL($2::text[])
      ORDER BY cm.fecha_movimiento ASC, cm.id_movimiento_caja ASC
    `,
    [idSesionCaja, [...MANUAL_MOVEMENT_EXCLUDED_CODES]]
  );

  return splitManualMovements(result.rows);
};

const buildManualMovementEmailRows = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<tr><td colspan="6" style="color:#667085;">Sin movimientos manuales registrados.</td></tr>';
  }

  return rows.map((row) => `
    <tr>
      <td>${escapeHtml(formatDateTimeLabel(row.fecha_hora))}</td>
      <td>${escapeHtml(row.tipo)}</td>
      <td>${escapeHtml(formatMoneyLabel(row.monto))}</td>
      <td>${escapeHtml(row.observacion)}</td>
      <td>${escapeHtml(row.referencia)}</td>
      <td>${escapeHtml(row.usuario_ejecutor)}</td>
    </tr>
  `).join('');
};

const buildManualMovementEmailSection = (title, rows) => `
  <h3 style="margin:16px 0 8px;">${escapeHtml(title)}</h3>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%; border:1px solid #eaecf0;">
    <thead>
      <tr style="background:#f9fafb;">
        <th align="left">Fecha/hora</th>
        <th align="left">Tipo</th>
        <th align="left">Monto</th>
        <th align="left">Razon u observacion</th>
        <th align="left">Referencia</th>
        <th align="left">Usuario ejecutor</th>
      </tr>
    </thead>
    <tbody>${buildManualMovementEmailRows(rows)}</tbody>
  </table>
`;

const buildCajaCierreEmailHtml = (payload) => {
  const arqueosRows = Array.isArray(payload.arqueos) && payload.arqueos.length > 0
    ? payload.arqueos.map((row) => `
      <tr>
        <td>${escapeHtml(row.metodo_pago_codigo || row.id_metodo_pago || 'N/A')}</td>
        <td>${escapeHtml(formatMoneyLabel(row.monto_teorico))}</td>
        <td>${escapeHtml(formatMoneyLabel(row.monto_declarado))}</td>
        <td>${escapeHtml(formatMoneyLabel(row.diferencia))}</td>
        <td>${escapeHtml(row.requiere_revision ? 'Si' : 'No')}</td>
      </tr>
    `).join('')
    : `
      <tr>
        <td colspan="5" style="color:#667085;">Sin arqueos segmentados asociados.</td>
      </tr>
    `;
  const responsableLabel = resolveCajaEmailActorLabel(
    payload.actors,
    'responsable_nombre',
    'responsable_usuario',
    payload.session?.id_usuario_responsable
  );
  const cierreLabel = resolveCajaEmailActorLabel(
    payload.actors,
    'cierre_nombre',
    'cierre_usuario',
    payload.idUsuarioCierre
  );
  const auditMessage = payload.requiresAudit
    ? 'Este cierre de caja requiere auditoria por inconsistencias detectadas en el recuento o diferencia de cierre.'
    : 'Este cierre de caja fue registrado sin inconsistencias pendientes de auditoria.';
  const pdfMessage = payload.pdfAttached === false
    ? 'No fue posible adjuntar el PDF automaticamente; el resumen del cierre se incluye en este correo.'
    : 'Se adjunta el reporte PDF del cierre de caja para control interno.';
  const movimientosManuales = payload.movimientosManuales || {};

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif; color:#1f2933; line-height:1.5;">
  <h2 style="margin:0 0 12px;">Cierre de caja</h2>
  <p>Se registro un cierre de caja en JONNY'S SmartOrder.</p>
  <p>${escapeHtml(pdfMessage)}</p>
  <p style="font-weight:700; color:${payload.requiresAudit ? '#b42318' : '#027a48'};">${escapeHtml(auditMessage)}</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; margin-bottom:14px;">
    <tr><td><strong>Cierre</strong></td><td>CIE-${escapeHtml(String(payload.idCierreCaja || '').padStart(5, '0'))}</td></tr>
    <tr><td><strong>Sesion</strong></td><td>${escapeHtml(payload.idSesionCaja || 'No disponible')}</td></tr>
    <tr><td><strong>Codigo de caja</strong></td><td>${escapeHtml(payload.session?.codigo_caja || payload.session?.id_caja || 'No disponible')}</td></tr>
    <tr><td><strong>Nombre de caja</strong></td><td>${escapeHtml(payload.session?.nombre_caja || 'No disponible')}</td></tr>
    <tr><td><strong>Sucursal</strong></td><td>${escapeHtml(payload.session?.nombre_sucursal || payload.session?.id_sucursal || 'No disponible')}</td></tr>
    <tr><td><strong>Responsable</strong></td><td>${escapeHtml(responsableLabel)}</td></tr>
    <tr><td><strong>Usuario de cierre</strong></td><td>${escapeHtml(cierreLabel)}</td></tr>
    <tr><td><strong>Fecha/hora</strong></td><td>${escapeHtml(formatDateTimeLabel(payload.fechaCierre))}</td></tr>
    <tr><td><strong>Total teorico</strong></td><td>${escapeHtml(formatMoneyLabel(payload.montoTeorico))}</td></tr>
    <tr><td><strong>Total declarado</strong></td><td>${escapeHtml(formatMoneyLabel(payload.montoDeclaradoCierre))}</td></tr>
    <tr><td><strong>Diferencia</strong></td><td>${escapeHtml(formatMoneyLabel(payload.diferencia))}</td></tr>
    <tr><td><strong>Resolucion</strong></td><td>${escapeHtml(payload.resolutionCode || payload.idResolucionFinal || 'No disponible')}</td></tr>
    <tr><td><strong>Nomina</strong></td><td>${escapeHtml(formatPayrollSyncLabel(payload.payrollSync))}</td></tr>
  </table>
  <h3 style="margin:0 0 8px;">Arqueos por metodo</h3>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%; border:1px solid #eaecf0;">
    <thead>
      <tr style="background:#f9fafb;">
        <th align="left">Metodo</th>
        <th align="left">Teorico</th>
        <th align="left">Declarado</th>
        <th align="left">Diferencia</th>
        <th align="left">Revision</th>
      </tr>
    </thead>
    <tbody>${arqueosRows}</tbody>
  </table>
  ${buildManualMovementEmailSection('Ingresos manuales', movimientosManuales.ingresos)}
  ${buildManualMovementEmailSection('Egresos manuales', movimientosManuales.egresos)}
</body>
</html>`;
};

const sendCajaCierreEmail = async (payload) => {
  const subjectPrefix = payload.requiresAudit
    ? 'Cierre de caja requiere auditoria'
    : 'Cierre de caja registrado';
  const cajaLabel = payload.session?.codigo_caja || payload.session?.nombre_caja || payload.idSesionCaja;
  const sucursalLabel = payload.session?.nombre_sucursal || payload.session?.id_sucursal || 'Sucursal';
  const payrollSyncLabel = formatPayrollSyncLabel(payload.payrollSync);
  const attachments = [];
  try {
    const pdfPayload = { ...payload, payrollSyncLabel };
    const pdfBuffer = await buildCajaCierrePdfBuffer(pdfPayload);
    attachments.push({
      filename: buildCajaCierrePdfFilename(payload.idCierreCaja),
      content: pdfBuffer,
      contentType: 'application/pdf'
    });
  } catch (pdfError) {
    console.warn('[cajas] No se pudo generar PDF de cierre, se enviara correo sin adjunto:', pdfError?.message || pdfError);
  }
  const emailPayload = {
    ...payload,
    payrollSyncLabel,
    pdfAttached: attachments.length > 0
  };
  await enviarCorreo(
    CAJA_ADMIN_EMAIL_TO,
    `${subjectPrefix} - ${cajaLabel} - ${sucursalLabel}`,
    buildCajaCierreEmailHtml(emailPayload),
    {
      id_usuario: payload.session?.id_usuario_responsable,
      tipo_correo: 'caja_cierre',
      fromKey: 'ADMON',
      attachments
    }
  );
};

const fetchSessionBase = async (client, idSesionCaja, { forUpdate = false } = {}) => {
  const result = await client.query(
    `
      SELECT cs.*, c.codigo_caja, c.nombre_caja, COALESCE(c.estado, true) AS caja_estado, s.nombre_sucursal,
             estado.codigo AS estado_codigo, estado.nombre AS estado_nombre,
             ua.nombre_usuario AS apertura_usuario,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_apertura.nombre, per_apertura.apellido)), ''), ua.nombre_usuario) AS apertura_nombre,
             uc.nombre_usuario AS cierre_usuario,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_cierre.nombre, per_cierre.apellido)), ''), uc.nombre_usuario) AS cierre_nombre
      FROM public.cajas_sesiones cs
      INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
      INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
      INNER JOIN public.cat_cajas_sesiones_estados estado ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
      LEFT JOIN public.usuarios ua ON ua.id_usuario = cs.id_usuario_apertura
      LEFT JOIN public.empleados e_apertura ON e_apertura.id_empleado = ua.id_empleado
      LEFT JOIN public.personas per_apertura ON per_apertura.id_persona = e_apertura.id_persona
      LEFT JOIN public.usuarios uc ON uc.id_usuario = cs.id_usuario_cierre
      LEFT JOIN public.empleados e_cierre ON e_cierre.id_empleado = uc.id_empleado
      LEFT JOIN public.personas per_cierre ON per_cierre.id_persona = e_cierre.id_persona
      WHERE cs.id_sesion_caja = $1
      ${forUpdate ? 'FOR UPDATE OF cs' : ''}
    `,
    [idSesionCaja]
  );
  return result.rows[0] || null;
};

const insertAssignedAuxiliariesIntoSession = async ({
  client,
  idSesionCaja,
  idCaja,
  excludeUserIds = [],
  observacion = 'Auxiliar activo asignado al abrir sesion'
}) => {
  const idRolAuxiliar = await getCatalogId(client, 'PARTICIPATION_ROLES', 'AUXILIAR');
  if (!idRolAuxiliar) {
    throw createCajaError(409, 'VENTAS_CAJAS_AUXILIAR_ROLE_MISSING', 'No se encontro el rol de participacion AUXILIAR.');
  }

  const excludedIds = [...new Set(
    (Array.isArray(excludeUserIds) ? excludeUserIds : [])
      .map(parsePositiveInt)
      .filter(Boolean)
  )];

  await client.query(
    `
      INSERT INTO public.cajas_sesiones_participantes (
        id_sesion_caja, id_usuario, id_rol_participacion_caja,
        fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
      )
      SELECT
        $1,
        cua.id_usuario,
        $2,
        NOW(),
        true,
        $4,
        NOW(),
        NOW()
      FROM public.cajas_usuarios_autorizados cua
      WHERE cua.id_caja = $3
        AND COALESCE(cua.estado, true) = true
        AND COALESCE(cua.puede_auxiliar, false) = true
        AND NOT (cua.id_usuario = ANY($5::int[]))
      ON CONFLICT (id_sesion_caja, id_usuario) WHERE activo IS TRUE
      DO NOTHING
    `,
    [idSesionCaja, idRolAuxiliar, idCaja, observacion, excludedIds]
  );
};

const fetchOpenSessionForCaja = async (client, idCaja, { forUpdate = false } = {}) => {
  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  const result = await client.query(
    `
      SELECT id_sesion_caja, id_caja, id_sucursal, id_usuario_responsable
      FROM public.cajas_sesiones
      WHERE id_caja = $1
        AND id_estado_sesion_caja = $2
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [idCaja, idEstadoAbierta]
  );
  return result.rows?.[0] || null;
};

const insertSessionParticipant = async ({
  client,
  idSesionCaja,
  idUsuario,
  roleCode,
  observacion
}) => {
  const idRol = await getCatalogId(client, 'PARTICIPATION_ROLES', roleCode);
  if (!idRol) {
    throw createCajaError(409, 'VENTAS_CAJAS_PARTICIPATION_ROLE_MISSING', 'No se encontro el rol de participacion requerido.');
  }
  await client.query(
    `
      INSERT INTO public.cajas_sesiones_participantes (
        id_sesion_caja, id_usuario, id_rol_participacion_caja,
        fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
      )
      VALUES ($1, $2, $3, NOW(), true, $4, NOW(), NOW())
      ON CONFLICT (id_sesion_caja, id_usuario) WHERE activo IS TRUE
      DO NOTHING
    `,
    [idSesionCaja, idUsuario, idRol, observacion]
  );
};

const ensureOpenSession = async (client, idSesionCaja, options = {}) => {
  const session = await fetchSessionBase(client, idSesionCaja, options);
  if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  if (!idEstadoAbierta || Number(session.id_estado_sesion_caja) !== Number(idEstadoAbierta)) {
    throw createCajaError(409, 'VENTAS_CAJAS_SESSION_NOT_OPEN', 'La sesion de caja no se encuentra abierta.');
  }
  return session;
};

const ensureSessionParticipant = async (
  client,
  idSesionCaja,
  idUsuario,
  { allowAdminBypass = false, req = null, scopeContext = null } = {}
) => {
  const result = await client.query(
    `
      SELECT csp.id_participacion_caja, csp.id_usuario, crp.codigo AS rol_codigo, cs.id_caja, cs.id_sucursal
      FROM public.cajas_sesiones_participantes csp
      INNER JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = csp.id_sesion_caja
      INNER JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
      WHERE csp.id_sesion_caja = $1
        AND csp.id_usuario = $2
        AND COALESCE(csp.activo, true) = true
      LIMIT 1
    `,
    [idSesionCaja, idUsuario]
  );

  if (result.rowCount > 0) {
    const participant = result.rows[0];
    await assertCajaAuthorization(client, participant.id_caja, idUsuario, participant.rol_codigo);
    if (scopeContext) assertSucursalAllowed(scopeContext, participant.id_sucursal);
    return participant;
  }

  if (allowAdminBypass && req && (await requestHasAnyRole(req, ADMIN_ROLE_CODES))) {
    return null;
  }

  throw createCajaError(403, 'VENTAS_CAJAS_PARTICIPANT_REQUIRED', 'El usuario autenticado no participa activamente en la sesion de caja.');
};

const resolveEgresoMovimientoTipo = async (client, requestedTipoId = null) => {
  const idTipoMovimientoCaja = parseNullablePositiveInt(requestedTipoId);
  if (idTipoMovimientoCaja) {
    const result = await client.query(
      `
        SELECT id_tipo_movimiento_caja, codigo, nombre, signo, COALESCE(estado, true) AS estado
        FROM public.cat_cajas_movimientos_tipos
        WHERE id_tipo_movimiento_caja = $1
        LIMIT 1
      `,
      [idTipoMovimientoCaja]
    );
    const row = result.rows?.[0] || null;
    if (!row) {
      throw createCajaError(400, 'VENTAS_CAJAS_EGRESO_TIPO_INVALIDO', 'El tipo de egreso indicado no existe.');
    }
    if (!row.estado || Number(row.signo) !== -1) {
      throw createCajaError(400, 'VENTAS_CAJAS_EGRESO_TIPO_INVALIDO', 'El tipo de movimiento debe estar activo y ser de egreso.');
    }
    return row;
  }

  const result = await client.query(
    `
      SELECT id_tipo_movimiento_caja, codigo, nombre, signo, COALESCE(estado, true) AS estado
      FROM public.cat_cajas_movimientos_tipos
      WHERE COALESCE(estado, true) = true
        AND signo = -1
        AND UPPER(TRIM(codigo)) = ANY($1::text[])
      ORDER BY array_position($1::text[], UPPER(TRIM(codigo))), id_tipo_movimiento_caja ASC
      LIMIT 1
    `,
    [EGRESO_MOVEMENT_TYPE_CODES]
  );
  const row = result.rows?.[0] || null;
  if (!row) {
    throw createCajaError(
      409,
      'VENTAS_CAJAS_EGRESO_TIPO_NO_CONFIGURADO',
      'No hay un tipo de movimiento de egreso activo configurado para caja.'
    );
  }
  return row;
};

const resolveIngresoMovimientoTipo = async (client, requestedTipoId = null) => {
  const idTipoMovimientoCaja = parseNullablePositiveInt(requestedTipoId);
  if (idTipoMovimientoCaja) {
    const result = await client.query(
      `
        SELECT id_tipo_movimiento_caja, codigo, nombre, signo, COALESCE(estado, true) AS estado
        FROM public.cat_cajas_movimientos_tipos
        WHERE id_tipo_movimiento_caja = $1
        LIMIT 1
      `,
      [idTipoMovimientoCaja]
    );
    const row = result.rows?.[0] || null;
    const codigo = String(row?.codigo || '').trim().toUpperCase();
    if (!row) {
      throw createCajaError(400, 'VENTAS_CAJAS_INGRESO_TIPO_INVALIDO', 'El tipo de ingreso indicado no existe.');
    }
    if (!row.estado || Number(row.signo) !== 1 || codigo === 'APERTURA') {
      throw createCajaError(400, 'VENTAS_CAJAS_INGRESO_TIPO_INVALIDO', 'El tipo de movimiento debe estar activo y ser de ingreso manual.');
    }
    return row;
  }

  const result = await client.query(
    `
      SELECT id_tipo_movimiento_caja, codigo, nombre, signo, COALESCE(estado, true) AS estado
      FROM public.cat_cajas_movimientos_tipos
      WHERE COALESCE(estado, true) = true
        AND signo = 1
        AND UPPER(TRIM(codigo)) <> 'APERTURA'
        AND UPPER(TRIM(codigo)) = ANY($1::text[])
      ORDER BY array_position($1::text[], UPPER(TRIM(codigo))), id_tipo_movimiento_caja ASC
      LIMIT 1
    `,
    [INGRESO_MOVEMENT_TYPE_CODES]
  );
  const row = result.rows?.[0] || null;
  if (!row) {
    throw createCajaError(
      409,
      'VENTAS_CAJAS_INGRESO_TIPO_NO_CONFIGURADO',
      'No hay un tipo de movimiento de ingreso activo configurado para caja.'
    );
  }
  return row;
};

const insertCajaEgresoMovimiento = async ({
  client,
  session,
  idUsuarioEjecutor,
  monto,
  observacion,
  referencia,
  idTipoMovimientoCaja = null
}) => {
  const montoEgreso = parseNonNegativeAmount(monto);
  const observacionEgreso = normalizeText(observacion, 500);
  const referenciaEgreso = normalizeText(referencia, 120);
  if (montoEgreso === null || montoEgreso <= 0) {
    throw createCajaError(400, 'VENTAS_CAJAS_EGRESO_MONTO_INVALIDO', 'monto debe ser un numero mayor a 0.');
  }
  if (!observacionEgreso) {
    throw createCajaError(400, 'VENTAS_CAJAS_EGRESO_OBSERVACION_REQUIRED', 'La observacion del egreso es obligatoria.');
  }

  const tipoMovimiento = await resolveEgresoMovimientoTipo(client, idTipoMovimientoCaja);
  const insertResult = await client.query(
    `
      INSERT INTO public.cajas_movimientos (
        id_sesion_caja, id_caja, id_sucursal, id_tipo_movimiento_caja,
        id_usuario_ejecutor, monto, observacion, referencia, fecha_movimiento, fecha_creacion
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING id_movimiento_caja
    `,
    [
      session.id_sesion_caja,
      session.id_caja,
      session.id_sucursal,
      tipoMovimiento.id_tipo_movimiento_caja,
      idUsuarioEjecutor,
      montoEgreso,
      observacionEgreso,
      referenciaEgreso
    ]
  );

  return {
    id_movimiento_caja: Number(insertResult.rows?.[0]?.id_movimiento_caja || 0) || null,
    id_sesion_caja: Number(session.id_sesion_caja),
    id_caja: Number(session.id_caja),
    id_sucursal: Number(session.id_sucursal),
    monto: montoEgreso
  };
};

const insertCajaIngresoMovimiento = async ({
  client,
  session,
  idUsuarioEjecutor,
  monto,
  observacion,
  referencia,
  idTipoMovimientoCaja = null
}) => {
  const montoIngreso = parseNonNegativeAmount(monto);
  const observacionIngreso = normalizeText(observacion, 500);
  const referenciaIngreso = normalizeText(referencia, 120);
  if (montoIngreso === null || montoIngreso <= 0) {
    throw createCajaError(400, 'VENTAS_CAJAS_INGRESO_MONTO_INVALIDO', 'monto debe ser un numero mayor a 0.');
  }
  if (!observacionIngreso) {
    throw createCajaError(400, 'VENTAS_CAJAS_INGRESO_OBSERVACION_REQUIRED', 'La observacion del ingreso es obligatoria.');
  }

  const tipoMovimiento = await resolveIngresoMovimientoTipo(client, idTipoMovimientoCaja);
  const insertResult = await client.query(
    `
      INSERT INTO public.cajas_movimientos (
        id_sesion_caja, id_caja, id_sucursal, id_tipo_movimiento_caja,
        id_usuario_ejecutor, monto, observacion, referencia, fecha_movimiento, fecha_creacion
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING id_movimiento_caja
    `,
    [
      session.id_sesion_caja,
      session.id_caja,
      session.id_sucursal,
      tipoMovimiento.id_tipo_movimiento_caja,
      idUsuarioEjecutor,
      montoIngreso,
      observacionIngreso,
      referenciaIngreso
    ]
  );

  return {
    id_movimiento_caja: Number(insertResult.rows?.[0]?.id_movimiento_caja || 0) || null,
    id_sesion_caja: Number(session.id_sesion_caja),
    id_caja: Number(session.id_caja),
    id_sucursal: Number(session.id_sucursal),
    monto: montoIngreso
  };
};

const persistCloseValidationAttempt = async ({
  client,
  session,
  idUsuarioValida,
  computation,
  payloadRows,
  observacionCierre,
  origen,
  ipOrigen,
  userAgent
}) => {
  await client.query('SELECT pg_advisory_xact_lock(8152026, $1::integer)', [session.id_sesion_caja]);
  const attemptResult = await client.query(
    `
      SELECT COALESCE(MAX(numero_intento), 0) + 1 AS numero_intento
      FROM public.cajas_cierres_validaciones
      WHERE id_sesion_caja = $1
    `,
    [session.id_sesion_caja]
  );
  const numeroIntento = Number(attemptResult.rows?.[0]?.numero_intento || 1);
  const hayDiferencia = computation.rows.some((row) => roundMoney(row.diferencia) !== 0);
  const payloadDeclarado = {
    arqueos: Array.isArray(payloadRows) ? payloadRows : [],
    observacion_cierre: observacionCierre || null
  };
  const resultado = {
    resumen: {
      total_teorico: computation.monto_teorico_total,
      total_declarado: computation.monto_declarado_total,
      diferencia_total: computation.diferencia_total,
      hay_diferencia: hayDiferencia
    },
    metodos: computation.rows
  };

  const validationResult = await client.query(
    `
      INSERT INTO public.cajas_cierres_validaciones (
        id_sesion_caja, id_caja, id_sucursal, id_usuario_valida, numero_intento,
        origen, total_teorico, total_declarado, diferencia_total, hay_diferencia,
        payload_declarado_json, resultado_json, observacion_general, ip_origen, user_agent,
        fecha_validacion, fecha_creacion
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, NOW(), NOW())
      RETURNING id_validacion_cierre
    `,
    [
      session.id_sesion_caja,
      session.id_caja,
      session.id_sucursal,
      idUsuarioValida,
      numeroIntento,
      normalizeCajaCode(origen, 80) || 'REVISION_DIFERENCIAS',
      computation.monto_teorico_total,
      computation.monto_declarado_total,
      computation.diferencia_total,
      hayDiferencia,
      JSON.stringify(payloadDeclarado),
      JSON.stringify(resultado),
      observacionCierre || null,
      normalizeText(ipOrigen, 120),
      normalizeText(userAgent, 300)
    ]
  );
  const idValidacionCierre = Number(validationResult.rows?.[0]?.id_validacion_cierre || 0) || null;

  for (const row of computation.rows) {
    await client.query(
      `
        INSERT INTO public.cajas_cierres_validaciones_metodos (
          id_validacion_cierre, id_metodo_pago, metodo_pago_codigo, monto_teorico,
          monto_declarado, diferencia, cantidad_referencias, resultado,
          requiere_revision, observacion, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      `,
      [
        idValidacionCierre,
        row.id_metodo_pago,
        row.metodo_pago_codigo,
        row.monto_teorico,
        row.monto_declarado,
        row.diferencia,
        row.cantidad_referencias,
        row.resultado,
        row.requiere_revision,
        row.observacion
      ]
    );
  }

  return {
    id_validacion_cierre: idValidacionCierre,
    numero_intento: numeroIntento,
    hay_diferencia: hayDiferencia
  };
};

const buildCloseValidationResponse = ({ validation, computation, isCashierOnly }) => {
  const base = {
    message: 'Diferencias revisadas correctamente.',
    id_validacion_cierre: validation.id_validacion_cierre,
    numero_intento: validation.numero_intento,
    comparacion_visible: true,
    teorico_visible: !isCashierOnly,
    resumen: {
      total_declarado: computation.monto_declarado_total,
      diferencia_total: computation.diferencia_total,
      hay_diferencia: validation.hay_diferencia
    },
    metodos: computation.rows.map((row) => ({
      metodo_pago_codigo: row.metodo_pago_codigo,
      monto_declarado: row.monto_declarado,
      diferencia: row.diferencia,
      resultado: row.resultado,
      requiere_revision: row.requiere_revision,
      observacion_requerida: row.observacion_requerida,
      observacion_presente: row.observacion_presente,
      cantidad_referencias: row.cantidad_referencias,
      ...(isCashierOnly ? {} : { monto_teorico: row.monto_teorico })
    }))
  };

  if (!isCashierOnly) {
    base.resumen.total_teorico = computation.monto_teorico_total;
  }

  return base;
};

const buildSessionDetailPayload = async (client, session) => {
  const [
    responsableResult,
    participantesResult,
    cobrosResult,
    arqueosResult,
    ultimoArqueoCierreResult,
    movimientosResult,
    cierreResult,
    resumenResult,
    arqueosMetodosResult,
    validacionesResult,
    validacionesMetodosResult
  ] =
    await Promise.all([
      client.query(
        `
          SELECT u.id_usuario, u.nombre_usuario, ${USER_DISPLAY_SQL} AS nombre_completo
          FROM public.usuarios u
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          WHERE u.id_usuario = $1
          LIMIT 1
        `,
        [session.id_usuario_responsable]
      ),
      client.query(
        `
          SELECT csp.*, crp.codigo AS rol_codigo, crp.nombre AS rol_nombre,
                 u.nombre_usuario, ${USER_DISPLAY_SQL} AS nombre_completo,
                 ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${ROLE_NORMALIZED_SQL}), NULL) AS roles_globales
          FROM public.cajas_sesiones_participantes csp
          INNER JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
          INNER JOIN public.usuarios u ON u.id_usuario = csp.id_usuario
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          LEFT JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
          LEFT JOIN public.roles r ON r.id_rol = ru.id_rol
          WHERE csp.id_sesion_caja = $1
          GROUP BY
            csp.id_participacion_caja,
            crp.codigo,
            crp.nombre,
            u.nombre_usuario,
            per.nombre,
            per.apellido
          ORDER BY csp.fecha_inicio ASC, csp.id_participacion_caja ASC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT
            fc.id_sesion_caja,
            fc.id_caja,
            fc.id_sucursal,
            fc.id_usuario_ejecutor,
            COUNT(*)::integer AS cobros_registrados,
            COUNT(*)::integer AS cantidad_cobros,
            COALESCE(SUM(CASE WHEN UPPER(TRIM(mp.codigo)) = 'EFECTIVO' THEN fc.monto ELSE 0 END), 0)::numeric(12,2) AS total_efectivo,
            COALESCE(SUM(CASE WHEN UPPER(TRIM(mp.codigo)) <> 'EFECTIVO' THEN fc.monto ELSE 0 END), 0)::numeric(12,2) AS total_no_efectivo,
            COALESCE(SUM(fc.monto), 0)::numeric(12,2) AS total_cobrado,
            MIN(fc.fecha_cobro) AS primer_cobro,
            MAX(fc.fecha_cobro) AS ultimo_cobro,
            u.nombre_usuario,
            ${USER_DISPLAY_SQL} AS nombre_completo
          FROM public.facturas_cobros fc
          INNER JOIN public.cat_metodos_pago mp ON mp.id_metodo_pago = fc.id_metodo_pago
          INNER JOIN public.usuarios u ON u.id_usuario = fc.id_usuario_ejecutor
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          WHERE fc.id_sesion_caja = $1
          GROUP BY
            fc.id_sesion_caja,
            fc.id_caja,
            fc.id_sucursal,
            fc.id_usuario_ejecutor,
            u.nombre_usuario,
            per.nombre,
            per.apellido
          ORDER BY total_cobrado DESC, fc.id_usuario_ejecutor ASC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT a.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre
          FROM public.cajas_arqueos a
          INNER JOIN public.cat_cajas_arqueos_tipos tipo ON tipo.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja
          WHERE a.id_sesion_caja = $1
          ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT a.id_arqueo_caja, a.monto_contado, a.diferencia, a.fecha_arqueo
          FROM public.cajas_arqueos a
          INNER JOIN public.cat_cajas_arqueos_tipos t ON t.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja
          WHERE a.id_sesion_caja = $1
            AND UPPER(TRIM(t.codigo)) = 'CIERRE'
          ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC
          LIMIT 1
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT m.*,
                 tipo.codigo AS tipo_codigo,
                 tipo.nombre AS tipo_nombre,
                 tipo.signo,
                 tipo.afecta_efectivo,
                 u.nombre_usuario AS usuario_ejecutor_alias,
                 u.nombre_usuario,
                 ${USER_DISPLAY_SQL} AS usuario_ejecutor_nombre,
                 COALESCE(
                   crp.codigo,
                   CASE WHEN m.id_usuario_ejecutor = $2 THEN 'RESPONSABLE' ELSE 'EJECUTOR' END
                 ) AS rol_participacion_codigo,
                 COALESCE(
                   crp.nombre,
                   CASE WHEN m.id_usuario_ejecutor = $2 THEN 'Responsable' ELSE 'Ejecutor' END
                 ) AS rol_participacion_nombre
          FROM public.cajas_movimientos m
          INNER JOIN public.cat_cajas_movimientos_tipos tipo ON tipo.id_tipo_movimiento_caja = m.id_tipo_movimiento_caja
          LEFT JOIN public.usuarios u ON u.id_usuario = m.id_usuario_ejecutor
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          LEFT JOIN public.cajas_sesiones_participantes csp
            ON csp.id_sesion_caja = m.id_sesion_caja
           AND csp.id_usuario = m.id_usuario_ejecutor
          LEFT JOIN public.cat_cajas_roles_participacion crp
            ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
          WHERE m.id_sesion_caja = $1
          ORDER BY m.fecha_movimiento DESC, m.id_movimiento_caja DESC
        `,
        [session.id_sesion_caja, session.id_usuario_responsable]
      ),
      client.query(
        `
          SELECT cc.*, resolucion.codigo AS resolucion_codigo, resolucion.nombre AS resolucion_nombre
          FROM public.cajas_cierres cc
          LEFT JOIN public.cat_cajas_resoluciones_cierre resolucion ON resolucion.id_resolucion_cierre_caja = cc.id_resolucion_cierre_caja
          WHERE cc.id_sesion_caja = $1
          ORDER BY cc.id_cierre_caja DESC
          LIMIT 1
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT *
          FROM public.vw_cajas_sesiones_resumen
          WHERE id_sesion_caja = $1
          LIMIT 1
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT cam.*
          FROM public.cajas_cierres_arqueos_metodos cam
          INNER JOIN public.cajas_cierres cc ON cc.id_cierre_caja = cam.id_cierre_caja
          WHERE cc.id_sesion_caja = $1
          ORDER BY cam.id_arqueo_metodo ASC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT v.id_validacion_cierre,
                 v.numero_intento,
                 v.id_cierre_caja,
                 (v.id_cierre_caja IS NOT NULL) AS usado_para_cierre,
                 v.id_usuario_valida,
                 COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''), u.nombre_usuario) AS usuario_valida_nombre,
                 u.nombre_usuario AS usuario_valida,
                 v.fecha_validacion,
                 v.total_teorico,
                 v.total_declarado,
                 v.diferencia_total,
                 v.hay_diferencia,
                 v.observacion_general
          FROM public.cajas_cierres_validaciones v
          LEFT JOIN public.usuarios u ON u.id_usuario = v.id_usuario_valida
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          WHERE v.id_sesion_caja = $1
          ORDER BY v.numero_intento DESC, v.fecha_validacion DESC, v.id_validacion_cierre DESC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT vm.id_validacion_cierre,
                 vm.metodo_pago_codigo,
                 vm.monto_teorico,
                 vm.monto_declarado,
                 vm.diferencia,
                 vm.cantidad_referencias,
                 vm.resultado,
                 vm.requiere_revision,
                 vm.observacion
          FROM public.cajas_cierres_validaciones_metodos vm
          INNER JOIN public.cajas_cierres_validaciones v
            ON v.id_validacion_cierre = vm.id_validacion_cierre
          WHERE v.id_sesion_caja = $1
          ORDER BY v.numero_intento DESC, vm.id_validacion_metodo ASC
        `,
        [session.id_sesion_caja]
      )
    ]);

  const participantsByUserId = new Map();
  for (const participante of participantesResult.rows) {
    const participantUserId = Number(participante?.id_usuario || 0);
    if (!participantUserId) continue;
    participantsByUserId.set(participantUserId, participante);
  }

  const cobrosPorUsuario = cobrosResult.rows
    .map((row) => {
      const idUsuarioEjecutor = Number(row?.id_usuario_ejecutor || 0);
      if (!idUsuarioEjecutor) return null;

      const participante = participantsByUserId.get(idUsuarioEjecutor) || null;
      const participantRoleCode = String(participante?.rol_codigo || '').trim().toUpperCase();
      const fallbackRoleCode =
        idUsuarioEjecutor === Number(session.id_usuario_responsable) ? 'RESPONSABLE' : 'EJECUTOR';
      const rolParticipacion = participantRoleCode || fallbackRoleCode;
      const esResponsable = rolParticipacion === 'RESPONSABLE';
      const esAuxiliar = rolParticipacion === 'AUXILIAR';

      return {
        ...row,
        id_usuario_ejecutor: idUsuarioEjecutor,
        cobros_registrados: Number(
          row?.cobros_registrados ?? row?.cantidad_cobros ?? row?.total_cobros ?? 0
        ),
        total_cobrado: Number(row?.total_cobrado || 0),
        total_efectivo: Number(row?.total_efectivo || 0),
        total_no_efectivo: Number(row?.total_no_efectivo || 0),
        rol_participacion: rolParticipacion,
        es_responsable: esResponsable,
        es_auxiliar: esAuxiliar
      };
    })
    .filter(Boolean);

  const totalResponsable = cobrosPorUsuario
    .filter((row) => row.es_responsable)
    .reduce((sum, row) => sum + Number(row.total_cobrado || 0), 0);
  const totalAuxiliares = cobrosPorUsuario
    .filter((row) => row.es_auxiliar)
    .reduce((sum, row) => sum + Number(row.total_cobrado || 0), 0);
  const totalOtrosEjecutores = cobrosPorUsuario
    .filter((row) => !row.es_responsable && !row.es_auxiliar)
    .reduce((sum, row) => sum + Number(row.total_cobrado || 0), 0);

  const metodosPorValidacion = new Map();
  for (const row of validacionesMetodosResult.rows || []) {
    const idValidacion = Number(row.id_validacion_cierre || 0);
    if (!idValidacion) continue;
    if (!metodosPorValidacion.has(idValidacion)) metodosPorValidacion.set(idValidacion, []);
    metodosPorValidacion.get(idValidacion).push({
      metodo_pago_codigo: String(row.metodo_pago_codigo || '').trim().toUpperCase(),
      monto_teorico: row.monto_teorico === null || row.monto_teorico === undefined ? null : Number(row.monto_teorico),
      monto_declarado: Number(row.monto_declarado || 0),
      diferencia: row.diferencia === null || row.diferencia === undefined ? null : Number(row.diferencia),
      cantidad_referencias: row.cantidad_referencias === null || row.cantidad_referencias === undefined ? null : Number(row.cantidad_referencias),
      resultado: String(row.resultado || '').trim().toUpperCase(),
      requiere_revision: Boolean(row.requiere_revision),
      observacion: row.observacion || null
    });
  }

  const recuentos = (validacionesResult.rows || []).map((row) => {
    const idValidacion = Number(row.id_validacion_cierre || 0);
    return {
      id_validacion_cierre: idValidacion || null,
      numero_intento: Number(row.numero_intento || 0),
      id_cierre_caja: row.id_cierre_caja === null || row.id_cierre_caja === undefined ? null : Number(row.id_cierre_caja),
      usado_para_cierre: Boolean(row.usado_para_cierre),
      id_usuario_valida: row.id_usuario_valida === null || row.id_usuario_valida === undefined ? null : Number(row.id_usuario_valida),
      usuario_valida_nombre: row.usuario_valida_nombre || row.usuario_valida || null,
      fecha_validacion: row.fecha_validacion || null,
      total_teorico: row.total_teorico === null || row.total_teorico === undefined ? null : Number(row.total_teorico),
      total_declarado: row.total_declarado === null || row.total_declarado === undefined ? null : Number(row.total_declarado),
      diferencia_total: row.diferencia_total === null || row.diferencia_total === undefined ? null : Number(row.diferencia_total),
      hay_diferencia: Boolean(row.hay_diferencia),
      observacion_general: row.observacion_general || null,
      metodos: metodosPorValidacion.get(idValidacion) || []
    };
  });
  const financialSummary = await fetchSessionMethodFinancialSummary(client, session.id_sesion_caja);
  const cierre = cierreResult.rows[0] || null;
  const recuentoUsadoParaCierre = recuentos.find((row) => row.usado_para_cierre) || null;
  const montoTeoricoTotal = roundMoney(
    cierre?.monto_teorico_cierre
    ?? recuentoUsadoParaCierre?.total_teorico
    ?? financialSummary.totalTeorico
  );
  const montoDeclaradoTotal = cierre?.monto_declarado_cierre === null || cierre?.monto_declarado_cierre === undefined
    ? (recuentoUsadoParaCierre?.total_declarado ?? null)
    : roundMoney(cierre.monto_declarado_cierre);
  const diferenciaTotal = cierre?.diferencia === null || cierre?.diferencia === undefined
    ? (recuentoUsadoParaCierre?.diferencia_total ?? null)
    : roundMoney(cierre.diferencia);

  return {
    sesion: session,
    responsable: responsableResult.rows[0] || null,
    participantes: participantesResult.rows,
    cobros_por_usuario: cobrosPorUsuario,
    resumen_operativo: {
      ...(resumenResult.rows[0] || {}),
      monto_apertura: financialSummary.montoApertura,
      ventas_efectivo: financialSummary.ventasEfectivoNetas,
      ventas_no_efectivo: financialSummary.ventasNoEfectivoNetas,
      ventas_tarjeta: financialSummary.ventasTarjetaNetas,
      ventas_transferencia: financialSummary.ventasTransferenciaNetas,
      ingresos_manuales: financialSummary.ingresosManuales,
      egresos_manuales: financialSummary.egresosManuales,
      efectivo_teorico: financialSummary.efectivoTeorico,
      tarjeta_teorico: financialSummary.tarjetaTeorico,
      transferencia_teorico: financialSummary.transferenciaTeorico,
      monto_teorico: montoTeoricoTotal,
      monto_teorico_total: montoTeoricoTotal,
      total_teorico: montoTeoricoTotal,
      monto_declarado: montoDeclaradoTotal,
      monto_declarado_total: montoDeclaradoTotal,
      diferencia_total: diferenciaTotal,
      diferencia_cierre: diferenciaTotal,
      total_responsable: Number(totalResponsable.toFixed(2)),
      total_auxiliares: Number(totalAuxiliares.toFixed(2)),
      total_otros_ejecutores: Number(totalOtrosEjecutores.toFixed(2)),
      responsabilidad_final_id_usuario: Number(session.id_usuario_responsable),
      ultimo_arqueo_cierre: ultimoArqueoCierreResult.rows?.[0] || null
    },
    arqueos: arqueosResult.rows,
    movimientos: movimientosResult.rows,
    arqueos_metodos: arqueosMetodosResult.rows || [],
    recuentos,
    validaciones_cierre: recuentos,
    incidencias: [],
    cierre
  };
};

router.get('/ventas/cajas/sesion-activa', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const scopeContext = await getScopeContext(req, pool);
    const idEstadoAbierta = await getCatalogId(pool, 'SESSION_STATES', 'ABIERTA');
    const result = await pool.query(
      `
        SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.fecha_apertura, cs.monto_apertura,
               cs.id_usuario_responsable, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               resp.nombre_usuario AS responsable_usuario,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_resp.nombre, per_resp.apellido)), ''), resp.nombre_usuario) AS responsable_nombre,
               COALESCE(crp.codigo, CASE WHEN cs.id_usuario_responsable = $1 THEN 'RESPONSABLE' END) AS rol_codigo
        FROM public.cajas_sesiones cs
        LEFT JOIN public.cajas_sesiones_participantes csp ON csp.id_sesion_caja = cs.id_sesion_caja
          AND csp.id_usuario = $1 AND COALESCE(csp.activo, true) = true
        LEFT JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
        INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
        INNER JOIN public.usuarios resp ON resp.id_usuario = cs.id_usuario_responsable
        LEFT JOIN public.empleados e_resp ON e_resp.id_empleado = resp.id_empleado
        LEFT JOIN public.personas per_resp ON per_resp.id_persona = e_resp.id_persona
        WHERE cs.id_estado_sesion_caja = $2
          AND (cs.id_usuario_responsable = $1 OR csp.id_participacion_caja IS NOT NULL)
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
        LIMIT 1
      `,
      [scopeContext.idUsuario, idEstadoAbierta]
    );

    if (result.rowCount === 0) return res.status(200).json({ activa: false, session: null });
    assertSucursalAllowed(scopeContext, result.rows[0].id_sucursal);
    return res.status(200).json({ activa: true, session: result.rows[0] });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_ACTIVE_SESSION_ERROR', 'No se pudo obtener la sesión activa de caja.');
  }
});

router.get('/ventas/cajas/mi-sesion-activa', checkPermission(['VENTAS_CAJAS_SESION_ABRIR']), async (req, res) => {
  try {
    const hasSucursalQuery = Object.prototype.hasOwnProperty.call(req.query || {}, 'id_sucursal');
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    if (hasSucursalQuery && !requestedSucursalId) {
      throw createCajaError(400, 'VENTAS_CAJAS_SCOPE_INVALID', 'El id de sucursal es invalido.');
    }

    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const session = await fetchMiSesionOperativaActiva(pool, scopeContext);
    if (!session) return res.status(200).json({ activa: false, session: null });

    return res.status(200).json({
      activa: true,
      session: buildCajaSessionPayload(session)
    });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_MY_ACTIVE_SESSION_ERROR', 'No se pudo obtener la sesion activa de caja.');
  }
});

router.get('/ventas/cajas/mi-asignacion-activa', checkPermission(['VENTAS_CAJAS_SESION_ABRIR']), async (req, res) => {
  try {
    const scopeContext = await getScopeContext(req, pool, null, true);
    const assignment = await fetchMiCajaAsignadaActiva(pool, scopeContext);
    if (!assignment) {
      console.info('[cajas] asignacion activa directa no encontrada', {
        id_usuario: scopeContext.idUsuario,
        id_sucursal_scope: scopeContext.targetSucursalId || null,
        sucursales_permitidas: scopeContext.allowedSucursalIds.length
      });
      throw createCajaError(
        404,
        'CAJA_ASIGNACION_NO_ENCONTRADA',
        'No tienes una caja asignada activa.'
      );
    }

    return res.status(200).json(buildMiCajaAsignadaPayload(assignment));
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_MY_ASSIGNMENT_ERROR', 'No se pudo obtener la caja asignada.');
  }
});

router.get('/ventas/cajas/catalogos', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  const client = await pool.connect();
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, client, requestedSucursalId, true);
    const isRestrictedCajero = await requestIsRestrictedCajero(req);

    const cajasParams = [];
    const cajasFilters = ['COALESCE(c.estado, true) = true'];
    if (scopeContext.targetSucursalId) {
      cajasParams.push(scopeContext.targetSucursalId);
      cajasFilters.push(`c.id_sucursal = $${cajasParams.length}`);
    } else if (!scopeContext.isSuperAdmin) {
      cajasParams.push(scopeContext.allowedSucursalIds);
      cajasFilters.push(`c.id_sucursal = ANY($${cajasParams.length}::int[])`);
    }
    if (isRestrictedCajero) {
      cajasParams.push(scopeContext.idUsuario);
      cajasFilters.push(`
        EXISTS (
          SELECT 1
          FROM public.cajas_usuarios_autorizados cua
          WHERE cua.id_caja = c.id_caja
            AND cua.id_usuario = $${cajasParams.length}
            AND COALESCE(cua.estado, true) = true
            AND (COALESCE(cua.puede_responsable, false) = true OR COALESCE(cua.puede_auxiliar, false) = true)
        )
      `);
    }

    const cajas = await client.query(`SELECT id_caja, id_sucursal, codigo_caja, nombre_caja, estado FROM public.cajas c WHERE ${cajasFilters.join(' AND ')} ORDER BY c.id_sucursal ASC, c.nombre_caja ASC`, cajasParams);
    const estados = await client.query(`SELECT * FROM public.cat_cajas_sesiones_estados WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`);
    const roles = await client.query(`SELECT * FROM public.cat_cajas_roles_participacion WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`);
    const movimientos = await client.query(`SELECT * FROM public.cat_cajas_movimientos_tipos WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`);
    const metodosPago = await client.query(`SELECT * FROM public.cat_metodos_pago WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`);
    const resoluciones = await client.query(`SELECT * FROM public.cat_cajas_resoluciones_cierre WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`);
    const tiposArqueo = await client.query(`
      SELECT *
      FROM public.cat_cajas_arqueos_tipos
      WHERE COALESCE(estado, true) = true
        AND UPPER(TRIM(codigo)) IN ('CIERRE', 'EXTRAORDINARIO')
      ORDER BY nombre ASC
    `);

    return res.status(200).json({
      cajas: cajas.rows,
      estados_sesion: estados.rows,
      roles_participacion: roles.rows,
      tipos_movimiento: movimientos.rows,
      metodos_pago: metodosPago.rows,
      resoluciones_cierre: resoluciones.rows,
      tipos_arqueo: tiposArqueo.rows
    });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOGS_ERROR', 'No se pudieron obtener los catálogos de Gestión de cajas.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/usuarios', checkPermission(['VENTAS_CAJAS_LISTADO_VER', 'VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const targetSucursalId = parsePositiveInt(scopeContext.targetSucursalId || requestedSucursalId);

    if (!targetSucursalId) {
      throw createCajaError(400, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'Debe indicar una sucursal para listar usuarios.');
    }
    assertSucursalAllowed(scopeContext, targetSucursalId);

    const rolOperativo = String(req.query.rol_operativo || '').trim().toUpperCase();
    if (!['RESPONSABLE', 'AUXILIAR'].includes(rolOperativo)) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_ROLE_OPERATIVO_INVALID',
        'Debe indicar un rol operativo valido: RESPONSABLE o AUXILIAR.'
      );
    }

    const result = await pool.query(
      `
        SELECT u.id_usuario, u.nombre_usuario,
               COALESCE(
                 NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
                 u.nombre_usuario
               ) AS nombre_completo,
               ARRAY_AGG(DISTINCT ${ROLE_NORMALIZED_SQL}) AS roles_normalizados
        FROM public.usuarios u
        INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
        INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
        INNER JOIN public.roles r ON r.id_rol = ru.id_rol
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        WHERE COALESCE(u.estado, true) = true
          AND COALESCE(e.estado, true) = true
          AND (
            (
              $2 = 'AUXILIAR'
              AND EXISTS (
                  SELECT 1
                  FROM public.roles_usuarios ru_super
                  INNER JOIN public.roles r_super ON r_super.id_rol = ru_super.id_rol
                  WHERE ru_super.id_usuario = u.id_usuario
                  AND UPPER(REGEXP_REPLACE(TRIM(r_super.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN'
              )
            )
            OR
            e.id_sucursal = $1
            OR EXISTS (
              SELECT 1
              FROM public.v_usuarios_sucursales_scope vus
              WHERE vus.id_usuario = u.id_usuario
                AND COALESCE(vus.estado, true) = true
                AND vus.id_sucursal = $1
            )
            OR EXISTS (
              SELECT 1
              FROM public.empleados_sucursales es
              WHERE es.id_empleado = u.id_empleado
                AND COALESCE(es.estado, true) = true
                AND es.id_sucursal = $1
            )
            OR EXISTS (
              SELECT 1
              FROM public.usuarios_sucursales us
              WHERE us.id_usuario = u.id_usuario
                AND us.id_sucursal = $1
            )
          )
        GROUP BY u.id_usuario, u.nombre_usuario, per.nombre, per.apellido
        ORDER BY nombre_completo ASC
      `,
      [targetSucursalId, rolOperativo]
    );

    let rows = result.rows;
    if (rolOperativo === 'RESPONSABLE') {
      rows = rows.filter((row) => isCajaUserCajero(row.roles_normalizados));
    }
    return res.status(200).json(rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_USERS_LIST_ERROR', 'No se pudieron listar los usuarios disponibles.');
  }
});

router.get('/ventas/cajas/sesiones-abiertas', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.query.id_sucursal);
    if (!idSucursal) {
      throw createCajaError(400, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'Debe indicar id_sucursal.');
    }
    const scopeContext = await getScopeContext(req, pool, idSucursal, true);
    assertSucursalAllowed(scopeContext, idSucursal);
    if (!(await requestIsSuperAdminReal(pool, req))) {
      throw createCajaError(403, 'VENTAS_CAJAS_ROLE_FORBIDDEN', 'Accion exclusiva para SUPER_ADMIN.');
    }
    const idEstadoAbierta = await getCatalogId(pool, 'SESSION_STATES', 'ABIERTA');
    const result = await pool.query(
      `
        SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.fecha_apertura,
               c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               ${USER_DISPLAY_SQL} AS responsable_nombre
        FROM public.cajas_sesiones cs
        INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
        INNER JOIN public.usuarios u ON u.id_usuario = cs.id_usuario_responsable
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        WHERE cs.id_sucursal = $1
          AND cs.id_estado_sesion_caja = $2
          AND COALESCE(c.estado, true) = true
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
      `,
      [idSucursal, idEstadoAbierta]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_OPEN_SESSIONS_LIST_ERROR', 'No se pudieron listar las sesiones abiertas.');
  }
});

router.get('/ventas/cajas/listado', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const isRestrictedCajero = await requestIsRestrictedCajero(req);
    const includeInactive = parseBooleanWithDefault(req.query.incluir_inactivas, false);
    const search = normalizeText(req.query.search, 100)?.toUpperCase() || '';

    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) {
      pushFilter('c.id_sucursal = $IDX', scopeContext.targetSucursalId);
    } else if (!scopeContext.isSuperAdmin) {
      pushFilter('c.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    }

    if (!includeInactive || isRestrictedCajero) {
      filters.push('COALESCE(c.estado, true) = true');
    }
    if (isRestrictedCajero) {
      pushFilter(
        `EXISTS (
          SELECT 1
          FROM public.cajas_usuarios_autorizados cua
          WHERE cua.id_caja = c.id_caja
            AND cua.id_usuario = $IDX
            AND COALESCE(cua.estado, true) = true
            AND (COALESCE(cua.puede_responsable, false) = true OR COALESCE(cua.puede_auxiliar, false) = true)
        )`,
        scopeContext.idUsuario
      );
    }
    if (search) {
      pushFilter(
        `(UPPER(COALESCE(c.codigo_caja, '')) LIKE '%' || $IDX || '%' OR UPPER(COALESCE(c.nombre_caja, '')) LIKE '%' || $IDX || '%')`,
        search
      );
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT c.id_caja, c.id_sucursal, c.codigo_caja, c.nombre_caja, c.observacion,
               COALESCE(c.permite_auxiliares, true) AS permite_auxiliares,
               COALESCE(c.estado, true) AS estado,
               c.fecha_actualizacion,
               s.nombre_sucursal,
               COALESCE(assign.asignaciones_activas, 0) AS asignaciones_activas,
               COALESCE(assign.responsables_activos, 0) AS responsables_activos,
               COALESCE(assign.auxiliares_activos, 0) AS auxiliares_activos
        FROM public.cajas c
        INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE COALESCE(cua.estado, true) = true) AS asignaciones_activas,
            COUNT(*) FILTER (
              WHERE COALESCE(cua.estado, true) = true
                AND COALESCE(cua.puede_responsable, false) = true
            ) AS responsables_activos,
            COUNT(*) FILTER (
              WHERE COALESCE(cua.estado, true) = true
                AND COALESCE(cua.puede_auxiliar, false) = true
            ) AS auxiliares_activos
          FROM public.cajas_usuarios_autorizados cua
          WHERE cua.id_caja = c.id_caja
        ) assign ON true
        ${whereClause}
        ORDER BY c.id_sucursal ASC, c.nombre_caja ASC, c.id_caja ASC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOG_LIST_ERROR', 'No se pudo listar el catalogo de cajas.');
  }
});

router.get('/ventas/cajas/listado/:id', checkPermission(['VENTAS_CAJAS_LISTADO_VER', 'VENTAS_CAJAS_DETALLE_VER']), async (req, res) => {
  try {
    const idCaja = parsePositiveInt(req.params.id);
    if (!idCaja) throw createCajaError(400, 'VENTAS_CAJAS_CAJA_ID_INVALID', 'El id de caja es invalido.');

    const scopeContext = await getScopeContext(req, pool, null, true);
    const caja = await pool.query(
      `
        SELECT c.id_caja, c.id_sucursal, c.codigo_caja, c.nombre_caja, c.observacion,
               COALESCE(c.permite_auxiliares, true) AS permite_auxiliares,
               COALESCE(c.estado, true) AS estado,
               c.fecha_actualizacion, s.nombre_sucursal
        FROM public.cajas c
        INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        WHERE c.id_caja = $1
        LIMIT 1
      `,
      [idCaja]
    );

    if (caja.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
    }

    const rowCaja = caja.rows[0];
    assertSucursalAllowed(scopeContext, rowCaja.id_sucursal);

    const asignaciones = await pool.query(
      `
        SELECT cua.id_caja_usuario_autorizado, cua.id_caja, cua.id_sucursal, cua.id_usuario,
               COALESCE(cua.puede_responsable, false) AS puede_responsable,
               COALESCE(cua.puede_auxiliar, false) AS puede_auxiliar,
               COALESCE(cua.estado, true) AS estado,
               cua.observacion, cua.fecha_creacion, cua.fecha_actualizacion,
               u.nombre_usuario,
               COALESCE(
                 NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
                 u.nombre_usuario
               ) AS nombre_completo
        FROM public.cajas_usuarios_autorizados cua
        INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        WHERE cua.id_caja = $1
        ORDER BY COALESCE(cua.estado, true) DESC, cua.fecha_actualizacion DESC, cua.id_caja_usuario_autorizado DESC
      `,
      [idCaja]
    );

    return res.status(200).json({ caja: rowCaja, asignaciones: asignaciones.rows });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOG_DETAIL_ERROR', 'No se pudo obtener el detalle de la caja.');
  }
});

router.post('/ventas/cajas/listado', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const requestedSucursalId = parseNullablePositiveInt(req.body.id_sucursal);
    const scopeContext = await getScopeContext(req, client, requestedSucursalId, true);
    const targetSucursalId = parsePositiveInt(scopeContext.targetSucursalId || requestedSucursalId);

    if (!targetSucursalId) {
      throw createCajaError(400, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'Debe indicar la sucursal para crear la caja.');
    }
    assertSucursalAllowed(scopeContext, targetSucursalId);

    const nombreCajaInput = normalizeText(req.body.nombre_caja, 120);
    const observacion = normalizeText(req.body.observacion, 300);
    const permiteAuxiliares = parseBooleanWithDefault(req.body.permite_auxiliares, true);
    const existingBoxesResult = await client.query(
      `
        SELECT codigo_caja
        FROM public.cajas
        WHERE id_sucursal = $1
        FOR UPDATE
      `,
      [targetSucursalId]
    );
    const existingCodes = new Set(
      (existingBoxesResult.rows || [])
        .map((row) => normalizeCajaCode(row?.codigo_caja, 40))
        .filter(Boolean)
    );
    let nextNumericCode = 1;
    existingCodes.forEach((code) => {
      const match = /^CAJA-(\d+)$/.exec(String(code || '').trim().toUpperCase());
      if (!match) return;
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed) && parsed >= nextNumericCode) {
        nextNumericCode = parsed + 1;
      }
    });
    let codigoCaja = `CAJA-${nextNumericCode}`;
    while (existingCodes.has(codigoCaja)) {
      nextNumericCode += 1;
      codigoCaja = `CAJA-${nextNumericCode}`;
    }
    const nombreCaja = normalizeText(nombreCajaInput, 120) || `Caja ${nextNumericCode}`;

    const insertCajaResult = await client.query(
      `
        INSERT INTO public.cajas (
          id_sucursal, id_usuario, codigo_caja, nombre_caja, observacion,
          permite_auxiliares, estado, fecha_actualizacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
        RETURNING id_caja
      `,
      [targetSucursalId, scopeContext.idUsuario, codigoCaja, nombreCaja, observacion, permiteAuxiliares]
    );
    const idCaja = Number(insertCajaResult.rows?.[0]?.id_caja || 0) || null;
    if (!idCaja) {
      throw createCajaError(500, 'VENTAS_CAJAS_INSERT_ID_ERROR', 'No se pudo determinar el identificador de la caja creada.');
    }

    const asignacionInicial = req.body.asignacion_inicial && typeof req.body.asignacion_inicial === 'object'
      ? req.body.asignacion_inicial
      : {};
    const idUsuarioAsignado = parseNullablePositiveInt(asignacionInicial.id_usuario);

    let idCajaUsuarioAutorizado = null;
    if (idUsuarioAsignado) {
      const user = await fetchAssignableCajaUserById(client, idUsuarioAsignado);
      if (!user) {
        throw createCajaError(
          404,
          'VENTAS_CAJAS_ASSIGN_USER_NOT_FOUND',
          'El usuario indicado debe ser un empleado activo.'
        );
      }
      if (Number.parseInt(String(user.id_sucursal || ''), 10) !== targetSucursalId) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
          'El usuario seleccionado no pertenece a la sucursal operativa de la caja.'
        );
      }

      const puedeResponsable = parseBooleanWithDefault(asignacionInicial.puede_responsable, true);
      const puedeAuxiliar = parseBooleanWithDefault(asignacionInicial.puede_auxiliar, true);
      if ((puedeResponsable && puedeAuxiliar) || (!puedeResponsable && !puedeAuxiliar)) {
        throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_ROLE_EXCLUSIVE', 'Debe seleccionar solo un rol operativo: responsable o auxiliar.');
      }
      const actorIsSuperAdmin = await requestIsSuperAdminReal(client, req);
      const userRoles = Array.isArray(user.roles_normalizados) ? user.roles_normalizados : [];
      if (puedeResponsable && !isCajaUserCajero(userRoles)) {
        throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
      }
      if (puedeAuxiliar && !actorIsSuperAdmin && isCajaUserAdminLike(userRoles)) {
        throw createCajaError(403, 'VENTAS_CAJAS_ASSIGN_ROLE_FORBIDDEN', 'Solo super_admin puede asignar usuarios administradores como auxiliares.');
      }

      idCajaUsuarioAutorizado = await upsertCajaAuthorization(client, {
        idCaja,
        idSucursal: targetSucursalId,
        idUsuario: idUsuarioAsignado,
        puedeResponsable,
        puedeAuxiliar,
        observacion: asignacionInicial.observacion
      });
    }

    const abrirSesionPayload = req.body.abrir_sesion && typeof req.body.abrir_sesion === 'object'
      ? req.body.abrir_sesion
      : null;
    const shouldOpenSession = parseBooleanWithDefault(
      abrirSesionPayload ? abrirSesionPayload.habilitar : req.body.abrir_sesion,
      false
    );

    let idSesionCaja = null;
    if (shouldOpenSession) {
      const responsableId =
        parseNullablePositiveInt(abrirSesionPayload?.id_usuario_responsable)
        || idUsuarioAsignado
        || scopeContext.idUsuario;
      const montoApertura = parseNonNegativeAmount(abrirSesionPayload?.monto_apertura ?? 0);
      const observacionApertura = normalizeText(abrirSesionPayload?.observacion_apertura, 500);
      if (montoApertura === null) {
        throw createCajaError(400, 'VENTAS_CAJAS_APERTURA_AMOUNT_INVALID', 'monto_apertura debe ser un numero mayor o igual a 0.');
      }

      const responsableUser = await fetchAssignableCajaUserById(client, responsableId);
      if (!responsableUser) {
        throw createCajaError(
          404,
          'VENTAS_CAJAS_RESPONSABLE_NOT_FOUND',
          'El responsable indicado debe ser un empleado activo.'
        );
      }
      if (Number.parseInt(String(responsableUser.id_sucursal || ''), 10) !== targetSucursalId) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
          'El responsable seleccionado no pertenece a la sucursal operativa de la caja.'
        );
      }
      if (!isCajaUserCajero(responsableUser.roles_normalizados)) {
        throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
      }

      await upsertCajaAuthorization(client, {
        idCaja,
        idSucursal: targetSucursalId,
        idUsuario: responsableId,
        puedeResponsable: true,
        puedeAuxiliar: false,
        observacion: 'Asignacion automatica para apertura inicial'
      });

      idSesionCaja = await createOpenSessionTransaction({
        client,
        req,
        scopeContext,
        idCaja,
        responsableId,
        montoApertura,
        observacionApertura,
        modoApertura: 'NORMAL'
      });
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: shouldOpenSession
        ? 'Caja creada, asignada y sesion abierta correctamente.'
        : 'Caja creada correctamente.',
      id_caja: idCaja,
      codigo_caja: codigoCaja,
      nombre_caja: nombreCaja,
      id_caja_usuario_autorizado: idCajaUsuarioAutorizado,
      id_sesion_caja: idSesionCaja
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 500) {
      return res.status(err.httpStatus).json({
        error: true,
        code: err.code || 'VENTAS_CAJAS_CATALOG_CREATE_ERROR',
        message: err.publicMessage || 'No se pudo crear la caja.'
      });
    }
    console.error('[cajas] create listado error:', err);
    return res.status(500).json({
      error: true,
      code: 'VENTAS_CAJAS_CATALOG_CREATE_ERROR',
      message: 'No se pudo crear la caja.'
    });
  } finally {
    client.release();
  }
});

router.patch('/ventas/cajas/listado/:id', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idCaja = parsePositiveInt(req.params.id);
    if (!idCaja) throw createCajaError(400, 'VENTAS_CAJAS_CAJA_ID_INVALID', 'El id de caja es invalido.');

    const cajaResult = await client.query(
      `
        SELECT id_caja, id_sucursal, codigo_caja, nombre_caja, observacion,
               COALESCE(estado, true) AS estado,
               COALESCE(permite_auxiliares, true) AS permite_auxiliares
        FROM public.cajas
        WHERE id_caja = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idCaja]
    );
    if (cajaResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
    }

    const currentCaja = cajaResult.rows[0];
    const requestedSucursalId = parseNullablePositiveInt(req.body.id_sucursal) || currentCaja.id_sucursal;
    const scopeContext = await getScopeContext(req, client, requestedSucursalId, true);
    assertSucursalAllowed(scopeContext, requestedSucursalId);

    const hasNombre = Object.prototype.hasOwnProperty.call(req.body, 'nombre_caja');
    const hasCodigo = Object.prototype.hasOwnProperty.call(req.body, 'codigo_caja');
    const hasEstado = Object.prototype.hasOwnProperty.call(req.body, 'estado');
    const hasObservacion = Object.prototype.hasOwnProperty.call(req.body, 'observacion');
    const hasPermiteAuxiliares = Object.prototype.hasOwnProperty.call(req.body, 'permite_auxiliares');
    const hasSucursal = Object.prototype.hasOwnProperty.call(req.body, 'id_sucursal');

    if (!hasNombre && !hasCodigo && !hasEstado && !hasObservacion && !hasPermiteAuxiliares && !hasSucursal) {
      throw createCajaError(400, 'VENTAS_CAJAS_UPDATE_EMPTY', 'Debe enviar al menos un campo para actualizar.');
    }

    const nombreCaja = hasNombre ? normalizeText(req.body.nombre_caja, 120) : currentCaja.nombre_caja;
    const codigoCaja = hasCodigo ? normalizeCajaCode(req.body.codigo_caja, 40) : currentCaja.codigo_caja;
    const observacion = hasObservacion ? normalizeText(req.body.observacion, 300) : currentCaja.observacion;
    const estado = hasEstado ? parseBooleanWithDefault(req.body.estado, true) : parseBooleanWithDefault(currentCaja.estado, true);
    const permiteAuxiliares = hasPermiteAuxiliares
      ? parseBooleanWithDefault(req.body.permite_auxiliares, true)
      : parseBooleanWithDefault(currentCaja.permite_auxiliares, true);

    if (!nombreCaja) {
      throw createCajaError(400, 'VENTAS_CAJAS_NAME_REQUIRED', 'Debe indicar el nombre de la caja.');
    }

    if (codigoCaja) {
      const duplicateCode = await client.query(
        `
          SELECT id_caja
          FROM public.cajas
          WHERE id_sucursal = $1
            AND UPPER(TRIM(COALESCE(codigo_caja, ''))) = $2
            AND id_caja <> $3
          LIMIT 1
          FOR UPDATE
        `,
        [requestedSucursalId, codigoCaja, idCaja]
      );
      if (duplicateCode.rowCount > 0) {
        throw createCajaError(409, 'VENTAS_CAJAS_CODE_DUPLICATE', 'Ya existe una caja con ese codigo en la sucursal seleccionada.');
      }
    }

    await client.query(
      `
        UPDATE public.cajas
        SET id_sucursal = $1,
            codigo_caja = $2,
            nombre_caja = $3,
            observacion = $4,
            estado = $5,
            permite_auxiliares = $6,
            fecha_actualizacion = NOW()
        WHERE id_caja = $7
      `,
      [requestedSucursalId, codigoCaja, nombreCaja, observacion, estado, permiteAuxiliares, idCaja]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Caja actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOG_UPDATE_ERROR', 'No se pudo actualizar la caja.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/asignaciones', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    const includeInactive = parseBooleanWithDefault(req.query.incluir_inactivas, false);
    const includeInactiveCajas = parseBooleanWithDefault(req.query.incluir_cajas_inactivas, false);
    const requestedUserId = parseNullablePositiveInt(req.query.id_usuario);
    const hasListPermission = await requestHasAnyPermission(req, ['VENTAS_CAJAS_LISTADO_VER', 'VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']);

    if (idCaja) {
      const caja = await fetchCajaById(pool, idCaja);
      if (!caja) throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
      assertSucursalAllowed(scopeContext, caja.id_sucursal);
    }

    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) {
      pushFilter('cua.id_sucursal = $IDX', scopeContext.targetSucursalId);
    } else if (!scopeContext.isSuperAdmin) {
      pushFilter('cua.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    }
    if (!includeInactive) {
      filters.push('COALESCE(cua.estado, true) = true');
    }
    if (!includeInactiveCajas) {
      filters.push('COALESCE(c.estado, true) = true');
    }
    if (idCaja) {
      pushFilter('cua.id_caja = $IDX', idCaja);
    }

    if (!hasListPermission) {
      // Si no es admin/superadmin, forzar a ver solo sus propias asignaciones
      pushFilter('cua.id_usuario = $IDX', scopeContext.idUsuario);
    } else if (requestedUserId) {
      pushFilter('cua.id_usuario = $IDX', requestedUserId);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT cua.id_caja_usuario_autorizado, cua.id_caja, cua.id_sucursal, cua.id_usuario,
               COALESCE(cua.puede_responsable, false) AS puede_responsable,
               COALESCE(cua.puede_auxiliar, false) AS puede_auxiliar,
               COALESCE(cua.estado, true) AS estado,
               cua.observacion, cua.fecha_creacion, cua.fecha_actualizacion,
               c.codigo_caja, c.nombre_caja,
               s.nombre_sucursal,
               u.nombre_usuario,
               COALESCE(
                 NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
                 u.nombre_usuario
               ) AS nombre_completo
        FROM public.cajas_usuarios_autorizados cua
        INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cua.id_sucursal
        INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        ${whereClause}
        ORDER BY COALESCE(cua.estado, true) DESC, c.nombre_caja ASC, nombre_completo ASC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_ASSIGNMENTS_LIST_ERROR', 'No se pudieron listar las asignaciones de cajas.');
  }
});

router.post('/ventas/cajas/asignaciones', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idCaja = parsePositiveInt(req.body.id_caja);
    const idUsuario = parsePositiveInt(req.body.id_usuario);
    const puedeResponsable = parseBooleanWithDefault(req.body.puede_responsable, true);
    const puedeAuxiliar = parseBooleanWithDefault(req.body.puede_auxiliar, true);
    if (!idCaja || !idUsuario) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_DATA_INVALID', 'Debe indicar una caja y un usuario validos.');
    }
    if ((puedeResponsable && puedeAuxiliar) || (!puedeResponsable && !puedeAuxiliar)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_ROLE_EXCLUSIVE', 'Debe seleccionar solo un rol operativo: responsable o auxiliar.');
    }

    const caja = await fetchCajaById(client, idCaja);
    if (!caja) throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');

    const scopeContext = await getScopeContext(req, client, caja.id_sucursal, true);
    assertSucursalAllowed(scopeContext, caja.id_sucursal);

    const user = await fetchAssignableCajaUserById(client, idUsuario);
    if (!user) {
      throw createCajaError(
        404,
        'VENTAS_CAJAS_ASSIGN_USER_NOT_FOUND',
        'El usuario indicado debe ser un empleado activo.'
      );
    }
    const actorIsSuperAdmin = await requestIsSuperAdminReal(client, req);
    const userRoles = Array.isArray(user.roles_normalizados) ? user.roles_normalizados : [];
    const userIsSuperOrAdmin = isCajaUserAdminLike(userRoles);
    if (puedeResponsable && !isCajaUserCajero(userRoles)) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
    }
    if (puedeAuxiliar && !actorIsSuperAdmin && userIsSuperOrAdmin) {
      throw createCajaError(403, 'VENTAS_CAJAS_ASSIGN_ROLE_FORBIDDEN', 'Solo super_admin puede asignar usuarios administradores como auxiliares.');
    }
    if (Number.parseInt(String(user.id_sucursal || ''), 10) !== Number(caja.id_sucursal)) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
        'El usuario seleccionado no pertenece a la sucursal operativa de la caja.'
      );
    }

    await ensureActiveAssignmentBusinessRules(client, {
      idCaja,
      idUsuario,
      idSucursal: caja.id_sucursal,
      puedeResponsable,
      targetRoleCodes: userRoles,
      actorIsSuperAdmin,
      estado: true,
      excludeAssignmentId: null
    });

    const idCajaUsuarioAutorizado = await upsertCajaAuthorization(client, {
      idCaja,
      idSucursal: caja.id_sucursal,
      idUsuario,
      puedeResponsable,
      puedeAuxiliar,
      observacion: req.body.observacion
    });

    if (puedeAuxiliar) {
      const openSession = await fetchOpenSessionForCaja(client, idCaja, { forUpdate: true });
      if (openSession?.id_sesion_caja) {
        await insertSessionParticipant({
          client,
          idSesionCaja: openSession.id_sesion_caja,
          idUsuario,
          roleCode: 'AUXILIAR',
          observacion: 'Auxiliar incorporado durante sesion abierta'
        });
      }
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Asignacion de caja registrada correctamente.',
      id_caja_usuario_autorizado: idCajaUsuarioAutorizado
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, mapCajaAssignmentPgError(err), 'VENTAS_CAJAS_ASSIGN_CREATE_ERROR', 'No se pudo registrar la asignacion de caja.');
  } finally {
    client.release();
  }
});

router.patch('/ventas/cajas/asignaciones/:id', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idAsignacion = parsePositiveInt(req.params.id);
    if (!idAsignacion) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGNMENT_ID_INVALID', 'El id de asignacion es invalido.');
    }

    const assignmentResult = await client.query(
      `
        SELECT id_caja_usuario_autorizado, id_caja, id_sucursal, id_usuario,
               COALESCE(puede_responsable, false) AS puede_responsable,
               COALESCE(puede_auxiliar, false) AS puede_auxiliar,
               COALESCE(estado, true) AS estado,
               observacion
        FROM public.cajas_usuarios_autorizados
        WHERE id_caja_usuario_autorizado = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idAsignacion]
    );
    if (assignmentResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_ASSIGNMENT_NOT_FOUND', 'La asignacion indicada no existe.');
    }

    const assignment = assignmentResult.rows[0];
    const scopeContext = await getScopeContext(req, client, assignment.id_sucursal, true);
    assertSucursalAllowed(scopeContext, assignment.id_sucursal);

    const hasIdUsuario = Object.prototype.hasOwnProperty.call(req.body, 'id_usuario');
    const hasPuedeResponsable = Object.prototype.hasOwnProperty.call(req.body, 'puede_responsable');
    const hasPuedeAuxiliar = Object.prototype.hasOwnProperty.call(req.body, 'puede_auxiliar');
    const hasEstado = Object.prototype.hasOwnProperty.call(req.body, 'estado');
    const hasObservacion = Object.prototype.hasOwnProperty.call(req.body, 'observacion');

    if (!hasIdUsuario && !hasPuedeResponsable && !hasPuedeAuxiliar && !hasEstado && !hasObservacion) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGNMENT_UPDATE_EMPTY', 'Debe enviar al menos un campo para actualizar.');
    }

    const openSession = await fetchOpenSessionForCaja(client, assignment.id_caja, { forUpdate: true });
    if (openSession?.id_sesion_caja && (hasIdUsuario || hasPuedeResponsable || hasPuedeAuxiliar || hasEstado)) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_ASSIGNMENT_OPEN_SESSION_LOCKED',
        'La caja tiene una sesion abierta. Solo se permite editar la observacion de la asignacion.'
      );
    }

    const nextUsuarioId = hasIdUsuario
      ? parsePositiveInt(req.body.id_usuario)
      : parsePositiveInt(assignment.id_usuario);
    if (!nextUsuarioId) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGNMENT_USER_REQUIRED', 'Debe indicar un usuario valido para la asignacion.');
    }

    const puedeResponsable = hasPuedeResponsable
      ? parseBooleanWithDefault(req.body.puede_responsable, false)
      : parseBooleanWithDefault(assignment.puede_responsable, false);
    const puedeAuxiliar = hasPuedeAuxiliar
      ? parseBooleanWithDefault(req.body.puede_auxiliar, false)
      : parseBooleanWithDefault(assignment.puede_auxiliar, false);
    const estado = hasEstado
      ? parseBooleanWithDefault(req.body.estado, true)
      : parseBooleanWithDefault(assignment.estado, true);
    const observacion = hasObservacion ? normalizeText(req.body.observacion, 300) : assignment.observacion;

    if (estado && ((puedeResponsable && puedeAuxiliar) || (!puedeResponsable && !puedeAuxiliar))) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_ROLE_EXCLUSIVE', 'Debe seleccionar solo un rol operativo: responsable o auxiliar.');
    }
    const assignmentUser = await fetchAssignableCajaUserById(client, nextUsuarioId);
    if (!assignmentUser) {
      throw createCajaError(404, 'VENTAS_CAJAS_ASSIGN_USER_NOT_FOUND', 'El usuario indicado debe ser un empleado activo.');
    }
    if (Number.parseInt(String(assignmentUser.id_sucursal || ''), 10) !== Number(assignment.id_sucursal)) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
        'El usuario seleccionado no pertenece a la sucursal operativa de la caja.'
      );
    }
    const actorIsSuperAdmin = await requestIsSuperAdminReal(client, req);
    const assignmentUserRoles = Array.isArray(assignmentUser?.roles_normalizados) ? assignmentUser.roles_normalizados : [];
    const assignmentIsSuperOrAdmin = isCajaUserAdminLike(assignmentUserRoles);
    if (estado && puedeResponsable && !isCajaUserCajero(assignmentUserRoles)) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
    }
    if (estado && puedeAuxiliar && !actorIsSuperAdmin && assignmentIsSuperOrAdmin) {
      throw createCajaError(403, 'VENTAS_CAJAS_ASSIGN_ROLE_FORBIDDEN', 'Solo super_admin puede asignar usuarios administradores como auxiliares.');
    }

    await ensureActiveAssignmentBusinessRules(client, {
      idCaja: assignment.id_caja,
      idUsuario: nextUsuarioId,
      idSucursal: assignment.id_sucursal,
      puedeResponsable,
      targetRoleCodes: assignmentUserRoles,
      actorIsSuperAdmin,
      estado,
      excludeAssignmentId: idAsignacion
    });

    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET id_usuario = $1,
            puede_responsable = $2,
            puede_auxiliar = $3,
            estado = $4,
            observacion = $5,
            fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $6
      `,
      [nextUsuarioId, puedeResponsable, puedeAuxiliar, estado, observacion, idAsignacion]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Asignacion de caja actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, mapCajaAssignmentPgError(err), 'VENTAS_CAJAS_ASSIGN_UPDATE_ERROR', 'No se pudo actualizar la asignacion de caja.');
  } finally {
    client.release();
  }
});

const deactivateAsignacionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idAsignacion = parsePositiveInt(req.params.id);
    if (!idAsignacion) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGNMENT_ID_INVALID', 'El id de asignacion es invalido.');
    }

    const assignmentResult = await client.query(
      `
        SELECT id_caja_usuario_autorizado, id_caja, id_sucursal, COALESCE(estado, true) AS estado, observacion
        FROM public.cajas_usuarios_autorizados
        WHERE id_caja_usuario_autorizado = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idAsignacion]
    );
    if (assignmentResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_ASSIGNMENT_NOT_FOUND', 'La asignacion indicada no existe.');
    }

    const assignment = assignmentResult.rows[0];
    const scopeContext = await getScopeContext(req, client, assignment.id_sucursal, true);
    assertSucursalAllowed(scopeContext, assignment.id_sucursal);

    if (!parseBooleanish(assignment.estado)) {
      throw createCajaError(409, 'VENTAS_CAJAS_ASSIGNMENT_ALREADY_INACTIVE', 'La asignacion ya se encuentra inactiva.');
    }

    const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
    if (idEstadoAbierta) {
      const openSessionResult = await client.query(
        `
          SELECT id_sesion_caja
          FROM public.cajas_sesiones
          WHERE id_caja = $1
            AND id_estado_sesion_caja = $2
          LIMIT 1
        `,
        [assignment.id_caja, idEstadoAbierta]
      );
      if (openSessionResult.rowCount > 0) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_ASSIGNMENT_OPEN_SESSION_LOCKED',
          'La caja tiene una sesion abierta. Solo se permite editar la observacion de la asignacion.'
        );
      }
    }

    const nextObservation = normalizeText(
      assignment.observacion
        ? `${assignment.observacion}. Asignacion desactivada manualmente.`
        : 'Asignacion desactivada manualmente.',
      300
    );

    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET estado = false, observacion = $2, fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $1
      `,
      [idAsignacion, nextObservation]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Asignacion de caja inactivada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_ASSIGN_INACTIVATE_ERROR', 'No se pudo inactivar la asignacion de caja.');
  } finally {
    client.release();
  }
};

router.patch('/ventas/cajas/asignaciones/:id/inactivar', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), deactivateAsignacionHandler);
router.patch('/ventas/cajas/asignaciones/:id/desactivar', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), deactivateAsignacionHandler);

router.get('/ventas/cajas/sesiones', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const isRestrictedCajero = await isCashierOnlyRequest(req);
    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) pushFilter('cs.id_sucursal = $IDX', scopeContext.targetSucursalId);
    else if (!scopeContext.isSuperAdmin) pushFilter('cs.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    if (isRestrictedCajero) {
      pushFilter(
        `EXISTS (
          SELECT 1
          FROM public.cajas_usuarios_autorizados cua
          WHERE cua.id_caja = cs.id_caja
            AND cua.id_usuario = $IDX
            AND COALESCE(cua.estado, true) = true
            AND (COALESCE(cua.puede_responsable, false) = true OR COALESCE(cua.puede_auxiliar, false) = true)
        )`,
        scopeContext.idUsuario
      );
    }

    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    const idResponsable = parseNullablePositiveInt(req.query.id_usuario_responsable);
    const idEstadoSesion = parseNullablePositiveInt(req.query.id_estado_sesion_caja);
    const fechaDesde = normalizeText(req.query.fecha_desde, 20);
    const fechaHasta = normalizeText(req.query.fecha_hasta, 20);

    if (idCaja) pushFilter('cs.id_caja = $IDX', idCaja);
    if (idResponsable) pushFilter('cs.id_usuario_responsable = $IDX', idResponsable);
    if (idEstadoSesion) pushFilter('cs.id_estado_sesion_caja = $IDX', idEstadoSesion);
    if (fechaDesde) pushFilter('cs.fecha_apertura::date >= $IDX::date', fechaDesde);
    if (fechaHasta) pushFilter('COALESCE(cs.fecha_cierre, NOW())::date <= $IDX::date', fechaHasta);

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.id_usuario_responsable, cs.id_estado_sesion_caja,
               cs.fecha_apertura, cs.fecha_cierre, cs.monto_apertura,
               resumen.ventas_efectivo, resumen.ventas_no_efectivo, resumen.ingresos_manuales,
               resumen.egresos_manuales, resumen.efectivo_teorico, resumen.monto_declarado_cierre,
               resumen.diferencia_cierre, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               estado.codigo AS estado_codigo, estado.nombre AS estado_nombre,
               u.nombre_usuario AS responsable_usuario, ${USER_DISPLAY_SQL} AS responsable_nombre
        FROM public.cajas_sesiones cs
        INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
        INNER JOIN public.cat_cajas_sesiones_estados estado ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
        INNER JOIN public.usuarios u ON u.id_usuario = cs.id_usuario_responsable
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        LEFT JOIN public.vw_cajas_sesiones_resumen resumen ON resumen.id_sesion_caja = cs.id_sesion_caja
        ${whereClause}
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
      `,
      params
    );

    const rows = isRestrictedCajero
      ? result.rows.map(maskCajaSessionRowForCajero)
      : result.rows;
    return res.status(200).json(rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_SESIONES_LIST_ERROR', 'No se pudieron listar las sesiones de caja.');
  }
});

const sessionDetailHandler = async (req, res, defaultCode, defaultMessage) => {
  const client = await pool.connect();
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await fetchSessionBase(client, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const isRestrictedCajero = await isCashierOnlyRequest(req);
    const isOpenSession = String(session.estado_codigo || '').trim().toUpperCase() === 'ABIERTA';
    const allowOperationalPayload = isOperationalCajaDetailContext(req.query?.contexto || req.query?.context);
    if (isRestrictedCajero && isOpenSession && !allowOperationalPayload) {
      throw createCajaError(
        403,
        'VENTAS_CAJAS_DETALLE_ABIERTO_NO_PERMITIDO',
        'El detalle operativo de una sesión abierta solo está disponible para administradores.'
      );
    }
    const payload = await buildSessionDetailPayload(client, session);
    return res.status(200).json(
      isRestrictedCajero ? maskCajaDetailPayloadForCajero(payload) : payload
    );
  } catch (err) {
    return sendInternalError(res, err, defaultCode, defaultMessage);
  } finally {
    client.release();
  }
};

router.get('/ventas/cajas/sesiones/:id', checkPermission(['VENTAS_CAJAS_DETALLE_VER']), async (req, res) =>
  sessionDetailHandler(req, res, 'VENTAS_CAJAS_SESION_DETAIL_ERROR', 'No se pudo obtener el detalle de la sesion de caja.')
);

router.get('/ventas/cajas/sesiones/:id/reporte', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) =>
  sessionDetailHandler(req, res, 'VENTAS_CAJAS_REPORTE_ERROR', 'No se pudo obtener el reporte de la sesion de caja.')
);

const createOpenSessionTransaction = async ({
  client,
  req,
  scopeContext,
  idCaja,
  responsableId,
  montoApertura,
  observacionApertura,
  modoApertura = 'NORMAL'
}) => {
  const caja = await fetchCajaById(client, idCaja);
  if (!caja || !parseBooleanish(caja.estado)) {
    throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
  }

  await assertCanOpenCajaSession({ client, req, scopeContext, caja, modoApertura });
  const isContingencyOpen = modoApertura === 'CONTINGENCIA_SUPER_ADMIN';
  if (!isContingencyOpen) {
    await assertCajaAuthorization(client, idCaja, responsableId, 'RESPONSABLE');
  }

  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  const openSessionResult = await client.query(
    `SELECT id_sesion_caja FROM public.cajas_sesiones WHERE id_caja = $1 AND id_estado_sesion_caja = $2 LIMIT 1 FOR UPDATE`,
    [idCaja, idEstadoAbierta]
  );
  if (openSessionResult.rowCount > 0) {
    throw createCajaError(409, 'VENTAS_CAJAS_SESSION_ALREADY_OPEN', 'La caja ya tiene una sesión abierta.');
  }

  const responsibleOpenSessionResult = await client.query(
    `SELECT cs.id_sesion_caja FROM public.cajas_sesiones cs WHERE cs.id_usuario_responsable = $1 AND cs.id_estado_sesion_caja = $2 LIMIT 1`,
    [responsableId, idEstadoAbierta]
  );
  if (responsibleOpenSessionResult.rowCount > 0) {
    throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_BUSY', 'El responsable ya tiene una sesión de caja abierta.');
  }

  const idRolResponsable = await getCatalogId(client, 'PARTICIPATION_ROLES', 'RESPONSABLE');
  const idTipoApertura = await getCatalogId(client, 'MOVEMENT_TYPES', 'APERTURA');

  const sessionInsert = await client.query(
    `
      INSERT INTO public.cajas_sesiones (
        id_caja, id_sucursal, id_usuario_responsable, id_estado_sesion_caja, id_usuario_apertura,
        fecha_apertura, monto_apertura, observacion_apertura, fecha_creacion, fecha_actualizacion
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, NOW(), NOW())
      RETURNING id_sesion_caja
    `,
    [idCaja, caja.id_sucursal, responsableId, idEstadoAbierta, scopeContext.idUsuario, montoApertura, observacionApertura]
  );
  const idSesionCaja = Number(sessionInsert.rows?.[0]?.id_sesion_caja || 0) || null;
  if (!idSesionCaja) {
    throw createCajaError(500, 'VENTAS_CAJAS_SESSION_ID_ERROR', 'No se pudo determinar el identificador de la sesión abierta.');
  }

  await client.query(
    `
      INSERT INTO public.cajas_sesiones_participantes (
        id_sesion_caja, id_usuario, id_rol_participacion_caja, fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
      )
      VALUES ($1, $2, $3, NOW(), true, $4, NOW(), NOW())
      ON CONFLICT (id_sesion_caja, id_usuario) WHERE activo IS TRUE
      DO NOTHING
    `,
    [
      idSesionCaja,
      responsableId,
      idRolResponsable,
      isContingencyOpen
        ? 'Responsable operativo por contingencia super_admin'
        : 'Responsable de apertura'
    ]
  );

  await insertAssignedAuxiliariesIntoSession({
    client,
    idSesionCaja,
    idCaja,
    excludeUserIds: [responsableId],
    observacion: 'Auxiliar activo asignado al abrir sesion'
  });

  if (montoApertura > 0 && idTipoApertura) {
    await client.query(
      `
        INSERT INTO public.cajas_movimientos (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_movimiento_caja, id_usuario_ejecutor,
          monto, observacion, fecha_movimiento, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      `,
      [idSesionCaja, idCaja, caja.id_sucursal, idTipoApertura, scopeContext.idUsuario, montoApertura, observacionApertura || 'Apertura de sesión de caja']
    );
  }

  return idSesionCaja;
};

const openSessionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idCaja = parsePositiveInt(req.body.id_caja);
    const requestedSucursalId = parseNullablePositiveInt(req.body.id_sucursal);
    const montoApertura = parseNonNegativeAmount(req.body.monto_apertura ?? 0);
    const modoApertura = normalizeCajaCode(req.body.modo_apertura, 80) || 'NORMAL';
    const motivoContingencia = normalizeText(req.body.motivo_contingencia, 500);
    const observacionAperturaBase = normalizeText(req.body.observacion_apertura, 500);
    if (!['NORMAL', 'CONTINGENCIA_SUPER_ADMIN'].includes(modoApertura)) {
      throw createCajaError(400, 'VENTAS_CAJAS_OPEN_MODE_INVALID', 'El modo de apertura indicado no es valido.');
    }
    if (modoApertura === 'CONTINGENCIA_SUPER_ADMIN' && !motivoContingencia) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_CONTINGENCY_REASON_REQUIRED',
        'Debe indicar el motivo de la apertura por contingencia.'
      );
    }
    const observacionApertura = modoApertura === 'CONTINGENCIA_SUPER_ADMIN'
      ? normalizeText(`Apertura por contingencia super_admin: ${motivoContingencia}`, 500)
      : observacionAperturaBase;
    const requestedResponsableId = parseNullablePositiveInt(req.body.id_usuario_responsable);
    if (!idCaja) throw createCajaError(400, 'VENTAS_CAJAS_CAJA_REQUIRED', 'Debe indicar una caja valida.');
    if (montoApertura === null) throw createCajaError(400, 'VENTAS_CAJAS_APERTURA_AMOUNT_INVALID', 'monto_apertura debe ser un numero mayor o igual a 0.');

    const scopeContext = await getScopeContext(req, client, requestedSucursalId, true);
    if (await requestIsRestrictedCajero(req)) {
      throw createCajaError(
        403,
        'CAJA_FLUJO_ASIGNACION_DIRECTA_REQUERIDO',
        'Los usuarios cajeros deben abrir únicamente su caja asignada desde el flujo personal de caja.'
      );
    }

    let responsableId = modoApertura === 'CONTINGENCIA_SUPER_ADMIN'
      ? scopeContext.idUsuario
      : (requestedResponsableId || scopeContext.idUsuario);
    const caja = await fetchCajaById(client, idCaja);
    if (!caja) {
      throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
    }
    if (modoApertura !== 'CONTINGENCIA_SUPER_ADMIN' && !requestedResponsableId) {
      const selfAuthorization = await fetchCajaAuthorization(client, idCaja, scopeContext.idUsuario);
      if (!parseBooleanish(selfAuthorization?.puede_responsable)) {
        const fallbackResponsable = await fetchCajaDefaultResponsible(client, idCaja, caja.id_sucursal);
        if (!fallbackResponsable) {
          throw createCajaError(
            409,
            'VENTAS_CAJAS_RESPONSABLE_REQUIRED',
            'La caja no tiene un responsable autorizado activo. Asigna un responsable antes de abrir sesión.'
          );
        }
        responsableId = fallbackResponsable;
      }
    }
    const idSesionCaja = await createOpenSessionTransaction({
      client,
      req,
      scopeContext,
      idCaja,
      responsableId,
      montoApertura,
      observacionApertura,
      modoApertura
    });

    await client.query('COMMIT');

    try {
      await sendCajaAperturaEmail(idSesionCaja);
    } catch (emailError) {
      console.error('[cajas] Error enviando correo de apertura:', emailError.message);
    }

    return res.status(201).json({
      message: 'Sesión de caja iniciada correctamente.',
      id_sesion_caja: idSesionCaja,
      modo_apertura: modoApertura,
      apertura_contingencia: modoApertura === 'CONTINGENCIA_SUPER_ADMIN'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_OPEN_ERROR', 'No se pudo abrir la sesión de caja.');
  } finally {
    client.release();
  }
};

const openMyAssignedSessionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'id_caja')) {
      throw createCajaError(
        400,
        'CAJA_ID_CAJA_NO_PERMITIDA',
        'No envies id_caja para abrir tu caja asignada.'
      );
    }

    const montoApertura = parseNonNegativeAmount(body.monto_apertura);
    const observacionApertura = normalizeText(body.observacion_apertura, 500);
    if (montoApertura === null) {
      throw createCajaError(400, 'VENTAS_CAJAS_APERTURA_AMOUNT_INVALID', 'monto_apertura debe ser un número mayor o igual a 0.');
    }

    const scopeContext = await getScopeContext(req, client, null, true);
    const assignment = await fetchMiCajaAsignadaActiva(client, scopeContext, { forUpdate: true });
    if (!assignment) {
      throw createCajaError(
        404,
        'CAJA_ASIGNACION_NO_ENCONTRADA',
        'No tienes una caja asignada activa.'
      );
    }

    if (assignment.id_sesion_caja) {
      const session = await fetchSessionBase(client, assignment.id_sesion_caja, { forUpdate: true });
      await client.query('COMMIT');
      return res.status(200).json({
        code: 'CAJA_SESION_USUARIO_YA_ABIERTA',
        message: 'Ya participas en una sesión de caja abierta.',
        ...buildCajaSessionPayload(session, assignment)
      });
    }

    if (assignment.id_sesion_caja_abierta) {
      await client.query('COMMIT');
      return res.status(409).json({
        error: true,
        code: 'CAJA_SESION_ABIERTA_POR_OTRO_RESPONSABLE',
        message: 'La caja asignada ya tiene una sesión abierta por otro responsable y tu usuario no participa en ella.',
        sesion_abierta: buildCajaSessionPayload(
          {
            id_sesion_caja: assignment.id_sesion_caja_abierta,
            id_caja: assignment.id_caja,
            codigo_caja: assignment.codigo_caja,
            nombre_caja: assignment.nombre_caja,
            id_sucursal: assignment.id_sucursal,
            nombre_sucursal: assignment.nombre_sucursal,
            monto_apertura: assignment.monto_apertura_abierta,
            fecha_apertura: assignment.fecha_apertura_abierta
          }
        ),
        id_usuario_responsable: Number(assignment.id_usuario_responsable_abierta)
      });
    }

    if (!parseBooleanish(assignment.puede_responsable)) {
      throw createCajaError(
        403,
        'CAJA_ASIGNACION_RESPONSABLE_REQUERIDA',
        'Tu asignación activa no permite abrir esta caja como responsable.'
      );
    }

    const userOpenSession = await fetchUsuarioSesionAbierta(client, scopeContext.idUsuario, { forUpdate: true });
    if (userOpenSession) {
      const session = await fetchSessionBase(client, userOpenSession.id_sesion_caja, { forUpdate: true });
      await client.query('COMMIT');
      return res.status(409).json({
        error: true,
        code: 'CAJA_SESION_USUARIO_YA_ABIERTA',
        message: 'Ya participas en una sesión de caja abierta.',
        sesion_abierta: buildCajaSessionPayload(session, userOpenSession)
      });
    }

    const idSesionCaja = await createOpenSessionTransaction({
      client,
      req,
      scopeContext,
      idCaja: assignment.id_caja,
      responsableId: scopeContext.idUsuario,
      montoApertura,
      observacionApertura,
      modoApertura: 'NORMAL'
    });
    const session = await fetchSessionBase(client, idSesionCaja);

    await client.query('COMMIT');

    try {
      await sendCajaAperturaEmail(idSesionCaja);
    } catch (emailError) {
      console.error('[cajas] Error enviando correo de apertura:', emailError.message);
    }

    return res.status(201).json({
      message: 'Sesión de caja iniciada correctamente.',
      ...buildCajaSessionPayload(session, {
        id_sesion_caja: idSesionCaja,
        id_caja: assignment.id_caja,
        codigo_caja: assignment.codigo_caja,
        nombre_caja: assignment.nombre_caja,
        id_sucursal: assignment.id_sucursal,
        nombre_sucursal: assignment.nombre_sucursal,
        monto_apertura: montoApertura
      })
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_MY_OPEN_ERROR', 'No se pudo abrir tu caja asignada.');
  } finally {
    client.release();
  }
};

router.post('/ventas/cajas/mi-sesion/abrir', checkPermission(['VENTAS_CAJAS_SESION_ABRIR']), openMyAssignedSessionHandler);
router.post('/ventas/cajas/sesiones', checkPermission(['VENTAS_CAJAS_SESION_ABRIR']), openSessionHandler);
router.post('/ventas/cajas/sesiones/abrir', checkPermission(['VENTAS_CAJAS_SESION_ABRIR']), openSessionHandler);

router.post('/ventas/cajas/mi-sesion/egresos', checkPermission(['VENTAS_CAJAS_MOVIMIENTO_MANUAL_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scopeContext = await getScopeContext(req, client, null, true);
    const userOpenSession = await fetchUsuarioSesionAbierta(client, scopeContext.idUsuario, { forUpdate: true });
    if (!userOpenSession?.id_sesion_caja) {
      throw createCajaError(404, 'VENTAS_CAJAS_SESION_ACTIVA_NO_ENCONTRADA', 'No tienes una sesion de caja abierta.');
    }
    const session = await ensureOpenSession(client, userOpenSession.id_sesion_caja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, session.id_sesion_caja, scopeContext.idUsuario, { req, scopeContext });

    const movimiento = await insertCajaEgresoMovimiento({
      client,
      session,
      idUsuarioEjecutor: scopeContext.idUsuario,
      monto: req.body.monto,
      observacion: req.body.observacion,
      referencia: req.body.referencia,
      idTipoMovimientoCaja: req.body.id_tipo_movimiento_caja
    });

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Egreso de caja registrado correctamente.',
      ...movimiento
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_EGRESO_CREATE_ERROR', 'No se pudo registrar el egreso de caja.');
  } finally {
    client.release();
  }
});

router.post('/ventas/cajas/mi-sesion/ingresos', checkPermission(['VENTAS_CAJAS_MOVIMIENTO_MANUAL_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scopeContext = await getScopeContext(req, client, null, true);
    const userOpenSession = await fetchUsuarioSesionAbierta(client, scopeContext.idUsuario, { forUpdate: true });
    if (!userOpenSession?.id_sesion_caja) {
      throw createCajaError(404, 'VENTAS_CAJAS_SESION_ACTIVA_NO_ENCONTRADA', 'No tienes una sesion de caja abierta.');
    }
    const session = await ensureOpenSession(client, userOpenSession.id_sesion_caja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, session.id_sesion_caja, scopeContext.idUsuario, { req, scopeContext });

    const movimiento = await insertCajaIngresoMovimiento({
      client,
      session,
      idUsuarioEjecutor: scopeContext.idUsuario,
      monto: req.body.monto,
      observacion: req.body.observacion,
      referencia: req.body.referencia,
      idTipoMovimientoCaja: req.body.id_tipo_movimiento_caja
    });

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Ingreso de caja registrado correctamente.',
      ...movimiento
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_INGRESO_CREATE_ERROR', 'No se pudo registrar el ingreso de caja.');
  } finally {
    client.release();
  }
});

router.post('/ventas/cajas/sesiones/:id/egresos', checkPermission(['VENTAS_CAJAS_MOVIMIENTO_MANUAL_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });

    const movimiento = await insertCajaEgresoMovimiento({
      client,
      session,
      idUsuarioEjecutor: scopeContext.idUsuario,
      monto: req.body.monto,
      observacion: req.body.observacion,
      referencia: req.body.referencia,
      idTipoMovimientoCaja: req.body.id_tipo_movimiento_caja
    });

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Egreso de caja registrado correctamente.',
      ...movimiento
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_EGRESO_CREATE_ERROR', 'No se pudo registrar el egreso de caja.');
  } finally {
    client.release();
  }
});

router.post('/ventas/cajas/sesiones/:id/ingresos', checkPermission(['VENTAS_CAJAS_MOVIMIENTO_MANUAL_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });

    const movimiento = await insertCajaIngresoMovimiento({
      client,
      session,
      idUsuarioEjecutor: scopeContext.idUsuario,
      monto: req.body.monto,
      observacion: req.body.observacion,
      referencia: req.body.referencia,
      idTipoMovimientoCaja: req.body.id_tipo_movimiento_caja
    });

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Ingreso de caja registrado correctamente.',
      ...movimiento
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_INGRESO_CREATE_ERROR', 'No se pudo registrar el ingreso de caja.');
  } finally {
    client.release();
  }
});

const closeSessionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    let montoDeclaradoCierre = parseNullableNonNegativeAmount(req.body.monto_declarado_cierre);
    const observacionCierre = normalizeText(req.body.observacion_cierre, 500);
    const idResolucion = parseNullablePositiveInt(req.body.id_resolucion_cierre_caja);
    const idArqueoFinal = parseNullablePositiveInt(req.body.id_arqueo_final);
    const idValidacionCierre = parseNullablePositiveInt(req.body.id_validacion_cierre);

    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);

    const resumen = await fetchSessionMethodFinancialSummary(client, idSesionCaja);

    await assertCanCloseCajaSession({ client, req, scopeContext, session, observacionCierre });

    const hasSegmentedPayload = Array.isArray(req.body.arqueos);
    const threshold = Number.isFinite(CLOSE_DIFFERENCE_THRESHOLD) && CLOSE_DIFFERENCE_THRESHOLD >= 0
      ? CLOSE_DIFFERENCE_THRESHOLD
      : 0;
    let idArqueoFinalSelected = idArqueoFinal;
    let idResolucionFinal = null;
    let diferencia = 0;
    let montoTeorico = Number(resumen.totalTeorico || 0);
    let arqueosPersistir = [];
    let validationToLink = null;

    if (hasSegmentedPayload) {
      const payloadRows = Array.isArray(req.body.arqueos) ? req.body.arqueos : [];
      const pendingResolutionId = await getCatalogId(client, 'RESOLUTIONS', 'PENDIENTE_REVISION');
      if (!pendingResolutionId) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_RESOLUTION_PENDING_MISSING',
          'No se encontro la resolucion PENDIENTE_REVISION.'
        );
      }
      idResolucionFinal = pendingResolutionId;
      const computation = await buildSegmentedArqueoComputation({
        client,
        idSesionCaja,
        payloadRows,
        threshold
      });
      arqueosPersistir = computation.rows;
      montoTeorico = computation.monto_teorico_total;
      montoDeclaradoCierre = computation.monto_declarado_total;
      diferencia = computation.diferencia_total;
    } else {
      if (montoDeclaradoCierre === null) {
        let arqueoFinal = null;
        if (idArqueoFinalSelected) {
          const arqueoResult = await client.query(
            `
              SELECT id_arqueo_caja, monto_contado
              FROM public.cajas_arqueos
              WHERE id_arqueo_caja = $1
                AND id_sesion_caja = $2
              LIMIT 1
            `,
            [idArqueoFinalSelected, idSesionCaja]
          );
          arqueoFinal = arqueoResult.rows[0] || null;
        } else {
          const arqueoResult = await client.query(
            `
              SELECT a.id_arqueo_caja, a.monto_contado
              FROM public.cajas_arqueos a
              INNER JOIN public.cat_cajas_arqueos_tipos t
                ON t.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja
              WHERE a.id_sesion_caja = $1
                AND UPPER(TRIM(t.codigo)) = 'CIERRE'
              ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC
              LIMIT 1
            `,
            [idSesionCaja]
          );
          arqueoFinal = arqueoResult.rows[0] || null;
        }

        if (arqueoFinal?.id_arqueo_caja) {
          idArqueoFinalSelected = Number(arqueoFinal.id_arqueo_caja);
          montoDeclaradoCierre = parseNullableNonNegativeAmount(arqueoFinal.monto_contado);
        }
      }

      if (montoDeclaradoCierre === null) {
        throw createCajaError(
          400,
          'VENTAS_CAJAS_CLOSE_AMOUNT_INVALID',
          'Debe indicar el monto declarado de cierre o registrar un arqueo de cierre.'
        );
      }

      diferencia = Number((montoDeclaradoCierre - montoTeorico).toFixed(2));
      if (Math.abs(diferencia) > 0 && !observacionCierre) {
        throw createArqueoObservationRequiredError('EFECTIVO');
      }
      if (Math.abs(diferencia) > 0 && !idResolucion) {
        throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_REQUIRED', 'Debe seleccionar una resolucion de cierre cuando existe diferencia.');
      }
      if (Math.abs(diferencia) > 0 && !(await requestHasAnyPermission(req, 'VENTAS_CAJAS_DIFERENCIA_RESOLVER'))) {
        throw createCajaError(403, 'VENTAS_CAJAS_DIFFERENCE_FORBIDDEN', 'No tiene permiso para resolver diferencias de cierre.');
      }

      idResolucionFinal = idResolucion;
      const idResolucionCajaCuadra = await getCatalogId(client, 'RESOLUTIONS', 'CAJA_CUADRA');
      if (Math.abs(diferencia) > 0 && idResolucionFinal) {
        const requestedResolutionCode = await getCatalogCodeById(client, 'RESOLUTIONS', idResolucionFinal);
        if (requestedResolutionCode === 'CAJA_CUADRA') {
          throw createCajaError(
            400,
            'VENTAS_CAJAS_RESOLUTION_INVALID',
            'Caja cuadra no es una resolucion manual cuando existe diferencia.'
          );
        }
      }
      if (!idResolucionFinal && Math.abs(diferencia) === 0) {
        idResolucionFinal = idResolucionCajaCuadra;
        if (!idResolucionFinal) {
          throw createCajaError(
            409,
            'VENTAS_CAJAS_RESOLUTION_DEFAULT_MISSING',
            'No se encontro la resolucion por defecto para cierres cuadrados.'
          );
        }
      } else if (Math.abs(diferencia) === 0 && idResolucionFinal && Number(idResolucionFinal) !== Number(idResolucionCajaCuadra)) {
        throw createCajaError(
          400,
          'VENTAS_CAJAS_RESOLUTION_NOT_REQUIRED',
          'Cuando la caja cuadra no se permite seleccionar otra resolucion.'
        );
      }
    }

    if (idValidacionCierre) {
      const validationResult = await client.query(
        `
          SELECT id_validacion_cierre, id_cierre_caja
               , total_teorico, total_declarado, diferencia_total
          FROM public.cajas_cierres_validaciones
          WHERE id_validacion_cierre = $1
            AND id_sesion_caja = $2
          LIMIT 1
          FOR UPDATE
        `,
        [idValidacionCierre, idSesionCaja]
      );
      const validation = validationResult.rows?.[0] || null;
      if (!validation) {
        throw createCajaError(404, 'VENTAS_CAJAS_VALIDACION_CIERRE_NOT_FOUND', 'La validacion de cierre no pertenece a esta sesion.');
      }
      if (validation.id_cierre_caja) {
        throw createCajaError(409, 'VENTAS_CAJAS_VALIDACION_CIERRE_ALREADY_LINKED', 'La validacion de cierre ya fue asociada a un cierre.');
      }
      validationToLink = validation;
      const validationMethodsResult = await client.query(
        `
          SELECT id_metodo_pago, metodo_pago_codigo, monto_teorico, monto_declarado,
                 diferencia, cantidad_referencias, observacion, requiere_revision
          FROM public.cajas_cierres_validaciones_metodos
          WHERE id_validacion_cierre = $1
          ORDER BY id_validacion_metodo ASC
        `,
        [idValidacionCierre]
      );
      if (validationMethodsResult.rowCount === 0) {
        throw createCajaError(409, 'VENTAS_CAJAS_VALIDACION_CIERRE_INCOMPLETA', 'La validacion de cierre no tiene detalle por metodo.');
      }
      const pendingResolutionId = await getCatalogId(client, 'RESOLUTIONS', 'PENDIENTE_REVISION');
      if (!pendingResolutionId) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_RESOLUTION_PENDING_MISSING',
          'No se encontro la resolucion PENDIENTE_REVISION.'
        );
      }
      idResolucionFinal = pendingResolutionId;
      montoTeorico = Number(validationToLink.total_teorico || 0);
      montoDeclaradoCierre = Number(validationToLink.total_declarado || 0);
      diferencia = Number(validationToLink.diferencia_total || 0);
      arqueosPersistir = validationMethodsResult.rows.map((row) => ({
        id_metodo_pago: Number(row.id_metodo_pago),
        metodo_pago_codigo: normalizeMethodCode(row.metodo_pago_codigo),
        monto_teorico: Number(row.monto_teorico || 0),
        monto_declarado: Number(row.monto_declarado || 0),
        diferencia: Number(row.diferencia || 0),
        cantidad_referencias: row.cantidad_referencias === null || row.cantidad_referencias === undefined
          ? null
          : Number(row.cantidad_referencias),
        observacion: row.observacion || null,
        requiere_revision: Boolean(row.requiere_revision),
        completado_automaticamente: false
      }));
    }

    const idEstadoCerrada = await getCatalogId(client, 'SESSION_STATES', 'CERRADA');
    const closeResult = await client.query(
      `
        INSERT INTO public.cajas_cierres (
          id_sesion_caja, id_caja, id_sucursal, id_usuario_responsable, id_usuario_cierre,
          id_resolucion_cierre_caja, id_arqueo_final, fecha_cierre, monto_apertura, monto_ventas_efectivo,
          monto_ventas_no_efectivo, monto_ingresos_manuales, monto_egresos_manuales, monto_teorico_cierre,
          monto_declarado_cierre, diferencia, observacion, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
        RETURNING id_cierre_caja
      `,
      [
        idSesionCaja, session.id_caja, session.id_sucursal, session.id_usuario_responsable, scopeContext.idUsuario,
        idResolucionFinal, idArqueoFinalSelected, Number(resumen.montoApertura || 0), Number(resumen.ventasEfectivoNetas || 0),
        Number(resumen.ventasNoEfectivoNetas || 0), Number(resumen.ingresosManuales || 0), Number(resumen.egresosManuales || 0),
        montoTeorico, montoDeclaradoCierre, diferencia, observacionCierre
      ]
    );
    const idCierreCaja = Number(closeResult.rows?.[0]?.id_cierre_caja || 0) || null;

    if (idCierreCaja && idValidacionCierre) {
      await client.query(
        `
          UPDATE public.cajas_cierres_validaciones
          SET id_cierre_caja = $1
          WHERE id_validacion_cierre = $2
            AND id_sesion_caja = $3
        `,
        [idCierreCaja, idValidacionCierre, idSesionCaja]
      );
    }

    if (idCierreCaja && Array.isArray(arqueosPersistir) && arqueosPersistir.length > 0) {
      for (const row of arqueosPersistir) {
        await client.query(
          `
            INSERT INTO public.cajas_cierres_arqueos_metodos (
              id_cierre_caja, id_sesion_caja, id_caja, id_sucursal, id_metodo_pago, metodo_pago_codigo,
              monto_teorico, monto_declarado, diferencia, cantidad_referencias, observacion,
              requiere_revision, completado_automaticamente, fecha_registro, id_usuario_registro
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)
            ON CONFLICT (id_cierre_caja, id_metodo_pago)
            DO UPDATE SET
              metodo_pago_codigo = EXCLUDED.metodo_pago_codigo,
              monto_teorico = EXCLUDED.monto_teorico,
              monto_declarado = EXCLUDED.monto_declarado,
              diferencia = EXCLUDED.diferencia,
              cantidad_referencias = EXCLUDED.cantidad_referencias,
              observacion = EXCLUDED.observacion,
              requiere_revision = EXCLUDED.requiere_revision,
              completado_automaticamente = EXCLUDED.completado_automaticamente,
              fecha_registro = NOW(),
              id_usuario_registro = EXCLUDED.id_usuario_registro
          `,
          [
            idCierreCaja,
            idSesionCaja,
            session.id_caja,
            session.id_sucursal,
            row.id_metodo_pago,
            row.metodo_pago_codigo,
            row.monto_teorico,
            row.monto_declarado,
            row.diferencia,
            row.cantidad_referencias,
            row.observacion,
            row.requiere_revision,
            row.completado_automaticamente,
            scopeContext.idUsuario
          ]
        );
      }
    }

    await client.query(
      `
        UPDATE public.cajas_sesiones
        SET id_estado_sesion_caja = $1, id_usuario_cierre = $2, fecha_cierre = NOW(),
            monto_teorico_cierre = $3, monto_declarado_cierre = $4, diferencia_cierre = $5,
            id_resolucion_cierre_caja = $6, observacion_cierre = $7, fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $8
      `,
      [idEstadoCerrada, scopeContext.idUsuario, montoTeorico, montoDeclaradoCierre, diferencia, idResolucionFinal, observacionCierre, idSesionCaja]
    );

    await client.query(
      `
        UPDATE public.cajas_sesiones_participantes
        SET activo = false, fecha_fin = NOW(), fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $1 AND COALESCE(activo, true) = true
      `,
      [idSesionCaja]
    );

    const resolutionCode = await getCatalogCodeById(client, 'RESOLUTIONS', idResolucionFinal);
    const fechaCierre = new Date().toISOString();
    const payrollSync = await syncPayrollDeductionForClose({
      client,
      idCierreCaja,
      idUsuarioResponsable: session.id_usuario_responsable,
      idSucursal: session.id_sucursal,
      fechaCierre,
      diferencia,
      resolucionCodigo: resolutionCode
    });
    let emailActors = {};
    try {
      emailActors = await fetchCajaCloseEmailActors(client, {
        idUsuarioResponsable: session.id_usuario_responsable,
        idUsuarioCierre: scopeContext.idUsuario
      });
    } catch (actorError) {
      console.warn('[cajas] No se pudieron resolver usuarios para correo de cierre:', actorError?.message || actorError);
    }
    let movimientosManuales = { ingresos: [], egresos: [] };
    try {
      movimientosManuales = await fetchCajaCloseManualMovements(client, idSesionCaja);
    } catch (movementError) {
      console.warn('[cajas] No se pudieron resolver movimientos manuales para reporte de cierre:', movementError?.message || movementError);
    }

    await client.query('COMMIT');
    const hasArqueoInconsistency = Array.isArray(arqueosPersistir)
      ? arqueosPersistir.some((row) =>
          Boolean(row.requiere_revision) || Math.abs(roundMoney(row.diferencia)) > 0
        )
      : false;
    const requiresAudit =
      Math.abs(roundMoney(diferencia)) > 0 ||
      resolutionCode === 'PENDIENTE_REVISION' ||
      hasArqueoInconsistency;
    void sendCajaCierreEmail({
      idCierreCaja,
      idSesionCaja,
      session,
      idUsuarioCierre: scopeContext.idUsuario,
      actors: emailActors,
      fechaCierre,
      montoTeorico,
      montoDeclaradoCierre,
      diferencia,
      idResolucionFinal,
      resolutionCode,
      payrollSync,
      arqueos: arqueosPersistir,
      requiresAudit,
      montoApertura: Number(resumen.montoApertura || 0),
      ventasEfectivoNetas: Number(resumen.ventasEfectivoNetas || 0),
      ventasNoEfectivoNetas: Number(resumen.ventasNoEfectivoNetas || 0),
      ingresosManuales: Number(resumen.ingresosManuales || 0),
      egresosManuales: Number(resumen.egresosManuales || 0),
      movimientosManuales
    }).catch((emailError) => {
      console.error('[cajas] Error enviando correo de cierre de caja:', emailError?.message || emailError);
    });
    const responsePayload = {
      message: 'Cierre de caja registrado correctamente.',
      id_cierre_caja: idCierreCaja,
      diferencia,
      id_arqueo_final: idArqueoFinalSelected,
      estado_revision: 'PENDIENTE_REVISION',
      arqueos_metodos: arqueosPersistir,
      payroll_sync: payrollSync
    };
    return res.status(200).json(
      (await isCashierOnlyRequest(req)) ? maskCajaCloseResponseForCajero(responsePayload) : responsePayload
    );
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CLOSE_ERROR', 'No se pudo cerrar la sesion de caja.');
  } finally {
    client.release();
  }
};

router.patch('/ventas/cajas/sesiones/:id/cerrar', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), closeSessionHandler);
router.post('/ventas/cajas/sesiones/:id/cerrar', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), closeSessionHandler);

router.post('/ventas/cajas/sesiones/:id/cierre-validaciones', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: false });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const observacionCierre = normalizeText(req.body?.observacion_cierre, 500);
    await assertCanCloseCajaSession({ client, req, scopeContext, session, observacionCierre });

    const threshold = Number.isFinite(CLOSE_DIFFERENCE_THRESHOLD) && CLOSE_DIFFERENCE_THRESHOLD >= 0
      ? CLOSE_DIFFERENCE_THRESHOLD
      : 0;
    const payloadRows = Array.isArray(req.body?.arqueos) ? req.body.arqueos : [];
    const computation = await buildSegmentedArqueoComputation({
      client,
      idSesionCaja,
      payloadRows,
      threshold,
      requireObservacionOnDifference: false
    });

    const validation = await persistCloseValidationAttempt({
      client,
      session,
      idUsuarioValida: scopeContext.idUsuario,
      computation,
      payloadRows,
      observacionCierre,
      origen: req.body?.origen,
      ipOrigen: getClientIp(req),
      userAgent: req.get('user-agent') || null
    });

    await client.query('COMMIT');
    return res.status(201).json(
      buildCloseValidationResponse({
        validation,
        computation,
        isCashierOnly: await isCashierOnlyRequest(req)
      })
    );
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CLOSE_VALIDATION_ERROR', 'No se pudo registrar la revision de diferencias.');
  } finally {
    client.release();
  }
});

router.post('/ventas/cajas/sesiones/:id/cierre-preview', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: false });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const observacionCierre = normalizeText(req.body?.observacion_cierre, 500);
    await assertCanCloseCajaSession({ client, req, scopeContext, session, observacionCierre });

    const threshold = Number.isFinite(CLOSE_DIFFERENCE_THRESHOLD) && CLOSE_DIFFERENCE_THRESHOLD >= 0
      ? CLOSE_DIFFERENCE_THRESHOLD
      : 0;
    const payloadRows = Array.isArray(req.body?.arqueos) ? req.body.arqueos : [];
    const computation = await buildSegmentedArqueoComputation({
      client,
      idSesionCaja,
      payloadRows,
      threshold
    });

    const responsePayload = {
      message: 'Vista previa de cierre calculada correctamente.',
      threshold,
      arqueos_metodos: computation.rows,
      resumen: {
        total_teorico: computation.monto_teorico_total,
        total_declarado: computation.monto_declarado_total,
        diferencia_total: computation.diferencia_total
      }
    };
    return res.status(200).json(
      (await isCashierOnlyRequest(req)) ? maskCajaClosePreviewForCajero(computation) : responsePayload
    );
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CLOSE_PREVIEW_ERROR', 'No se pudo calcular la vista previa del cierre.');
  } finally {
    client.release();
  }
});

router.patch('/ventas/cajas/cierres/:id/resolucion', checkPermission(['VENTAS_CAJAS_DIFERENCIA_RESOLVER']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idCierreCaja = parsePositiveInt(req.params.id);
    const resolutionCode = normalizeCajaCode(req.body?.resolucion_codigo ?? req.body?.resolution_code, 80);
    const observacion = normalizeText(req.body?.observacion ?? req.body?.observacion_cierre, 1000);
    const requestedUsuarioResponsableDiferencia = parseNullablePositiveInt(
      req.body?.id_usuario_responsable_diferencia
      ?? req.body?.id_usuario_descuento
      ?? req.body?.id_usuario
    );

    if (!idCierreCaja) {
      throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_ID_INVALID', 'El id de cierre es invalido.');
    }
    if (!resolutionCode) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_REQUIRED', 'Debe seleccionar una resolucion.');
    }
    if (!observacion) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_OBSERVATION_REQUIRED', 'La observacion administrativa es obligatoria.');
    }

    const closeResult = await client.query(
      `
        SELECT cc.*,
               cs.id_estado_sesion_caja,
               resolucion.codigo AS resolucion_codigo,
               resolucion.nombre AS resolucion_nombre
        FROM public.cajas_cierres cc
        INNER JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = cc.id_sesion_caja
        LEFT JOIN public.cat_cajas_resoluciones_cierre resolucion
          ON resolucion.id_resolucion_cierre_caja = cc.id_resolucion_cierre_caja
        WHERE cc.id_cierre_caja = $1
        LIMIT 1
        FOR UPDATE OF cc
      `,
      [idCierreCaja]
    );
    if (closeResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_CLOSE_NOT_FOUND', 'El cierre indicado no existe.');
    }

    const cierre = closeResult.rows[0];
    const currentResolutionCode = normalizeCajaCode(cierre.resolucion_codigo, 80);
    if (currentResolutionCode && currentResolutionCode !== 'PENDIENTE_REVISION') {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_CLOSE_ALREADY_RESOLVED',
        'El cierre ya tiene una resolucion final registrada.'
      );
    }

    const scopeContext = await getScopeContext(req, client, cierre.id_sucursal, true);
    assertSucursalAllowed(scopeContext, cierre.id_sucursal);

    const resolution = await getResolutionByCode(client, resolutionCode);
    if (!resolution?.id_resolucion_cierre_caja) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_INVALID', 'La resolucion indicada no existe o esta inactiva.');
    }

    const diferencia = roundMoney(cierre.diferencia);
    const allowedCodes = diferencia === 0
      ? new Set(['CAJA_CUADRA'])
      : (diferencia < 0
        ? new Set(['GASTO_EMPRESA', 'DESCUENTO_EMPLEADO'])
        : new Set(['GASTO_EMPRESA', 'PENDIENTE_REVISION']));

    if (!allowedCodes.has(resolution.codigo)) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_RESOLUTION_INVALID',
        diferencia > 0
          ? 'Un sobrante no puede resolverse como descuento a empleado.'
          : 'La resolucion seleccionada no aplica para la diferencia del cierre.'
      );
    }

    let payrollSync = { synced: true, reason: 'NOT_REQUIRED' };
    let idUsuarioDeduccion = null;

    if (resolution.codigo === 'DESCUENTO_EMPLEADO') {
      const idUsuarioResponsableCaja = parsePositiveInt(cierre.id_usuario_responsable);
      idUsuarioDeduccion = idUsuarioResponsableCaja;

      if (!idUsuarioDeduccion) {
        throw createCajaError(
          409,
          'RESPONSABLE_CAJA_NO_DETERMINADO',
          'No se pudo determinar el responsable de la caja.'
        );
      }
      if (
        requestedUsuarioResponsableDiferencia
        && requestedUsuarioResponsableDiferencia !== idUsuarioDeduccion
      ) {
        throw createCajaError(
          400,
          'VENTAS_CAJAS_DEDUCTION_RESPONSIBLE_ONLY',
          'El faltante solo puede asignarse al responsable de la caja en esta version.'
        );
      }

      const participantResult = await client.query(
        `
          WITH participantes AS (
            SELECT cs.id_usuario_responsable AS id_usuario, 'RESPONSABLE'::text AS rol_codigo
            FROM public.cajas_sesiones cs
            WHERE cs.id_sesion_caja = $1
            UNION
            SELECT csp.id_usuario, UPPER(TRIM(crp.codigo)) AS rol_codigo
            FROM public.cajas_sesiones_participantes csp
            INNER JOIN public.cat_cajas_roles_participacion crp
              ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
            WHERE csp.id_sesion_caja = $1
          )
          SELECT p.id_usuario,
                 p.rol_codigo,
                 COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''), u.nombre_usuario) AS usuario_nombre
          FROM participantes p
          INNER JOIN public.usuarios u ON u.id_usuario = p.id_usuario
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          WHERE p.id_usuario = $2
          LIMIT 1
        `,
        [cierre.id_sesion_caja, idUsuarioDeduccion]
      );
      if (participantResult.rowCount === 0) {
        throw createCajaError(
          400,
          'VENTAS_CAJAS_DEDUCTION_USER_INVALID',
          'El responsable de caja no pertenece al equipo de esa caja.'
        );
      }

      try {
        payrollSync = await syncPayrollDeductionForClose({
          client,
          idCierreCaja,
          idUsuarioResponsable: cierre.id_usuario_responsable,
          idUsuarioDeduccion,
          idSucursal: cierre.id_sucursal,
          fechaCierre: cierre.fecha_cierre || new Date().toISOString(),
          diferencia,
          resolucionCodigo: resolution.codigo
        });
      } catch (syncError) {
        if (Number.isInteger(syncError?.httpStatus)) throw syncError;
        throw createCajaError(
          409,
          'PAYROLL_DEDUCTION_NOT_CREATED',
          'No se pudo registrar la deduccion en planilla. El cierre sigue pendiente.',
          {
            db_code: syncError?.code || null,
            db_message: syncError?.message || null,
            monto_deduccion: Number(Math.abs(Number(diferencia || 0)).toFixed(2))
          }
        );
      }

      if (!payrollSync?.synced) {
        const reason = String(payrollSync?.reason || 'PAYROLL_DEDUCTION_NOT_CREATED').trim().toUpperCase();
        const failureMap = {
          RESPONSABLE_CAJA_NO_DETERMINADO: {
            code: 'RESPONSABLE_CAJA_NO_DETERMINADO',
            message: 'No se pudo determinar el responsable de la caja.'
          },
          PLANILLA_DETAIL_NOT_FOUND: {
            code: 'PLANILLA_DETAIL_NOT_FOUND',
            message: 'No existe un detalle de planilla editable para el responsable de esta caja. El cierre sigue pendiente.'
          },
          PLANILLA_NOT_EDITABLE: {
            code: 'PLANILLA_NOT_EDITABLE',
            message: 'La planilla encontrada no esta editable para registrar la deduccion. El cierre sigue pendiente.'
          },
          PAYROLL_DEDUCTION_NOT_CREATED: {
            code: 'PAYROLL_DEDUCTION_NOT_CREATED',
            message: 'No se pudo registrar la deduccion en planilla. El cierre sigue pendiente.'
          }
        };
        const failure = failureMap[reason] || failureMap.PAYROLL_DEDUCTION_NOT_CREATED;
        throw createCajaError(
          409,
          failure.code,
          failure.message,
          { payroll_sync: payrollSync }
        );
      }
    } else {
      try {
        payrollSync = await syncPayrollDeductionForClose({
          client,
          idCierreCaja,
          idUsuarioResponsable: cierre.id_usuario_responsable,
          idSucursal: cierre.id_sucursal,
          fechaCierre: cierre.fecha_cierre || new Date().toISOString(),
          diferencia,
          resolucionCodigo: resolution.codigo
        });
      } catch (syncError) {
        if (Number.isInteger(syncError?.httpStatus)) throw syncError;
        throw createCajaError(
          409,
          'PAYROLL_DEDUCTION_NOT_CREATED',
          'No se pudo actualizar la sincronizacion con planilla. El cierre sigue pendiente.',
          {
            db_code: syncError?.code || null,
            db_message: syncError?.message || null
          }
        );
      }
    }

    await client.query(
      `
        UPDATE public.cajas_cierres
        SET id_resolucion_cierre_caja = $1,
            observacion = $2
        WHERE id_cierre_caja = $3
      `,
      [resolution.id_resolucion_cierre_caja, observacion, idCierreCaja]
    );

    await client.query(
      `
        UPDATE public.cajas_sesiones
        SET id_resolucion_cierre_caja = $1,
            observacion_cierre = $2,
            fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $3
      `,
      [resolution.id_resolucion_cierre_caja, observacion, cierre.id_sesion_caja]
    );

    await client.query(
      `
        INSERT INTO public.cajas_cierres_auditoria (
          id_cierre_caja,
          id_usuario_accion,
          accion,
          motivo,
          snapshot_before,
          snapshot_after,
          fecha_creacion
        )
        VALUES ($1, $2, 'RESOLVER_DIFERENCIA', $3, $4::jsonb, $5::jsonb, NOW())
      `,
      [
        idCierreCaja,
        scopeContext.idUsuario,
        observacion,
        JSON.stringify(cierre),
        JSON.stringify({
          ...cierre,
          id_resolucion_cierre_caja: resolution.id_resolucion_cierre_caja,
          resolucion_codigo: resolution.codigo,
          resolucion_nombre: resolution.nombre,
          observacion,
          id_usuario_responsable_diferencia: idUsuarioDeduccion
        })
      ]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      message: 'Diferencia de cierre resuelta correctamente.',
      id_cierre_caja: idCierreCaja,
      id_sesion_caja: cierre.id_sesion_caja,
      diferencia,
      resolucion_codigo: resolution.codigo,
      resolucion_nombre: resolution.nombre,
      id_usuario_responsable_diferencia: idUsuarioDeduccion,
      payroll_sync: payrollSync
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_RESOLVE_DIFFERENCE_ERROR', 'No se pudo resolver la diferencia del cierre.');
  } finally {
    client.release();
  }
});

router.patch('/ventas/cajas/cierres/:id', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idCierreCaja = parsePositiveInt(req.params.id);
    const montoDeclarado = parseNullableNonNegativeAmount(req.body.monto_declarado_cierre);
    const observacion = normalizeText(req.body.observacion_cierre, 500);
    const motivoEdicion = normalizeText(req.body.motivo_edicion, 500);
    const idResolucion = parseNullablePositiveInt(req.body.id_resolucion_cierre_caja);
    const idArqueoFinal = parseNullablePositiveInt(req.body.id_arqueo_final);

    if (!idCierreCaja) {
      throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_ID_INVALID', 'El id de cierre es invalido.');
    }
    if (!motivoEdicion) {
      throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_EDIT_REASON_REQUIRED', 'Debe indicar el motivo de la edicion.');
    }

    const closeResult = await client.query(
      `
        SELECT cc.*, cs.id_estado_sesion_caja
        FROM public.cajas_cierres cc
        INNER JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = cc.id_sesion_caja
        WHERE cc.id_cierre_caja = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idCierreCaja]
    );
    if (closeResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_CLOSE_NOT_FOUND', 'El cierre indicado no existe.');
    }

    const cierre = closeResult.rows[0];
    const scopeContext = await getScopeContext(req, client, cierre.id_sucursal, true);
    assertSucursalAllowed(scopeContext, cierre.id_sucursal);

    const fechaCreacion = new Date(cierre.fecha_creacion || cierre.fecha_cierre || 0);
    const elapsedMinutes = Math.floor((Date.now() - fechaCreacion.getTime()) / 60000);
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes > 30) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_CLOSE_EDIT_WINDOW_EXPIRED',
        'El cierre solo puede editarse durante los primeros 30 minutos.'
      );
    }

    let montoDeclaradoFinal = montoDeclarado;
    let idArqueoFinalSelected = idArqueoFinal ?? parseNullablePositiveInt(cierre.id_arqueo_final);
    if (montoDeclaradoFinal === null && idArqueoFinalSelected) {
      const arqueoResult = await client.query(
        `
          SELECT monto_contado
          FROM public.cajas_arqueos
          WHERE id_arqueo_caja = $1
            AND id_sesion_caja = $2
          LIMIT 1
        `,
        [idArqueoFinalSelected, cierre.id_sesion_caja]
      );
      montoDeclaradoFinal = parseNullableNonNegativeAmount(arqueoResult.rows?.[0]?.monto_contado);
    }
    if (montoDeclaradoFinal === null) {
      throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_AMOUNT_INVALID', 'Debe indicar un monto declarado valido.');
    }

    const summary = await fetchSessionMethodFinancialSummary(client, cierre.id_sesion_caja);
    const montoTeorico = Number(summary.totalTeorico || 0);
    const diferencia = Number((montoDeclaradoFinal - montoTeorico).toFixed(2));
    const idResolucionCajaCuadra = await getCatalogId(client, 'RESOLUTIONS', 'CAJA_CUADRA');
    let idResolucionFinal = idResolucion ?? parseNullablePositiveInt(cierre.id_resolucion_cierre_caja);

    if (Math.abs(diferencia) === 0) {
      idResolucionFinal = idResolucionCajaCuadra;
    } else if (!idResolucionFinal) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_REQUIRED', 'Debe seleccionar una resolucion para diferencias.');
    }

    const resolutionCode = await getCatalogCodeById(client, 'RESOLUTIONS', idResolucionFinal);
    if (Math.abs(diferencia) > 0 && resolutionCode === 'CAJA_CUADRA') {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_RESOLUTION_INVALID',
        'Caja cuadra no aplica cuando existe diferencia.'
      );
    }

    await client.query(
      `
        UPDATE public.cajas_cierres
        SET id_resolucion_cierre_caja = $1,
            id_arqueo_final = $2,
            monto_teorico_cierre = $3,
            monto_declarado_cierre = $4,
            diferencia = $5,
            observacion = $6
        WHERE id_cierre_caja = $7
      `,
      [
        idResolucionFinal,
        idArqueoFinalSelected,
        montoTeorico,
        montoDeclaradoFinal,
        diferencia,
        observacion,
        idCierreCaja
      ]
    );

    await client.query(
      `
        UPDATE public.cajas_sesiones
        SET monto_teorico_cierre = $1,
            monto_declarado_cierre = $2,
            diferencia_cierre = $3,
            id_resolucion_cierre_caja = $4,
            observacion_cierre = $5,
            fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $6
      `,
      [montoTeorico, montoDeclaradoFinal, diferencia, idResolucionFinal, observacion, cierre.id_sesion_caja]
    );

    await client.query(
      `
        INSERT INTO public.cajas_cierres_auditoria (
          id_cierre_caja,
          id_usuario_accion,
          accion,
          motivo,
          snapshot_before,
          snapshot_after,
          fecha_creacion
        )
        VALUES ($1, $2, 'EDIT', $3, $4::jsonb, $5::jsonb, NOW())
      `,
      [
        idCierreCaja,
        scopeContext.idUsuario,
        motivoEdicion,
        JSON.stringify(cierre),
        JSON.stringify({
          ...cierre,
          id_resolucion_cierre_caja: idResolucionFinal,
          id_arqueo_final: idArqueoFinalSelected,
          monto_teorico_cierre: montoTeorico,
          monto_declarado_cierre: montoDeclaradoFinal,
          diferencia,
          observacion
        })
      ]
    );

    const payrollSync = await syncPayrollDeductionForClose({
      client,
      idCierreCaja,
      idUsuarioResponsable: cierre.id_usuario_responsable,
      idSucursal: cierre.id_sucursal,
      fechaCierre: cierre.fecha_cierre || new Date().toISOString(),
      diferencia,
      resolucionCodigo: resolutionCode
    });

    await client.query('COMMIT');
    return res.status(200).json({
      message: 'Cierre editado correctamente.',
      id_cierre_caja: idCierreCaja,
      diferencia,
      payroll_sync: payrollSync
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CLOSE_EDIT_ERROR', 'No se pudo editar el cierre de caja.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/reportes/resumen', checkPermission(['VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) pushFilter('vw.id_sucursal = $IDX', scopeContext.targetSucursalId);
    else if (!scopeContext.isSuperAdmin) pushFilter('vw.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    const idResponsable = parseNullablePositiveInt(req.query.id_usuario_responsable);
    if (idCaja) pushFilter('vw.id_caja = $IDX', idCaja);
    if (idResponsable) pushFilter('vw.id_usuario_responsable = $IDX', idResponsable);

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT vw.*, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               u.nombre_usuario AS responsable_usuario, ${USER_DISPLAY_SQL} AS responsable_nombre
        FROM public.vw_cajas_sesiones_resumen vw
        INNER JOIN public.cajas c ON c.id_caja = vw.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = vw.id_sucursal
        INNER JOIN public.usuarios u ON u.id_usuario = vw.id_usuario_responsable
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        ${whereClause}
        ORDER BY vw.fecha_apertura DESC, vw.id_sesion_caja DESC
      `,
      params
    );

    const isRestrictedCajero = await isCashierOnlyRequest(req);
    return res.status(200).json(isRestrictedCajero ? result.rows.map(maskCajaSessionRowForCajero) : result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_REPORT_SUMMARY_ERROR', 'No se pudo generar el resumen de cajas.');
  }
});

router.get('/ventas/cajas/reportes/cierres', checkPermission(['VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) pushFilter('vw.id_sucursal = $IDX', scopeContext.targetSucursalId);
    else if (!scopeContext.isSuperAdmin) pushFilter('vw.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    if (idCaja) pushFilter('vw.id_caja = $IDX', idCaja);

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT vw.*, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               resp.nombre_usuario AS responsable_usuario,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_resp.nombre, per_resp.apellido)), ''), resp.nombre_usuario) AS responsable_nombre,
               cierre.nombre_usuario AS usuario_cierre,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_cierre.nombre, per_cierre.apellido)), ''), cierre.nombre_usuario) AS usuario_cierre_nombre,
               COALESCE(recuentos.recuentos_count, 0)::int AS recuentos_count,
               recuentos.ultimo_recuento_numero,
               recuentos.ultima_revision_fecha,
               (cc.fecha_creacion + INTERVAL '30 minutes') AS editable_hasta,
               (NOW() <= (cc.fecha_creacion + INTERVAL '30 minutes')) AS editable_en_ventana
        FROM public.vw_cajas_cierres_resumen vw
        INNER JOIN public.cajas_cierres cc ON cc.id_cierre_caja = vw.id_cierre_caja
        INNER JOIN public.cajas c ON c.id_caja = vw.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = vw.id_sucursal
        INNER JOIN public.usuarios resp ON resp.id_usuario = vw.id_usuario_responsable
        LEFT JOIN public.empleados e_resp ON e_resp.id_empleado = resp.id_empleado
        LEFT JOIN public.personas per_resp ON per_resp.id_persona = e_resp.id_persona
        INNER JOIN public.usuarios cierre ON cierre.id_usuario = vw.id_usuario_cierre
        LEFT JOIN public.empleados e_cierre ON e_cierre.id_empleado = cierre.id_empleado
        LEFT JOIN public.personas per_cierre ON per_cierre.id_persona = e_cierre.id_persona
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS recuentos_count,
                 MAX(v.numero_intento)::int AS ultimo_recuento_numero,
                 MAX(v.fecha_validacion) AS ultima_revision_fecha
          FROM public.cajas_cierres_validaciones v
          WHERE v.id_sesion_caja = vw.id_sesion_caja
        ) recuentos ON true
        ${whereClause}
        ORDER BY vw.fecha_cierre DESC, vw.id_cierre_caja DESC
      `,
      params
    );

    const isRestrictedCajero = await isCashierOnlyRequest(req);
    return res.status(200).json(isRestrictedCajero ? result.rows.map(maskCajaSessionRowForCajero) : result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_REPORT_CLOSES_ERROR', 'No se pudo generar el reporte de cierres.');
  }
});

router.post('/ventas/cajas/sesiones/:id/participantes', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idUsuarioParticipante = parsePositiveInt(req.body.id_usuario);
    const roleCode = normalizeText(req.body.rol_codigo || 'AUXILIAR', 30)?.toUpperCase();
    const observacion = normalizeText(req.body.observacion, 300);
    if (!idSesionCaja || !idUsuarioParticipante) throw createCajaError(400, 'VENTAS_CAJAS_PARTICIPANT_DATA_INVALID', 'Debe indicar una sesion y un usuario validos.');
    if (!['AUXILIAR', 'RESPONSABLE'].includes(roleCode)) throw createCajaError(400, 'VENTAS_CAJAS_PARTICIPANT_ROLE_INVALID', 'El rol de participacion es invalido.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    if (!(await requestHasAnyRole(req, ADMIN_ROLE_CODES)) && Number(session.id_usuario_responsable) !== Number(scopeContext.idUsuario)) {
      throw createCajaError(403, 'VENTAS_CAJAS_PARTICIPANT_ASSIGN_FORBIDDEN', 'Solo el responsable de la sesion o un administrador puede gestionar participantes.');
    }
    if (Number(session.id_usuario_responsable) === Number(idUsuarioParticipante) && roleCode !== 'RESPONSABLE') {
      throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_DUPLICATE', 'El responsable de la sesion no puede agregarse como auxiliar.');
    }
    if (roleCode === 'RESPONSABLE') {
      throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_ALREADY_DEFINED', 'La sesion ya tiene un responsable asignado.');
    }
    await assertCajaAuthorization(client, session.id_caja, idUsuarioParticipante, roleCode);

    const duplicateResult = await client.query(
      `SELECT id_participacion_caja FROM public.cajas_sesiones_participantes WHERE id_sesion_caja = $1 AND id_usuario = $2 AND COALESCE(activo, true) = true LIMIT 1`,
      [idSesionCaja, idUsuarioParticipante]
    );
    if (duplicateResult.rowCount > 0) throw createCajaError(409, 'VENTAS_CAJAS_PARTICIPANT_DUPLICATE', 'El usuario ya participa activamente en esta sesion.');

    const idRolParticipacion = await getCatalogId(client, 'PARTICIPATION_ROLES', roleCode);
    const insertResult = await client.query(
      `
        INSERT INTO public.cajas_sesiones_participantes (
          id_sesion_caja, id_usuario, id_rol_participacion_caja, fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1, $2, $3, NOW(), true, $4, NOW(), NOW())
        RETURNING id_participacion_caja
      `,
      [idSesionCaja, idUsuarioParticipante, idRolParticipacion, observacion]
    );

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Participante agregado correctamente a la sesion.', id_participacion_caja: Number(insertResult.rows[0].id_participacion_caja) });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_PARTICIPANT_CREATE_ERROR', 'No se pudo agregar el participante a la sesion.');
  } finally {
    client.release();
  }
});

router.post('/ventas/cajas/sesiones/:id/auto-auxiliar', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idSucursal = parsePositiveInt(req.body?.id_sucursal);
    if (!idSesionCaja || !idSucursal) {
      throw createCajaError(400, 'VENTAS_CAJAS_AUTO_AUXILIAR_DATA_INVALID', 'Debe indicar una sesion de caja e id_sucursal validos.');
    }
    if (!(await requestIsSuperAdminReal(client, req))) {
      throw createCajaError(403, 'VENTAS_CAJAS_ROLE_FORBIDDEN', 'Accion exclusiva para SUPER_ADMIN.');
    }

    const scopeContext = await getScopeContext(req, client, idSucursal, true);
    assertSucursalAllowed(scopeContext, idSucursal);
    const idUsuario = parsePositiveInt(scopeContext.idUsuario);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    if (!parseBooleanish(session.caja_estado)) {
      throw createCajaError(409, 'VENTAS_CAJAS_CAJA_INACTIVA', 'La caja de la sesion seleccionada no esta activa.');
    }
    if (Number(session.id_sucursal) !== Number(idSucursal)) {
      throw createCajaError(409, 'VENTAS_CAJAS_SCOPE_MISMATCH', 'La caja seleccionada no pertenece a la sucursal de la venta.');
    }

    const roleAuxiliarId = await getCatalogId(client, 'PARTICIPATION_ROLES', 'AUXILIAR');
    if (!roleAuxiliarId) {
      throw createCajaError(409, 'VENTAS_CAJAS_AUXILIAR_ROLE_NOT_FOUND', 'No se encontro el rol operativo AUXILIAR.');
    }

    const existingResult = await client.query(
      `
        SELECT csp.id_participacion_caja, csp.id_rol_participacion_caja, crp.codigo AS rol_codigo
        FROM public.cajas_sesiones_participantes csp
        INNER JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
        WHERE csp.id_sesion_caja = $1
          AND csp.id_usuario = $2
          AND COALESCE(csp.activo, true) = true
        LIMIT 1
        FOR UPDATE
      `,
      [idSesionCaja, idUsuario]
    );

    if (existingResult.rowCount === 0) {
      const inactiveResult = await client.query(
        `
          SELECT id_participacion_caja
          FROM public.cajas_sesiones_participantes
          WHERE id_sesion_caja = $1
            AND id_usuario = $2
            AND COALESCE(activo, true) = false
          ORDER BY id_participacion_caja DESC
          LIMIT 1
          FOR UPDATE
        `,
        [idSesionCaja, idUsuario]
      );
      if (inactiveResult.rowCount > 0) {
        await client.query(
          `
            UPDATE public.cajas_sesiones_participantes
            SET id_rol_participacion_caja = $1,
                fecha_inicio = NOW(),
                fecha_fin = NULL,
                activo = true,
                observacion = $2,
                fecha_actualizacion = NOW()
            WHERE id_participacion_caja = $3
          `,
          [roleAuxiliarId, 'Autoasignacion operativa desde modulo de ventas para procesar venta.', inactiveResult.rows[0].id_participacion_caja]
        );
      } else {
        await client.query(
          `
            INSERT INTO public.cajas_sesiones_participantes (
              id_sesion_caja, id_usuario, id_rol_participacion_caja, fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
            )
            VALUES ($1, $2, $3, NOW(), true, $4, NOW(), NOW())
          `,
          [idSesionCaja, idUsuario, roleAuxiliarId, 'Autoasignacion operativa desde modulo de ventas para procesar venta.']
        );
      }
    }

    await client.query('COMMIT');
    return res.status(200).json({
      id_sesion_caja: session.id_sesion_caja,
      id_caja: session.id_caja,
      id_sucursal: session.id_sucursal,
      codigo_caja: session.codigo_caja,
      nombre_caja: session.nombre_caja,
      rol_codigo: 'AUXILIAR'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_AUTO_AUXILIAR_ERROR', 'No se pudo registrar la autoasignacion temporal.');
  } finally {
    client.release();
  }
});

const inactivateParticipantHandler = async ({ req, res, byUserId = false }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const targetId = byUserId ? parsePositiveInt(req.params.idUsuarioParticipante) : parsePositiveInt(req.params.id_participante);
    if (!idSesionCaja || !targetId) throw createCajaError(400, 'VENTAS_CAJAS_PARTICIPANT_ID_INVALID', 'El participante indicado no es valido.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    if (!(await requestHasAnyRole(req, ADMIN_ROLE_CODES)) && Number(session.id_usuario_responsable) !== Number(scopeContext.idUsuario)) {
      throw createCajaError(403, 'VENTAS_CAJAS_PARTICIPANT_REMOVE_FORBIDDEN', 'Solo el responsable de la sesion o un administrador puede inactivar participantes.');
    }

    const participantResult = await client.query(
      `
        SELECT id_participacion_caja, id_usuario, activo
        FROM public.cajas_sesiones_participantes
        WHERE id_sesion_caja = $1 AND ${byUserId ? 'id_usuario = $2' : 'id_participacion_caja = $2'}
        LIMIT 1 FOR UPDATE
      `,
      [idSesionCaja, targetId]
    );
    if (participantResult.rowCount === 0) throw createCajaError(404, 'VENTAS_CAJAS_PARTICIPANT_NOT_FOUND', 'El participante indicado no existe en la sesion.');

    const participant = participantResult.rows[0];
    if (!parseBooleanish(participant.activo)) throw createCajaError(409, 'VENTAS_CAJAS_PARTICIPANT_ALREADY_INACTIVE', 'El participante ya se encuentra inactivo.');
    if (Number(participant.id_usuario) === Number(session.id_usuario_responsable)) {
      throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_CANNOT_BE_REMOVED', 'No se puede inactivar al responsable de la sesion mientras permanezca abierta.');
    }

    await client.query(
      `UPDATE public.cajas_sesiones_participantes SET activo = false, fecha_fin = NOW(), fecha_actualizacion = NOW() WHERE id_participacion_caja = $1`,
      [participant.id_participacion_caja]
    );
    await client.query('COMMIT');
    return res.status(200).json({ message: 'Participante inactivado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_PARTICIPANT_INACTIVATE_ERROR', 'No se pudo inactivar el participante.');
  } finally {
    client.release();
  }
};

router.patch('/ventas/cajas/sesiones/:id/participantes/:id_participante/inactivar', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), (req, res) => inactivateParticipantHandler({ req, res, byUserId: false }));
router.put('/ventas/cajas/sesiones/:id/participantes/:idUsuarioParticipante', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), (req, res) => inactivateParticipantHandler({ req, res, byUserId: true }));

router.post('/ventas/cajas/sesiones/:id/arqueos', checkPermission(['VENTAS_CAJAS_ARQUEO_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idTipoArqueoCaja = parsePositiveInt(req.body.id_tipo_arqueo_caja);
    const montoContado = parseNonNegativeAmount(req.body.monto_contado);
    const observacion = normalizeText(req.body.observacion, 500);
    const detalleBilletes = Array.isArray(req.body.detalle_billetes) ? req.body.detalle_billetes : [];
    if (!idSesionCaja || !idTipoArqueoCaja) throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_DATA_INVALID', 'Debe indicar una sesion y un tipo de arqueo validos.');
    if (montoContado === null) throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_AMOUNT_INVALID', 'monto_contado debe ser un numero mayor o igual a 0.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja);
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });
    const tipoArqueoCode = await getCatalogCodeById(client, 'ARQUEO_TYPES', idTipoArqueoCaja);
    if (!ALLOWED_NEW_ARQUEO_CODES.has(tipoArqueoCode)) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_ARQUEO_TYPE_INVALID',
        'Solo se permiten arqueos de cierre o extraordinarios.'
      );
    }

    const resumen = await fetchSessionMethodFinancialSummary(client, idSesionCaja);
    const montoTeorico = Number(resumen.efectivoTeorico || 0);
    const diferencia = Number((montoContado - montoTeorico).toFixed(2));
    const insertArqueo = await client.query(
      `
        INSERT INTO public.cajas_arqueos (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_arqueo_caja, id_usuario_ejecutor,
          monto_teorico, monto_contado, diferencia, observacion, fecha_arqueo, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        RETURNING id_arqueo_caja
      `,
      [idSesionCaja, session.id_caja, session.id_sucursal, idTipoArqueoCaja, scopeContext.idUsuario, montoTeorico, montoContado, diferencia, observacion]
    );

    const idArqueoCaja = Number(insertArqueo.rows[0].id_arqueo_caja);
    for (const row of detalleBilletes) {
      const denominacion = Number(row?.denominacion);
      const cantidad = Number(row?.cantidad);
      if (!Number.isFinite(denominacion) || !Number.isFinite(cantidad) || cantidad < 0) continue;
      await client.query(
        `INSERT INTO public.cajas_arqueos_detalle (id_arqueo_caja, denominacion, cantidad, fecha_creacion) VALUES ($1, $2, $3, NOW())`,
        [idArqueoCaja, denominacion, cantidad]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Arqueo registrado correctamente.', id_arqueo_caja: idArqueoCaja });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_ARQUEO_CREATE_ERROR', 'No se pudo registrar el arqueo.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/sesiones/:id/arqueos', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, pool, null, true);
    const session = await fetchSessionBase(pool, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const result = await pool.query(`SELECT a.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre FROM public.cajas_arqueos a INNER JOIN public.cat_cajas_arqueos_tipos tipo ON tipo.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja WHERE a.id_sesion_caja = $1 ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC`, [idSesionCaja]);
    const isRestrictedCajero = await isCashierOnlyRequest(req);
    return res.status(200).json(isRestrictedCajero ? result.rows.map(maskCajaFinancialMethod) : result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_ARQUEO_LIST_ERROR', 'No se pudieron obtener los arqueos de la sesion.');
  }
});

router.post('/ventas/cajas/sesiones/:id/movimientos', checkPermission(['VENTAS_CAJAS_MOVIMIENTO_MANUAL_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    let idTipoMovimientoCaja = parsePositiveInt(req.body.id_tipo_movimiento_caja);
    const monto = parseNonNegativeAmount(req.body.monto);
    const observacion = normalizeText(req.body.observacion, 500);
    const referencia = normalizeText(req.body.referencia, 120);
    if (!idSesionCaja || !idTipoMovimientoCaja) throw createCajaError(400, 'VENTAS_CAJAS_MOVEMENT_DATA_INVALID', 'Debe indicar una sesion y un tipo de movimiento validos.');
    if (monto === null || monto <= 0) throw createCajaError(400, 'VENTAS_CAJAS_MOVEMENT_AMOUNT_INVALID', 'monto debe ser un numero mayor a 0.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja);
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });
    if (await isCashierOnlyRequest(req)) {
      const tipoEgreso = await resolveEgresoMovimientoTipo(client, idTipoMovimientoCaja);
      idTipoMovimientoCaja = Number(tipoEgreso.id_tipo_movimiento_caja);
    }

    const insertResult = await client.query(
      `
        INSERT INTO public.cajas_movimientos (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_movimiento_caja,
          id_usuario_ejecutor, monto, observacion, referencia, fecha_movimiento, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING id_movimiento_caja
      `,
      [idSesionCaja, session.id_caja, session.id_sucursal, idTipoMovimientoCaja, scopeContext.idUsuario, monto, observacion, referencia]
    );

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Movimiento manual registrado correctamente.', id_movimiento_caja: Number(insertResult.rows[0].id_movimiento_caja) });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_MOVEMENT_CREATE_ERROR', 'No se pudo registrar el movimiento manual.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/sesiones/:id/movimientos', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, pool, null, true);
    const session = await fetchSessionBase(pool, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const result = await pool.query(`SELECT m.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre FROM public.cajas_movimientos m INNER JOIN public.cat_cajas_movimientos_tipos tipo ON tipo.id_tipo_movimiento_caja = m.id_tipo_movimiento_caja WHERE m.id_sesion_caja = $1 ORDER BY m.fecha_movimiento DESC, m.id_movimiento_caja DESC`, [idSesionCaja]);
    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_MOVEMENT_LIST_ERROR', 'No se pudieron obtener los movimientos de la sesion.');
  }
});

router.post('/ventas/cajas/sesiones/:id/incidencias', checkPermission(['VENTAS_CAJAS_INCIDENCIA_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idTipoIncidenciaCaja = parsePositiveInt(req.body.id_tipo_incidencia_caja);
    const montoRelacionado = parseNonNegativeAmount(req.body.monto_relacionado ?? 0);
    const descripcion = normalizeText(req.body.descripcion, 1000);
    if (!idSesionCaja || !idTipoIncidenciaCaja || !descripcion) throw createCajaError(400, 'VENTAS_CAJAS_INCIDENT_DATA_INVALID', 'Debe indicar una sesion, un tipo de incidencia y una descripcion valida.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await fetchSessionBase(client, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });

    const idEstadoAbierta = await getCatalogId(client, 'INCIDENT_STATES', 'ABIERTA');
    const insertResult = await client.query(
      `
        INSERT INTO public.cajas_incidencias (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_incidencia_caja, id_estado_incidencia_caja,
          id_usuario_reporta, id_usuario_responsable, monto_relacionado, descripcion,
          fecha_incidencia, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
        RETURNING id_incidencia_caja
      `,
      [idSesionCaja, session.id_caja, session.id_sucursal, idTipoIncidenciaCaja, idEstadoAbierta, scopeContext.idUsuario, session.id_usuario_responsable, montoRelacionado, descripcion]
    );

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Incidencia registrada correctamente.', id_incidencia_caja: Number(insertResult.rows[0].id_incidencia_caja) });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_INCIDENT_CREATE_ERROR', 'No se pudo registrar la incidencia.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/sesiones/:id/incidencias', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, pool, null, true);
    const session = await fetchSessionBase(pool, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const result = await pool.query(`SELECT i.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre, estado.codigo AS estado_codigo, estado.nombre AS estado_nombre FROM public.cajas_incidencias i INNER JOIN public.cat_cajas_incidencias_tipos tipo ON tipo.id_tipo_incidencia_caja = i.id_tipo_incidencia_caja INNER JOIN public.cat_cajas_incidencias_estados estado ON estado.id_estado_incidencia_caja = i.id_estado_incidencia_caja WHERE i.id_sesion_caja = $1 ORDER BY i.fecha_incidencia DESC, i.id_incidencia_caja DESC`, [idSesionCaja]);
    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_INCIDENT_LIST_ERROR', 'No se pudieron obtener las incidencias de la sesion.');
  }
});

router.patch('/ventas/cajas/incidencias/:id', checkPermission(['VENTAS_CAJAS_INCIDENCIA_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idIncidenciaCaja = parsePositiveInt(req.params.id);
    const idEstadoIncidenciaCaja = parseNullablePositiveInt(req.body.id_estado_incidencia_caja);
    const resolucionTexto = normalizeText(req.body.resolucion_texto, 1000);
    if (!idIncidenciaCaja) throw createCajaError(400, 'VENTAS_CAJAS_INCIDENT_ID_INVALID', 'El id de incidencia es invalido.');
    if (!idEstadoIncidenciaCaja && !resolucionTexto) throw createCajaError(400, 'VENTAS_CAJAS_INCIDENT_UPDATE_EMPTY', 'Debe enviar al menos un cambio para la incidencia.');

    const incidentResult = await client.query(`SELECT id_incidencia_caja, id_sucursal FROM public.cajas_incidencias WHERE id_incidencia_caja = $1 LIMIT 1 FOR UPDATE`, [idIncidenciaCaja]);
    if (incidentResult.rowCount === 0) throw createCajaError(404, 'VENTAS_CAJAS_INCIDENT_NOT_FOUND', 'La incidencia indicada no existe.');

    const scopeContext = await getScopeContext(req, client, null, true);
    assertSucursalAllowed(scopeContext, incidentResult.rows[0].id_sucursal);

    const updates = [];
    const params = [];
    if (idEstadoIncidenciaCaja) {
      params.push(idEstadoIncidenciaCaja);
      updates.push(`id_estado_incidencia_caja = $${params.length}`);
    }
    if (resolucionTexto) {
      params.push(resolucionTexto);
      updates.push(`resolucion_texto = $${params.length}`);
      updates.push('fecha_resolucion = NOW()');
    }
    updates.push('fecha_actualizacion = NOW()');
    params.push(idIncidenciaCaja);

    await client.query(`UPDATE public.cajas_incidencias SET ${updates.join(', ')} WHERE id_incidencia_caja = $${params.length}`, params);
    await client.query('COMMIT');
    return res.status(200).json({ message: 'Incidencia actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_INCIDENT_UPDATE_ERROR', 'No se pudo actualizar la incidencia.');
  } finally {
    client.release();
  }
});

export default router;

