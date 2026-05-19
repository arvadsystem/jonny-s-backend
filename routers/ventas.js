import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
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
  fetchAllowedSauceRowsByRecipeIdsQuery,
  fetchComboRecipeComponentsQuery,
  fetchPublicActiveSaucesQuery,
  fetchSauceRuleRowsByRecipeIdsQuery
} from './public_menu/publicMenuQueries.js';

const router = express.Router();

const VENTA_DIRECTA_LABEL = 'VENTA DIRECTA';
const TEGUCIGALPA_TZ = 'America/Tegucigalpa';
const VENTAS_DEFAULT_PAGE = 1;
const VENTAS_DEFAULT_PAGE_SIZE = 30;
const VENTAS_MAX_PAGE_SIZE = 50;
const VENTAS_HISTORY_ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMINISTRADOR', 'ADMIN']);
const VENTAS_HISTORY_CAJERO_ROLE = 'CAJERO';
const VENTAS_LIMIT_72H_CUTOFF_SQL = `(NOW() AT TIME ZONE '${TEGUCIGALPA_TZ}') - INTERVAL '72 hours'`;
const VENTAS_DESCUENTOS_PERMISSIONS = ['VENTAS_DESCUENTOS_CATALOGO_VER'];
const VENTAS_DESCUENTOS_WRITE_PERMISSIONS = [
  'VENTAS_DESCUENTOS_CATALOGO_CREAR',
  'VENTAS_DESCUENTOS_CATALOGO_EDITAR',
  'VENTAS_DESCUENTOS_CATALOGO_ESTADO_CAMBIAR'
];
const DESCUENTO_TIPO_KEYS = {
  MONTO_FIJO: 'MONTO_FIJO',
  PORCENTAJE: 'PORCENTAJE'
};
const DESCUENTO_ALCANCE_KEYS = {
  FACTURA_COMPLETA: 'FACTURA_COMPLETA',
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA',
  COMBO: 'COMBO'
};
const VENTAS_DESCUENTO_APLICAR_PERMISSION = 'VENTAS_DESCUENTO_APLICAR';
const ESTADO_PEDIDO_CODES = {
  PENDIENTE: new Set([
    'pendiente',
    'pendientes',
    'por_pagar',
    'pendiente_por_pagar',
    'pendiente_/_por_pagar',
    'pendientes_/_por_pagar'
  ]),
  EN_COCINA: new Set(['en_cocina']),
  EN_PREPARACION: new Set(['en_preparacion']),
  LISTO_PARA_ENTREGA: new Set(['listo_para_entrega']),
  CANCELADO: new Set(['cancelado', 'cancelada', 'anulado', 'anulada']),
  COMPLETADO: new Set([
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
  ]),
  NO_ENTREGADO: new Set(['no_entregado'])
};
const PEDIDO_MENU_PAYMENT_WINDOW_MINUTES = 10;
const PEDIDO_ESTADO_PAGO = Object.freeze({
  PENDIENTE_VALIDACION: 'PENDIENTE_VALIDACION',
  PAGADO_CONFIRMADO: 'PAGADO_CONFIRMADO',
  CANCELADO_TIMEOUT: 'CANCELADO_TIMEOUT'
});
const PEDIDO_PENDIENTE_ESTADO_PAGO = 'PENDIENTE_PAGO';
const PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO = 'PAGADO_CONFIRMADO';
const PEDIDO_PENDIENTE_ESTADO_DELIVERY = 'PENDIENTE';
const PEDIDO_PENDIENTE_CANALES = new Set(['LOCAL', 'TELEFONO', 'WHATSAPP']);
const PEDIDO_PENDIENTE_MODALIDADES = new Set(['CONSUMO_LOCAL', 'RECOGER', 'DELIVERY']);
const REVERSION_ALERT_EMAIL = 'gersonmz@jonnyshn.com';
const REVERSION_FAILURE_EMAIL_COOLDOWN_MS = 60 * 1000;
const reversionFailureEmailCooldown = new Map();
const VENTA_COMPLEMENTO_TIPO_SALSAS = 'SALSAS';
const WINGS_SAUCE_KEYWORDS = Object.freeze(['alita', 'alitas', 'tender', 'tenders']);
const schemaColumnCache = new Map();

const roundMoney = (value) => Number((Number(value || 0)).toFixed(2));
const normalizeTipoItem = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return ['PRODUCTO', 'RECETA', 'COMBO', 'MIXTO', 'ITEM'].includes(normalized)
    ? normalized
    : 'ITEM';
};

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseOptionalPositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parsePositiveInt(value);
};

const parseRequiredPositiveInt = (value, fieldName) => {
  const parsed = parsePositiveInt(value);
  if (!parsed) {
    return {
      ok: false,
      message: `${fieldName} debe ser un entero mayor a 0.`
    };
  }
  return { ok: true, value: parsed };
};

const parseNonNegativeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? roundMoney(parsed) : null;
};

const normalizeDescuentoAlcance = (value) => {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return Object.values(DESCUENTO_ALCANCE_KEYS).includes(normalized) ? normalized : null;
};

const parseOptionalDateTime = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

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
const mergeVentaWithFacturacion = (venta = {}, facturacion = {}) => {
  const emisor = facturacion?.emisor || {};
  const ticket = facturacion?.ticket || {};
  return {
    ...venta,
    facturacion: {
      emisor: {
        nombre_emisor: emisor?.nombre_emisor || "JONNY'S",
        rtn_emisor: emisor?.rtn_emisor || null,
        direccion_emisor: emisor?.direccion_emisor || null,
        telefono_emisor: emisor?.telefono_emisor || null,
        correo_emisor: emisor?.correo_emisor || null,
        logo_url: emisor?.logo_url || null
      },
      ticket: {
        ancho_ticket_mm: Number(ticket?.ancho_ticket_mm) === 58 ? 58 : 80,
        mostrar_logo_ticket: Boolean(ticket?.mostrar_logo_ticket),
        mostrar_rtn: Boolean(ticket?.mostrar_rtn),
        mostrar_direccion: Boolean(ticket?.mostrar_direccion),
        mostrar_telefono: Boolean(ticket?.mostrar_telefono),
        mostrar_correo: Boolean(ticket?.mostrar_correo),
        texto_encabezado_ticket: ticket?.texto_encabezado_ticket || null,
        texto_pie_ticket: ticket?.texto_pie_ticket || 'Gracias por su compra'
      },
      fiscal: {
        modo_fiscal: 'NO_INTEGRADO',
        cai: '0',
        numero_factura_fiscal: '0'
      }
    },
    nombre_emisor: emisor?.nombre_emisor || "JONNY'S",
    rtn_emisor: emisor?.rtn_emisor || null,
    sucursal_direccion: emisor?.direccion_emisor || null,
    sucursal_telefono: emisor?.telefono_emisor || null,
    sucursal_correo: emisor?.correo_emisor || null,
    logo_url: emisor?.logo_url || null,
    ancho_ticket_mm: Number(ticket?.ancho_ticket_mm) === 58 ? 58 : 80,
    mostrar_logo_ticket: Boolean(ticket?.mostrar_logo_ticket),
    mostrar_rtn: Boolean(ticket?.mostrar_rtn),
    mostrar_direccion: Boolean(ticket?.mostrar_direccion),
    mostrar_telefono: Boolean(ticket?.mostrar_telefono),
    mostrar_correo: Boolean(ticket?.mostrar_correo),
    texto_encabezado_ticket: ticket?.texto_encabezado_ticket || null,
    texto_pie_ticket: ticket?.texto_pie_ticket || 'Gracias por su compra',
    modo_fiscal: 'NO_INTEGRADO',
    cai: '0',
    numero_factura_fiscal: '0',
    id_rango_cai: null
  };
};
const sendVentasInternalError = (
  res,
  message = 'No se pudo procesar la solicitud de ventas.'
) => res.status(500).json({ error: true, message });

const parseBooleanInput = (value) => {
  if (value === true || value === false) return { ok: true, value };
  if (value === 1 || value === 0) return { ok: true, value: value === 1 };
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'si', 'yes', 'y', 'activo'].includes(normalized)) {
      return { ok: true, value: true };
    }
    if (['false', '0', 'no', 'n', 'inactivo'].includes(normalized)) {
      return { ok: true, value: false };
    }
  }
  return { ok: false, value: false };
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const formatVentaNumero = (idVenta) => `VTA-${String(idVenta).padStart(5, '0')}`;
const resolveVentaNumero = (row) =>
  String(row?.codigo_venta || '').trim() || formatVentaNumero(row?.id_factura);

const normalizeClienteNombre = (cliente) => {
  const nombrePersona = [cliente?.nombre, cliente?.apellido].filter(Boolean).join(' ').trim();
  if (nombrePersona) return nombrePersona;
  if (cliente?.nombre_empresa) return cliente.nombre_empresa;
  return 'Consumidor final';
};

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

const normalizeSearchText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
const sortSauceOptions = (items) => (
  [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const orderA = Number(left?.orden || 0);
    const orderB = Number(right?.orden || 0);
    if (orderA !== orderB) return orderA - orderB;
    return String(left?.nombre || '').localeCompare(String(right?.nombre || ''), 'es', {
      sensitivity: 'base'
    });
  })
);
const inferSauceUnitsBaseFromText = (...sources) => {
  const text = normalizeSearchText(sources.filter(Boolean).join(' '));
  if (!text) return 1;
  const containsKeyword = WINGS_SAUCE_KEYWORDS.some((keyword) => text.includes(keyword));
  if (!containsKeyword) return 1;
  const match =
    text.match(/\b(\d{1,3})\s*(?:alitas?|tenders?)\b/i) ||
    text.match(/\b(\d{1,3})\s*(?:uds?|unidades?|pzas?|piezas?)\b/i) ||
    text.match(/\((\d{1,3})\s*(?:uds?|unidades?|pzas?|piezas?)\)/i);
  const units = Number(match?.[1] || 0);
  if (!Number.isFinite(units) || units <= 0) return 1;
  return Math.max(1, Math.floor(units));
};
const calculateFallbackWingSauceRequirement = ({ nombre = '', descripcion = '', quantity = 1 }) => {
  const baseUnits = inferSauceUnitsBaseFromText(nombre, descripcion);
  if (baseUnits <= 1) return 0;
  const totalUnits = Math.max(1, Number(quantity || 1)) * baseUnits;
  return Math.max(0, Math.ceil(totalUnits / 6));
};
const findMatchingSalsaRule = (rules, unidades) => {
  const units = Number(unidades);
  if (!Number.isFinite(units) || units <= 0) return null;
  const orderedRules = [...(Array.isArray(rules) ? rules : [])].sort((left, right) => (
    Number(left?.min_unidades || 0) - Number(right?.min_unidades || 0)
  ));
  return orderedRules.find((rule) => {
    const min = Number(rule?.min_unidades || 0);
    const max = rule?.max_unidades === null || rule?.max_unidades === undefined
      ? null
      : Number(rule.max_unidades);
    if (!Number.isFinite(min) || units < min) return false;
    if (max !== null && Number.isFinite(max) && units > max) return false;
    return true;
  }) || null;
};
const parseComplementosPayload = (value) => {
  if (value === undefined || value === null) return { ok: true, data: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: 'complementos debe ser una lista valida.' };
  }
  const dedupe = new Set();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return { ok: false, message: 'Cada complemento debe ser un objeto valido.' };
    }
    const idComplemento = parseOptionalPositiveInt(entry.id_complemento);
    if (!idComplemento) {
      return { ok: false, message: 'Cada complemento debe incluir id_complemento entero mayor a 0.' };
    }
    dedupe.add(Number(idComplemento));
  }
  return { ok: true, data: [...dedupe].sort((a, b) => a - b) };
};
const buildComplementSnapshot = (line) => {
  const selected = Array.isArray(line?.complementos_detalle) ? line.complementos_detalle : [];
  if (selected.length === 0) return null;
  return {
    tipo: VENTA_COMPLEMENTO_TIPO_SALSAS,
    seleccion: selected.map((entry) => ({
      id_complemento: Number(entry?.id_complemento || 0),
      id_salsa: Number(entry?.id_salsa || entry?.id_complemento || 0),
      nombre: String(entry?.nombre || 'Complemento').trim()
    })).filter((entry) => entry.id_complemento > 0)
  };
};
const buildComplementLineConfig = (line) => {
  const selected = Array.isArray(line?.complementos_detalle) ? line.complementos_detalle : [];
  const metadata = line?.complementos_metadata;
  if (!selected.length && !metadata?.requiere_complementos) return null;
  return {
    tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
    requiere_complementos: Boolean(metadata?.requiere_complementos),
    minimo_complementos: Number(metadata?.minimo_complementos || 0),
    maximo_complementos: Number(metadata?.maximo_complementos || 0),
    complementos: selected.map((entry) => ({
      id_complemento: Number(entry?.id_complemento || 0),
      id_salsa: Number(entry?.id_salsa || entry?.id_complemento || 0),
      nombre: String(entry?.nombre || 'Complemento').trim()
    })).filter((entry) => entry.id_complemento > 0)
  };
};
const buildRecipeSauceRequirement = ({ recipeName = '', recipeDescription = '', rules = [], quantity = 1 }) => {
  const unitsBase = Math.max(1, inferSauceUnitsBaseFromText(recipeName, recipeDescription));
  const units = Math.max(1, Number(quantity || 1)) * unitsBase;
  const rule = findMatchingSalsaRule(rules, units);
  if (rule) {
    return Number(rule?.salsas_requeridas || 0);
  }
  // AM: fallback acotado solo para familias alitas/tenders cuando no hay reglas formales.
  return calculateFallbackWingSauceRequirement({
    nombre: recipeName,
    descripcion: recipeDescription,
    quantity
  });
};
const resolveRecetaComplementMetadata = ({ receta = {}, quantity = 1, allowedSauces = [], rules = [], fallbackSauces = [] }) => {
  const required = Math.max(0, buildRecipeSauceRequirement({
    recipeName: receta?.nombre_receta,
    recipeDescription: receta?.descripcion,
    rules,
    quantity
  }));
  let available = sortSauceOptions(allowedSauces);
  if (required > 0 && available.length === 0) {
    available = sortSauceOptions(fallbackSauces);
  }
  return {
    requiere_complementos: required > 0,
    tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
    minimo_complementos: required,
    maximo_complementos: required,
    complementos_disponibles: available
  };
};
const resolveComboComplementMetadata = ({ combo = {}, quantity = 1, components = [], saucesByRecipe = new Map(), rulesByRecipe = new Map(), fallbackSauces = [] }) => {
  const unionSauces = new Map();
  let required = 0;
  for (const component of Array.isArray(components) ? components : []) {
    const idReceta = Number(component?.id_receta || 0);
    if (!idReceta) continue;
    const allowed = saucesByRecipe.get(idReceta) || [];
    for (const sauce of allowed) {
      const key = Number(sauce?.id_salsa || 0);
      if (key > 0) unionSauces.set(key, sauce);
    }
    const rules = rulesByRecipe.get(idReceta) || [];
    const multiplier = Math.max(1, Number(component?.multiplicador || 1));
    required += Math.max(0, buildRecipeSauceRequirement({
      recipeName: component?.nombre_receta,
      recipeDescription: component?.nombre_receta,
      rules,
      quantity: Math.max(1, Number(quantity || 1)) * multiplier
    }));
  }
  let available = sortSauceOptions(Array.from(unionSauces.values()));
  if (required > 0 && available.length === 0) {
    available = sortSauceOptions(fallbackSauces);
  }
  return {
    requiere_complementos: required > 0,
    tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
    minimo_complementos: required,
    maximo_complementos: required,
    complementos_disponibles: available
  };
};

const normalizeRoleName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

const getRequestRoleSet = (req) =>
  new Set(
    (Array.isArray(req.user?.roles) ? req.user.roles : [])
      .map(normalizeRoleName)
      .filter(Boolean)
  );

const parseBoundedPositiveInt = (value, { fallback, min = 1, max = Number.MAX_SAFE_INTEGER }) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const parseOptionalDateInput = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '__INVALID_DATE__';
  return normalized;
};

const coercePositiveIntArray = (value) =>
  [...new Set((Array.isArray(value) ? value : [])
    .map((item) => Number.parseInt(String(item ?? ''), 10))
    .filter((item) => Number.isInteger(item) && item > 0))];

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

const parseBooleanish = (value) =>
  value === true || value === 'true' || value === 1 || value === '1';

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

const parseEntityIdentifier = (value, fieldName) => {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 0 ||
    value === '0'
  ) {
    return { ok: true, value: null };
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      message: `${fieldName} debe ser un entero mayor a 0 o null.`
    };
  }

  return { ok: true, value: parsed };
};

const normalizeObservation = (value) => {
  if (value === undefined || value === null) return null;

  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  return normalized.slice(0, 200);
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

const inferKitchenItemQuantity = (rawSubtotal, rawUnitPrice) => {
  const subtotal = Number(rawSubtotal || 0);
  const unitPrice = Number(rawUnitPrice || 0);

  if (!Number.isFinite(subtotal) || subtotal <= 0) return 1;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 1;

  const inferred = Math.round(subtotal / unitPrice);
  return Number.isInteger(inferred) && inferred > 0 ? inferred : 1;
};

const buildDirectSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    tipo_item: String(row.tipo_item || 'PRODUCTO').toUpperCase(),
    nombre_item: row.nombre_item || row.nombre_producto || 'Producto',
    nombre_producto: row.nombre_producto || row.nombre_item || 'Producto',
    cantidad: Number(row.cantidad ?? 0) || 0,
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    observacion: null
  }));

const buildKitchenSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    nombre_item: row.nombre_item || 'Item de cocina',
    nombre_producto: row.nombre_item || 'Item de cocina',
    cantidad:
      Number(row.cantidad ?? 0) > 0
        ? Number(row.cantidad)
        : inferKitchenItemQuantity(row.sub_total, row.precio_unitario),
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    observacion: normalizeObservation(row.observacion)
  }));

const normalizeVentaItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Debe enviar al menos un item en la venta.' };
  }

  const normalized = [];

  for (const item of items) {
    if (!isPlainObject(item)) {
      return { ok: false, message: 'Cada item debe ser un objeto valido.' };
    }

    const productoResult = parseEntityIdentifier(item.id_producto, 'id_producto');
    if (!productoResult.ok) return { ok: false, message: productoResult.message };

    const comboResult = parseEntityIdentifier(item.id_combo, 'id_combo');
    if (!comboResult.ok) return { ok: false, message: comboResult.message };

    const recetaResult = parseEntityIdentifier(item.id_receta, 'id_receta');
    if (!recetaResult.ok) return { ok: false, message: recetaResult.message };

    const cantidad = parsePositiveInt(item.cantidad);
    if (!cantidad) {
      return {
        ok: false,
        message: 'Cada item debe incluir cantidad entera mayor a 0.'
      };
    }

    const presentIds = [
      ['PRODUCTO', productoResult.value],
      ['COMBO', comboResult.value],
      ['RECETA', recetaResult.value]
    ].filter(([, value]) => value !== null);

    if (presentIds.length !== 1) {
      return {
        ok: false,
        message:
          'Cada item debe incluir exactamente uno entre id_producto, id_combo o id_receta.'
      };
    }

    const [kind, entityId] = presentIds[0];
    const idDescuentoCatalogoLinea = parseOptionalPositiveInt(item.id_descuento_catalogo);
    if (
      item.id_descuento_catalogo !== undefined &&
      item.id_descuento_catalogo !== null &&
      !idDescuentoCatalogoLinea
    ) {
      return {
        ok: false,
        message: 'id_descuento_catalogo por linea debe ser entero mayor a 0.'
      };
    }

    const complementosResult = parseComplementosPayload(item.complementos);
    if (!complementosResult.ok) {
      return { ok: false, message: complementosResult.message };
    }

    normalized.push({
      kind,
      cantidad,
      id_producto: kind === 'PRODUCTO' ? entityId : null,
      id_combo: kind === 'COMBO' ? entityId : null,
      id_receta: kind === 'RECETA' ? entityId : null,
      observacion: normalizeObservation(item.observacion),
      id_descuento_catalogo_linea: idDescuentoCatalogoLinea,
      complementos: complementosResult.data
    });
  }

  return { ok: true, data: normalized };
};

const fetchProductoMap = async (client, ids, options = {}) => {
  if (!ids.length) return new Map();

  const forUpdateClause = options?.forUpdate ? 'FOR UPDATE' : '';
  const result = await client.query(
    `
      SELECT id_producto, nombre_producto, precio, estado, cantidad, id_almacen
      FROM productos
      WHERE id_producto = ANY($1::int[])
      ${forUpdateClause}
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_producto), row]));
};

const fetchComboMap = async (client, ids) => {
  if (!ids.length) return new Map();

  const result = await client.query(
    `
      SELECT id_combo, descripcion, precio, estado
      FROM combos
      WHERE id_combo = ANY($1::int[])
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_combo), row]));
};

const fetchRecetaMap = async (client, ids) => {
  if (!ids.length) return new Map();

  const result = await client.query(
    `
      SELECT
        r.id_receta,
        r.nombre_receta,
        r.descripcion,
        r.estado,
        r.precio
      FROM recetas r
      WHERE r.id_receta = ANY($1::int[])
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_receta), row]));
};

const fetchClienteInfo = async (client, idCliente) => {
  if (!idCliente) return null;

  const result = await client.query(
    `
      SELECT
        c.id_cliente,
        c.estado,
        c.id_tipo_cliente,
        p.nombre,
        p.apellido,
        e.nombre_empresa
      FROM clientes c
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
      WHERE c.id_cliente = $1
      LIMIT 1
    `,
    [idCliente]
  );

  return result.rows[0] || null;
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
        td.estado AS tipo_estado
      FROM descuentos_catalogos dc
      INNER JOIN tipo_descuentos td
        ON td.id_tipo_descuento = dc.id_tipo_descuento
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
    if (alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO && Number(discountCatalog.id_producto || 0) !== Number(line.id_producto || 0)) {
      return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ITEM_NO_APLICA', message: 'El descuento de producto no aplica a esta linea.' };
    }
    if (alcance === DESCUENTO_ALCANCE_KEYS.RECETA && Number(discountCatalog.id_receta || 0) !== Number(line.id_receta || 0)) {
      return { ok: false, status: 409, code: 'VENTAS_DESCUENTO_ITEM_NO_APLICA', message: 'El descuento de receta no aplica a esta linea.' };
    }
    if (alcance === DESCUENTO_ALCANCE_KEYS.COMBO && Number(discountCatalog.id_combo || 0) !== Number(line.id_combo || 0)) {
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

const resolveSucursalId = async (client, requestedId) => {
  if (!requestedId) return null;

  const result = await client.query(
    'SELECT id_sucursal FROM sucursales WHERE id_sucursal = $1 AND COALESCE(estado, true) = true LIMIT 1',
    [requestedId]
  );
  return result.rowCount > 0 ? requestedId : null;
};

const resolveMetodoPago = async (client, metodoPagoRaw) => {
  const normalizedInput = String(metodoPagoRaw ?? '').trim();
  if (!normalizedInput) return null;

  const result = await client.query(
    `
      SELECT
        id_metodo_pago,
        codigo,
        nombre,
        COALESCE(afecta_efectivo, false) AS afecta_efectivo
      FROM cat_metodos_pago
      WHERE COALESCE(estado, true) = true
        AND (
          UPPER(TRIM(codigo)) = UPPER($1)
          OR LOWER(TRIM(nombre)) = LOWER($1)
        )
      LIMIT 1
    `,
    [normalizedInput]
  );

  return result.rows[0] || null;
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

  const estadoResult = await client.query(
    `
      SELECT id_estado_sesion_caja
      FROM cat_cajas_sesiones_estados
      WHERE UPPER(TRIM(codigo)) = 'ABIERTA'
      LIMIT 1
    `
  );
  const idEstadoAbierta = Number(estadoResult.rows?.[0]?.id_estado_sesion_caja || 0) || null;
  if (!idEstadoAbierta) {
    return { ok: false, reason: 'OPEN_STATE_NOT_FOUND' };
  }

  const requestedSessionId = parseOptionalPositiveInt(idSesionCaja);
  const params = [idSucursal, idUsuario, idEstadoAbierta];
  let requestedFilter = '';

  if (requestedSessionId) {
    params.push(requestedSessionId);
    requestedFilter = `AND cs.id_sesion_caja = $${params.length}`;
  }

  const result = await client.query(
    isSuperAdmin
      ? `
        SELECT
          cs.id_caja,
          cs.id_sesion_caja,
          cs.id_sucursal,
          csp.id_participacion_caja,
          crp.codigo AS rol_participacion,
          NULL::bigint AS id_caja_usuario_autorizado
        FROM cajas_sesiones cs
        INNER JOIN cajas_sesiones_participantes csp
          ON csp.id_sesion_caja = cs.id_sesion_caja
         AND csp.id_usuario = $2
         AND COALESCE(csp.activo, true) = true
        INNER JOIN cat_cajas_roles_participacion crp
          ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
        WHERE cs.id_sucursal = $1
          AND cs.id_estado_sesion_caja = $3
          AND UPPER(TRIM(crp.codigo)) IN ('RESPONSABLE', 'AUXILIAR')
          ${requestedFilter}
        ORDER BY cs.id_sesion_caja DESC
        LIMIT 1
      `
      : `
        SELECT
          cs.id_caja,
          cs.id_sesion_caja,
          cs.id_sucursal,
          csp.id_participacion_caja,
          crp.codigo AS rol_participacion,
          cua.id_caja_usuario_autorizado
        FROM cajas_sesiones cs
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
          AND cs.id_estado_sesion_caja = $3
          ${requestedFilter}
        ORDER BY cs.id_sesion_caja DESC
        LIMIT 1
      `,
    params
  );

  if (result.rowCount === 0) {
    if (requestedSessionId) {
      const sessionExistsResult = await client.query(
        `
          SELECT
            cs.id_sesion_caja,
            cs.id_sucursal,
            cs.id_estado_sesion_caja,
            EXISTS (
              SELECT 1
              FROM cajas_sesiones_participantes csp
              WHERE csp.id_sesion_caja = cs.id_sesion_caja
                AND csp.id_usuario = $2
                AND COALESCE(csp.activo, true) = true
            ) AS has_active_participation
          FROM cajas_sesiones cs
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
      if (!Boolean(sessionRow.has_active_participation)) {
        return { ok: false, reason: 'SESSION_PARTICIPATION_REQUIRED' };
      }
      return { ok: false, reason: 'SESSION_AUTHORIZATION_REQUIRED' };
    }

    return { ok: false, reason: 'NO_ACTIVE_SESSION' };
  }

  return {
    ok: true,
    data: result.rows[0]
  };
};

const fetchEstadoPedidoRows = async (client) => {
  const result = await client.query(
    'SELECT id_estado_pedido, descripcion FROM estados_pedido ORDER BY id_estado_pedido'
  );
  return result.rows;
};

const resolveEstadoPedidoIdByCode = async (client, code) => {
  const aliases = ESTADO_PEDIDO_CODES[code];
  if (!aliases || aliases.size === 0) return null;

  const rows = await fetchEstadoPedidoRows(client);
  const match = rows.find((row) => aliases.has(normalizeTextKey(row.descripcion)));
  return match?.id_estado_pedido ?? null;
};

const resolveRequestedEstadoPedidoId = async (client, requestedId) => {
  if (!requestedId) return null;

  const result = await client.query(
    'SELECT id_estado_pedido FROM estados_pedido WHERE id_estado_pedido = $1 LIMIT 1',
    [requestedId]
  );

  return result.rowCount > 0 ? requestedId : null;
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

const buildVentaComplementContext = async ({ client, normalizedItems }) => {
  const recipeIds = [...new Set(
    (Array.isArray(normalizedItems) ? normalizedItems : [])
      .filter((item) => item.kind === 'RECETA')
      .map((item) => Number(item.id_receta || 0))
      .filter((id) => id > 0)
  )];
  const comboIds = [...new Set(
    (Array.isArray(normalizedItems) ? normalizedItems : [])
      .filter((item) => item.kind === 'COMBO')
      .map((item) => Number(item.id_combo || 0))
      .filter((id) => id > 0)
  )];

  const comboComponents = await fetchComboRecipeComponentsQuery(comboIds, client);
  const componentRecipeIds = comboComponents
    .map((row) => Number(row?.id_receta || 0))
    .filter((id) => id > 0);
  const allRecipeIds = [...new Set([...recipeIds, ...componentRecipeIds])];

  const [allowedSauceRows, sauceRuleRows, fallbackSauces] = await Promise.all([
    fetchAllowedSauceRowsByRecipeIdsQuery(allRecipeIds, client),
    fetchSauceRuleRowsByRecipeIdsQuery(allRecipeIds, client),
    fetchPublicActiveSaucesQuery(client)
  ]);

  const saucesByRecipe = new Map();
  for (const row of allowedSauceRows) {
    const recipeId = Number(row?.id_receta || 0);
    if (!recipeId) continue;
    if (!saucesByRecipe.has(recipeId)) saucesByRecipe.set(recipeId, []);
    saucesByRecipe.get(recipeId).push({
      id_complemento: Number(row.id_salsa),
      id_salsa: Number(row.id_salsa),
      nombre: String(row.nombre || 'Salsa').trim(),
      nivel_picante: Number(row.nivel_picante || 0),
      orden: Number(row.orden || 0),
      disponible: row.disponible !== false
    });
  }

  const rulesByRecipe = new Map();
  for (const row of sauceRuleRows) {
    const recipeId = Number(row?.id_receta || 0);
    if (!recipeId) continue;
    if (!rulesByRecipe.has(recipeId)) rulesByRecipe.set(recipeId, []);
    rulesByRecipe.get(recipeId).push({
      min_unidades: Number(row?.min_unidades || 0),
      max_unidades:
        row?.max_unidades === null || row?.max_unidades === undefined ? null : Number(row.max_unidades),
      salsas_requeridas: Number(row?.salsas_requeridas || 0)
    });
  }

  const comboComponentsByCombo = new Map();
  for (const row of comboComponents) {
    const comboId = Number(row?.id_combo || 0);
    if (!comboId) continue;
    if (!comboComponentsByCombo.has(comboId)) comboComponentsByCombo.set(comboId, []);
    comboComponentsByCombo.get(comboId).push({
      id_receta: Number(row?.id_receta || 0),
      multiplicador: Math.max(1, Number(row?.multiplicador || 1)),
      nombre_receta: String(row?.nombre_receta || '').trim()
    });
  }

  const normalizedFallbackSauces = sortSauceOptions((Array.isArray(fallbackSauces) ? fallbackSauces : []).map((row) => ({
    id_complemento: Number(row.id_salsa),
    id_salsa: Number(row.id_salsa),
    nombre: String(row.nombre || 'Salsa').trim(),
    nivel_picante: Number(row.nivel_picante || 0),
    orden: Number(row.orden || 0),
    disponible: true
  })));

  return {
    saucesByRecipe,
    rulesByRecipe,
    comboComponentsByCombo,
    fallbackSauces: normalizedFallbackSauces
  };
};

const resolveLineComplementos = ({ item, receta, combo, context }) => {
  if (item.kind === 'PRODUCTO') {
    if (Array.isArray(item.complementos) && item.complementos.length > 0) {
      return { ok: false, message: 'Uno o m?s complementos seleccionados no son v?lidos para este item.' };
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
  for (const idRaw of selectedIds) {
    const id = Number(idRaw || 0);
    const found = allowedMap.get(id);
    if (!found || found.disponible === false) {
      return { ok: false, message: 'Uno o m?s complementos seleccionados no son v?lidos para este item.' };
    }
    selected.push({ id_complemento: id, id_salsa: id, nombre: String(found.nombre || 'Salsa').trim() });
  }

  const min = Math.max(0, Number(metadata.minimo_complementos || 0));
  const max = Math.max(min, Number(metadata.maximo_complementos || 0));
  if (metadata.requiere_complementos && selected.length < min) {
    return { ok: false, message: 'Debe seleccionar los complementos requeridos para este item.' };
  }
  if (max > 0 && selected.length > max) {
    return { ok: false, message: 'Debe seleccionar los complementos requeridos para este item.' };
  }
  if (!metadata.requiere_complementos && selected.length > 0) {
    return { ok: false, message: 'Uno o m?s complementos seleccionados no son v?lidos para este item.' };
  }

  return { ok: true, metadata, selected };
};
const hydrateVentaLines = async (client, normalizedItems) => {
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

  const [productoMap, comboMap, recetaMap, complementContext] = await Promise.all([
    fetchProductoMap(client, productoIds, { forUpdate: true }),
    fetchComboMap(client, comboIds),
    fetchRecetaMap(client, recetaIds),
    buildVentaComplementContext({ client, normalizedItems })
  ]);

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
        context: complementContext
      });
      if (!complementosResult.ok) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: complementosResult.message }
        };
      }
      lines.push({
        kind: 'PRODUCTO',
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
        observacion: item.observacion,
        complementos_metadata: complementosResult.metadata,
        complementos_detalle: complementosResult.selected
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
        context: complementContext
      });
      if (!complementosResult.ok) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: complementosResult.message }
        };
      }
      lines.push({
        kind: 'COMBO',
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
        observacion: item.observacion,
        complementos_metadata: complementosResult.metadata,
        complementos_detalle: complementosResult.selected
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
      context: complementContext
    });
    if (!complementosResult.ok) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: complementosResult.message }
      };
    }
    lines.push({
      kind: 'RECETA',
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
      observacion: item.observacion,
      complementos_metadata: complementosResult.metadata,
      complementos_detalle: complementosResult.selected
    });
    subTotals.push(subTotal);
  }

  return { ok: true, data: { lines, subTotals } };
};

const normalizePedidoCatalogCode = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

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

  return items.map((item, index) => {
    if (!isPlainObject(item)) return item;
    if (item.id_descuento_catalogo !== undefined && item.id_descuento_catalogo !== null && String(item.id_descuento_catalogo).trim() !== '') return item;
    const descuentoLinea = descuentosLinea[index];
    if (!isPlainObject(descuentoLinea)) return item;
    if (descuentoLinea.id_descuento_catalogo === undefined || descuentoLinea.id_descuento_catalogo === null || String(descuentoLinea.id_descuento_catalogo).trim() === '') return item;
    return { ...item, id_descuento_catalogo: descuentoLinea.id_descuento_catalogo };
  });
};

const resolveActiveCatalogCode = async ({ client, tableName, idColumn, code }) => {
  const result = await client.query(
    '\n      SELECT ' + idColumn + ' AS id, codigo\n      FROM public.' + tableName + '\n      WHERE UPPER(TRIM(codigo)) = $1\n        AND COALESCE(estado, true) = true\n      LIMIT 1\n    ',
    [code]
  );
  const row = result.rows?.[0];
  return row ? { id: Number(row.id), codigo: String(row.codigo || code).trim().toUpperCase() } : null;
};

const mapPedidoPendienteSessionStatus = (reason) => reason === 'SESSION_SCOPE_MISMATCH' ? 403 : 409;

const buildPedidoPendientePayload = async ({ client, body, userId, sucursalScope, canApplyDiscount }) => {
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
    costoEnvio = parseNonNegativeNumber(body.delivery.costo_envio);
    if (costoEnvio === null) return { ok: false, status: 400, body: { error: true, message: 'delivery.costo_envio debe ser numerico mayor o igual a 0.' } };
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

  const [canalCatalog, modalidadCatalog, estadoPagoCatalog, motivoPagoCatalog, deliveryEstadoCatalog] = await Promise.all([
    resolveActiveCatalogCode({ client, tableName: 'cat_pedidos_canales', idColumn: 'id_canal_pedido', code: canal }),
    resolveActiveCatalogCode({ client, tableName: 'cat_pedidos_modalidades_entrega', idColumn: 'id_modalidad_entrega', code: modalidad }),
    resolveActiveCatalogCode({ client, tableName: 'cat_pedidos_estados_pago', idColumn: 'id_estado_pago_pedido', code: PEDIDO_PENDIENTE_ESTADO_PAGO }),
    resolveActiveCatalogCode({ client, tableName: 'cat_pedidos_motivos_pago_pendiente', idColumn: 'id_motivo_pago_pendiente', code: motivoPagoPendiente }),
    modalidad === 'DELIVERY' ? resolveActiveCatalogCode({ client, tableName: 'cat_delivery_estados', idColumn: 'id_estado_delivery', code: PEDIDO_PENDIENTE_ESTADO_DELIVERY }) : Promise.resolve(null)
  ]);
  if (!canalCatalog || !modalidadCatalog || !estadoPagoCatalog || !motivoPagoCatalog || (modalidad === 'DELIVERY' && !deliveryEstadoCatalog)) {
    return { ok: false, status: 409, body: { error: true, message: 'No se encontraron catalogos requeridos para crear el pedido pendiente.' } };
  }

  const normalizedItemsResult = normalizeVentaItems(buildPedidoPendienteItemsBody(body));
  if (!normalizedItemsResult.ok) return { ok: false, status: 400, body: { error: true, message: normalizedItemsResult.message } };
  const hydratedResult = await hydrateVentaLines(client, normalizedItemsResult.data);
  if (!hydratedResult.ok) return hydratedResult;

  const { lines, subTotals } = hydratedResult.data;
  const subtotalBruto = roundMoney(subTotals.reduce((sum, value) => sum + value, 0));
  const idDescuentoCatalogo = parseOptionalPositiveInt(body.id_descuento_catalogo);
  const descuentoLegacyInput = parseNonNegativeNumber(body.descuento ?? 0);
  if (body.id_descuento_catalogo !== undefined && body.id_descuento_catalogo !== null && !idDescuentoCatalogo) return { ok: false, status: 400, body: { error: true, message: 'id_descuento_catalogo debe ser un entero mayor a 0.' } };
  if (body.descuento !== undefined && descuentoLegacyInput === null) return { ok: false, status: 400, body: { error: true, message: 'descuento debe ser un numero mayor o igual a 0.' } };

  let descuentoTotal = descuentoLegacyInput || 0;
  let appliedDiscountCatalog = null;
  const hasGlobalCatalogDiscount = Boolean(idDescuentoCatalogo);
  const hasLegacyDiscount = Number(descuentoLegacyInput || 0) > 0;
  const hasLineDiscountAttempt = lines.some((line) => Number(line.id_descuento_catalogo_linea || 0) > 0);
  const hasDiscountAttempt = hasGlobalCatalogDiscount || hasLegacyDiscount || hasLineDiscountAttempt;
  if (hasDiscountAttempt && !canApplyDiscount) return { ok: false, status: 403, body: { error: true, code: 'VENTAS_DESCUENTO_NO_AUTORIZADO', message: 'No tienes permiso para aplicar descuentos en ventas.' } };
  if ((hasGlobalCatalogDiscount || hasLegacyDiscount) && hasLineDiscountAttempt) return { ok: false, status: 409, body: { error: true, code: 'VENTAS_DESCUENTO_ACUMULACION_NO_PERMITIDA', message: 'No se permite combinar descuento global con descuentos por linea.' } };

  if (idDescuentoCatalogo) {
    const discountCatalog = await fetchDiscountCatalogById(client, idDescuentoCatalogo);
    const validatedGlobalDiscount = validateCatalogDiscountAvailability({ discountCatalog, idSucursal, subtotalObjetivo: subtotalBruto, alcanceEsperado: DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA });
    if (!validatedGlobalDiscount.ok) return { ok: false, status: validatedGlobalDiscount.status, body: { error: true, code: validatedGlobalDiscount.code, message: validatedGlobalDiscount.message } };
    descuentoTotal = validatedGlobalDiscount.montoCalculado;
    appliedDiscountCatalog = { id_descuento_catalogo: Number(discountCatalog.id_descuento_catalogo) };
  }
  if (descuentoTotal > subtotalBruto) return { ok: false, status: 400, body: { error: true, message: 'El descuento no puede ser mayor al subtotal.' } };

  const descuentosPorLinea = allocateDiscounts(subTotals, descuentoTotal);
  const descuentosLineaMap = new Map();
  const descuentosCatalogoLineaMap = new Map();
  if (hasLineDiscountAttempt) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const idDescuentoLinea = parseOptionalPositiveInt(line.id_descuento_catalogo_linea);
      if (!idDescuentoLinea) continue;
      const discountCatalog = await fetchDiscountCatalogById(client, idDescuentoLinea);
      const validatedLineDiscount = validateCatalogDiscountAvailability({ discountCatalog, idSucursal, subtotalObjetivo: line.sub_total, alcanceEsperado: line.kind, line });
      if (!validatedLineDiscount.ok) return { ok: false, status: validatedLineDiscount.status, body: { error: true, code: validatedLineDiscount.code, message: validatedLineDiscount.message } };
      descuentosLineaMap.set(index, validatedLineDiscount.montoCalculado);
      descuentosCatalogoLineaMap.set(index, Number(discountCatalog.id_descuento_catalogo));
    }
  }

  const finalizedLines = lines.map((line, index) => ({
    ...line,
    id_descuento_catalogo: hasLineDiscountAttempt ? descuentosCatalogoLineaMap.get(index) || null : appliedDiscountCatalog?.id_descuento_catalogo ?? null,
    descuento: hasLineDiscountAttempt ? roundMoney(descuentosLineaMap.get(index) || 0) : descuentosPorLinea[index],
    total_linea: hasLineDiscountAttempt ? roundMoney(line.sub_total - roundMoney(descuentosLineaMap.get(index) || 0)) : roundMoney(line.sub_total - descuentosPorLinea[index])
  }));

  const subtotal = roundMoney(finalizedLines.reduce((sum, line) => sum + line.total_linea, 0));
  const isv = roundMoney(subtotal * 0.15);
  const total = roundMoney(subtotal + isv + costoEnvio);
  const idEstadoPedido = await resolveEstadoPedidoIdByCode(client, 'EN_COCINA');
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
      subtotal,
      isv,
      costo_envio: costoEnvio,
      total
    }
  };
};
const resolveMetodoPagoRegistroPedido = async (client, { idMetodoPago, metodoPagoRaw }) => {
  const parsedId = parseOptionalPositiveInt(idMetodoPago);
  if (idMetodoPago !== undefined && idMetodoPago !== null && !parsedId) return null;

  if (parsedId) {
    const result = await client.query(
      `
        SELECT
          id_metodo_pago,
          codigo,
          nombre,
          COALESCE(afecta_efectivo, false) AS afecta_efectivo
        FROM cat_metodos_pago
        WHERE id_metodo_pago = $1
          AND COALESCE(estado, true) = true
        LIMIT 1
      `,
      [parsedId]
    );
    return result.rows?.[0] || null;
  }

  return resolveMetodoPago(client, metodoPagoRaw);
};

const buildPedidoFacturaSnapshot = (row, quantity, tipoItem, precioUnitario, subTotal, totalDetalle) => ({
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
  descuento: roundMoney(roundMoney(subTotal) - roundMoney(totalDetalle)),
  observacion: row.observacion || null,
  origen: 'PEDIDO_PENDIENTE'
});

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
      idProducto,
      parseOptionalPositiveInt(row.id_descuento),
      cantidad,
      precioUnitario,
      subTotal,
      totalDetalle,
      idPedido,
      idDetallePedido,
      tipoItem,
      idReceta,
      idCombo,
      JSON.stringify(snapshot)
    ]
  );

  const idDetalleFactura = Number(detalleFacturaResult.rows?.[0]?.id_detalle_factura || 0);
  await insertDetalleFacturaOrigenSnapshot({ client, idDetalleFactura, idDetallePedido, tipoItem, idProducto, idReceta, idCombo, snapshot });
  return { totalDetalle, subTotal };
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

const buildVentaPayload = async ({ client, body, userId, sucursalScope, canApplyDiscount }) => {
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

  const normalizedItemsResult = normalizeVentaItems(body.items);
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

  const idSucursal = await resolveSucursalId(client, idSucursalTarget);
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

  const requestedEstadoPedido = await resolveRequestedEstadoPedidoId(client, idEstadoPedidoRequested);
  if (idEstadoPedidoRequested && !requestedEstadoPedido) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'id_estado_pedido no existe.' }
    };
  }

  if (idCliente) {
    const cliente = await fetchClienteInfo(client, idCliente);
    if (!cliente) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: 'id_cliente no existe.' }
      };
    }
  }

  const metodoPago = await resolveMetodoPago(client, metodoPagoInput);
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

  const hydratedResult = await hydrateVentaLines(client, normalizedItemsResult.data);
  if (!hydratedResult.ok) return hydratedResult;

  const { lines, subTotals } = hydratedResult.data;
  const subtotalBruto = roundMoney(subTotals.reduce((sum, value) => sum + value, 0));
  let descuentoTotal = descuentoLegacyInput || 0;
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

  if ((hasGlobalCatalogDiscount || hasLegacyDiscount) && hasLineDiscountAttempt) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: 'VENTAS_DESCUENTO_ACUMULACION_NO_PERMITIDA',
        message: 'No se permite combinar descuento global con descuentos por linea.'
      }
    };
  }

  if (idDescuentoCatalogo) {
    const discountCatalog = await fetchDiscountCatalogById(client, idDescuentoCatalogo);
    const validatedGlobalDiscount = validateCatalogDiscountAvailability({
      discountCatalog,
      idSucursal,
      subtotalObjetivo: subtotalBruto,
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

    descuentoTotal = validatedGlobalDiscount.montoCalculado;
    appliedDiscountCatalog = {
      id_descuento_catalogo: Number(discountCatalog.id_descuento_catalogo),
      id_tipo_descuento: Number(discountCatalog.id_tipo_descuento),
      tipo_descuento_key: validatedGlobalDiscount.tipoDescuentoKey,
      alcance: validatedGlobalDiscount.alcance
    };
  }

  if (descuentoTotal > subtotalBruto) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'El descuento no puede ser mayor al subtotal.' }
    };
  }

  const descuentosPorLinea = allocateDiscounts(subTotals, descuentoTotal);
  const descuentosLineaMap = new Map();
  const descuentosCatalogoLineaMap = new Map();

  if (hasLineDiscountAttempt) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const idDescuentoLinea = parseOptionalPositiveInt(line.id_descuento_catalogo_linea);
      if (!idDescuentoLinea) continue;

      const discountCatalog = await fetchDiscountCatalogById(client, idDescuentoLinea);
      const expectedScope = line.kind;
      const validatedLineDiscount = validateCatalogDiscountAvailability({
        discountCatalog,
        idSucursal,
        subtotalObjetivo: line.sub_total,
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

  const finalizedLines = lines.map((line, index) => ({
    ...line,
    id_descuento_catalogo:
      hasLineDiscountAttempt
        ? descuentosCatalogoLineaMap.get(index) || null
        : appliedDiscountCatalog?.id_descuento_catalogo ?? null,
    descuento: hasLineDiscountAttempt
      ? roundMoney(descuentosLineaMap.get(index) || 0)
      : descuentosPorLinea[index],
    total_linea: hasLineDiscountAttempt
      ? roundMoney(line.sub_total - roundMoney(descuentosLineaMap.get(index) || 0))
      : roundMoney(line.sub_total - descuentosPorLinea[index])
  }));

  descuentoTotal = roundMoney(finalizedLines.reduce((sum, line) => sum + Number(line.descuento || 0), 0));

  const subtotal = roundMoney(finalizedLines.reduce((sum, line) => sum + line.total_linea, 0));
  const isv = roundMoney(subtotal * 0.15);
  const total = roundMoney(subtotal + isv);
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

  const sessionActiva = await resolveCajaSession({
    client,
    idSucursal,
    idUsuario: userId,
    idSesionCaja: idSesionCajaRequested,
    isSuperAdmin: Boolean(sucursalScope?.isSuperAdmin)
  });
  if (!sessionActiva.ok) {
    return {
      ok: false,
      status:
        sessionActiva.reason === 'SESSION_NOT_FOUND'
          ? 404
          : ['SESSION_NOT_OPEN', 'OPEN_STATE_NOT_FOUND'].includes(sessionActiva.reason)
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
  const pedidoIsv = roundMoney(pedidoSubtotal * 0.15);
  const pedidoTotal = roundMoney(pedidoSubtotal + pedidoIsv);

  let idEstadoPedido = null;
  if (requiresPedido) {
    idEstadoPedido =
      requestedEstadoPedido || (await resolveEstadoPedidoIdByCode(client, 'EN_COCINA'));

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
      id_descuento_catalogo: appliedDiscountCatalog?.id_descuento_catalogo ?? null,
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
  const idProducto = parseOptionalPositiveInt(payload.id_producto);
  const idReceta = parseOptionalPositiveInt(payload.id_receta);
  const idCombo = parseOptionalPositiveInt(payload.id_combo);
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

  const idsObjetivo = [idProducto, idReceta, idCombo].filter(Boolean);
  if (alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO && !idProducto) {
    return { ok: false, status: 400, message: 'id_producto es obligatorio para alcance PRODUCTO.' };
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.RECETA && !idReceta) {
    return { ok: false, status: 400, message: 'id_receta es obligatorio para alcance RECETA.' };
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.COMBO && !idCombo) {
    return { ok: false, status: 400, message: 'id_combo es obligatorio para alcance COMBO.' };
  }
  if (alcance === DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA && idsObjetivo.length > 0) {
    return { ok: false, status: 400, message: 'FACTURA_COMPLETA no permite id_producto/id_receta/id_combo.' };
  }
  if (alcance !== DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA && idsObjetivo.length !== 1) {
    return { ok: false, status: 400, message: 'Debe enviar un unico objetivo para el alcance seleccionado.' };
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
      id_producto: idProducto,
      id_receta: idReceta,
      id_combo: idCombo,
      id_sucursal: idSucursal,
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      id_tipo_descuento: tipoResult.value,
      estado: estadoParsed.value,
      mode
    }
  };
};

router.get('/ventas/catalogos/categorias', async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

    if (!isSuperAdmin) {
      if (!scope.allowedSucursalIds || scope.allowedSucursalIds.length === 0) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }
      if (idSucursal && !scope.allowedSucursalIds.includes(idSucursal)) {
        return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
      }
    }

    const result = await pool.query(
      `
        SELECT cp.id_categoria_producto, cp.nombre_categoria, COALESCE(cp.estado, true) AS estado
        FROM public.categorias_productos cp
        WHERE COALESCE(cp.estado, true) = true
        ORDER BY cp.nombre_categoria ASC, cp.id_categoria_producto ASC
      `
    );

    return res.status(200).json(Array.isArray(result.rows) ? result.rows : []);
  } catch (err) {
    console.error('Error al listar catalogo de categorias para ventas:', err.message);
    return sendVentasInternalError(res);
  }
});

router.get('/ventas/catalogos/productos', async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

    if (!isSuperAdmin) {
      if (!scope.allowedSucursalIds || scope.allowedSucursalIds.length === 0) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }
      if (idSucursal && !scope.allowedSucursalIds.includes(idSucursal)) {
        return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
      }
    }

    let whereClause = '';
    const params = [];

    if (idSucursal) {
      params.push(idSucursal);
      whereClause = 'AND al.id_sucursal = $1';
    } else if (!isSuperAdmin) {
      const allowedSucursalIds = coercePositiveIntArray(scope.allowedSucursalIds);
      if (allowedSucursalIds.length === 0) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }
      params.push(allowedSucursalIds);
      whereClause = 'AND al.id_sucursal = ANY($1::int[])';
    }

    const query = `
      SELECT DISTINCT
        p.id_producto,
        p.nombre_producto,
        p.descripcion_producto,
        p.precio,
        p.cantidad,
        p.estado,
        p.id_categoria_producto,
        p.id_tipo_departamento,
        p.id_archivo_imagen_principal,
        al.id_sucursal,
        a.url_publica AS imagen_principal_url
      FROM public.productos p
      LEFT JOIN public.almacenes al ON al.id_almacen = p.id_almacen
      LEFT JOIN public.archivos a ON a.id_archivo = p.id_archivo_imagen_principal AND (a.estado = true OR a.estado IS NULL)
      WHERE COALESCE(p.estado, true) = true
        AND COALESCE(al.estado, true) = true
      ${whereClause}
      ORDER BY p.nombre_producto ASC, p.id_producto ASC
    `;

    const result = await pool.query(query, params);
    return res.status(200).json(Array.isArray(result.rows) ? result.rows : []);
  } catch (err) {
    console.error('Error al listar catalogo de productos para ventas:', err.message);
    return sendVentasInternalError(res);
  }
});

router.get('/ventas/catalogos/clientes', async (req, res) => {
  try {
    const query = `
      SELECT
        c.id_cliente,
        c.estado,
        c.id_tipo_cliente,
        p.nombre,
        p.apellido,
        e.nombre_empresa
      FROM clientes c
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
      WHERE COALESCE(c.estado, true) = true
      ORDER BY
        COALESCE(NULLIF(trim(concat_ws(' ', p.nombre, p.apellido)), ''), e.nombre_empresa, c.id_cliente::text)
    `;

    const result = await pool.query(query);
    const data = result.rows.map((row) => ({
      id_cliente: row.id_cliente,
      id_tipo_cliente: row.id_tipo_cliente,
      estado: row.estado,
      nombre_cliente: normalizeClienteNombre(row),
      es_consumidor_final: false
    }));

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar catalogo de clientes para ventas:', err.message);
    sendVentasInternalError(res);
  }
});

router.get('/ventas/catalogos/combos', async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    let idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

    if (!isSuperAdmin) {
      if (!scope.allowedSucursalIds || scope.allowedSucursalIds.length === 0) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }
      if (idSucursal) {
        if (!scope.allowedSucursalIds.includes(idSucursal)) {
          return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
        }
      }
    }

    let joinClause = '';
    let whereClause = '';
    const params = [];

    if (idSucursal) {
      params.push(idSucursal);
      joinClause = 'INNER JOIN menu_vigente mv ON mv.id_menu = c.id_menu';
      whereClause = 'AND mv.id_sucursal = $1 AND COALESCE(mv.estado, true) = true AND (mv.fecha_inicio IS NULL OR mv.fecha_inicio <= CURRENT_TIMESTAMP)';
    } else if (!isSuperAdmin) {
      params.push(scope.allowedSucursalIds);
      joinClause = 'INNER JOIN menu_vigente mv ON mv.id_menu = c.id_menu';
      whereClause = 'AND mv.id_sucursal = ANY($1::int[]) AND COALESCE(mv.estado, true) = true AND (mv.fecha_inicio IS NULL OR mv.fecha_inicio <= CURRENT_TIMESTAMP)';
    }

    const query = `
      SELECT DISTINCT
        c.id_combo, 
        c.descripcion, 
        c.precio, 
        c.estado,
        c.id_archivo,
        c.id_tipo_departamento,
        a.url_publica AS imagen_principal_url
      FROM combos c
      LEFT JOIN archivos a ON a.id_archivo = c.id_archivo AND (a.estado = true OR a.estado IS NULL)
      ${joinClause}
      WHERE COALESCE(c.estado, true) = true ${whereClause}
      ORDER BY c.descripcion ASC, c.id_combo ASC
    `;

    const result = await pool.query(query, params);
    const comboRows = Array.isArray(result.rows) ? result.rows : [];
    const complementContext = await buildVentaComplementContext({
      client: pool,
      normalizedItems: comboRows.map((row) => ({
        kind: 'COMBO',
        id_combo: Number(row?.id_combo || 0),
        cantidad: 1,
        complementos: []
      }))
    });

    const data = comboRows.map((row) => {
      const metadata = resolveComboComplementMetadata({
        combo: row,
        quantity: 1,
        components: complementContext.comboComponentsByCombo.get(Number(row?.id_combo || 0)) || [],
        saucesByRecipe: complementContext.saucesByRecipe,
        rulesByRecipe: complementContext.rulesByRecipe,
        fallbackSauces: complementContext.fallbackSauces
      });

      return {
        ...row,
        requiere_complementos: Boolean(metadata.requiere_complementos),
        tipo_complemento: metadata.tipo_complemento || VENTA_COMPLEMENTO_TIPO_SALSAS,
        minimo_complementos: Number(metadata.minimo_complementos || 0),
        maximo_complementos: Number(metadata.maximo_complementos || 0),
        complementos_disponibles: (Array.isArray(metadata.complementos_disponibles) ? metadata.complementos_disponibles : []).map((entry) => ({
          id_complemento: Number(entry?.id_complemento || entry?.id_salsa || 0),
          nombre: String(entry?.nombre || 'Salsa').trim(),
          disponible: entry?.disponible !== false
        })).filter((entry) => entry.id_complemento > 0)
      };
    });

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar catalogo de combos para ventas:', err.message);
    sendVentasInternalError(res);
  }
});

router.get('/ventas/catalogos/recetas', async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    let idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

    if (!isSuperAdmin) {
      if (!scope.allowedSucursalIds || scope.allowedSucursalIds.length === 0) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }
      if (idSucursal) {
        if (!scope.allowedSucursalIds.includes(idSucursal)) {
          return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
        }
      }
    }

    let joinClause = '';
    let whereClause = '';
    const params = [];

    if (idSucursal) {
      params.push(idSucursal);
      joinClause = 'INNER JOIN menu_vigente mv ON mv.id_menu = r.id_menu';
      whereClause = 'AND mv.id_sucursal = $1 AND COALESCE(mv.estado, true) = true AND (mv.fecha_inicio IS NULL OR mv.fecha_inicio <= CURRENT_TIMESTAMP)';
    } else if (!isSuperAdmin) {
      params.push(scope.allowedSucursalIds);
      joinClause = 'INNER JOIN menu_vigente mv ON mv.id_menu = r.id_menu';
      whereClause = 'AND mv.id_sucursal = ANY($1::int[]) AND COALESCE(mv.estado, true) = true AND (mv.fecha_inicio IS NULL OR mv.fecha_inicio <= CURRENT_TIMESTAMP)';
    }

    const query = `
      SELECT DISTINCT
        r.id_receta,
        r.nombre_receta,
        r.descripcion,
        r.estado,
        r.precio,
        r.id_archivo,
        r.id_tipo_departamento,
        a.url_publica AS imagen_principal_url,
        NULL::INTEGER AS id_producto_base,
        r.nombre_receta AS nombre_producto_base,
        r.precio AS precio_producto_base,
        r.estado AS estado_producto_base
      FROM recetas r
      LEFT JOIN archivos a ON a.id_archivo = r.id_archivo AND (a.estado = true OR a.estado IS NULL)
      ${joinClause}
      WHERE COALESCE(r.estado, true) = true ${whereClause}
      ORDER BY r.nombre_receta ASC, r.id_receta ASC
    `;

    const result = await pool.query(query, params);
    const recetaRows = Array.isArray(result.rows) ? result.rows : [];
    const complementContext = await buildVentaComplementContext({
      client: pool,
      normalizedItems: recetaRows.map((row) => ({
        kind: 'RECETA',
        id_receta: Number(row?.id_receta || 0),
        cantidad: 1,
        complementos: []
      }))
    });

    const data = recetaRows.map((row) => {
      const metadata = resolveRecetaComplementMetadata({
        receta: row,
        quantity: 1,
        allowedSauces: complementContext.saucesByRecipe.get(Number(row?.id_receta || 0)) || [],
        rules: complementContext.rulesByRecipe.get(Number(row?.id_receta || 0)) || [],
        fallbackSauces: complementContext.fallbackSauces
      });

      return {
        ...row,
        requiere_complementos: Boolean(metadata.requiere_complementos),
        tipo_complemento: metadata.tipo_complemento || VENTA_COMPLEMENTO_TIPO_SALSAS,
        minimo_complementos: Number(metadata.minimo_complementos || 0),
        maximo_complementos: Number(metadata.maximo_complementos || 0),
        complementos_disponibles: (Array.isArray(metadata.complementos_disponibles) ? metadata.complementos_disponibles : []).map((entry) => ({
          id_complemento: Number(entry?.id_complemento || entry?.id_salsa || 0),
          nombre: String(entry?.nombre || 'Salsa').trim(),
          disponible: entry?.disponible !== false
        })).filter((entry) => entry.id_complemento > 0)
      };
    });

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar catalogo de recetas para ventas:', err.message);
    sendVentasInternalError(res);
  }
});

router.get('/ventas/catalogos/tipos-descuento', async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          td.id_tipo_descuento,
          td.nombre_tipo_descuento,
          td.descripcion,
          td.estado
        FROM tipo_descuentos td
        WHERE COALESCE(td.estado, true) = true
        ORDER BY td.id_tipo_descuento
      `
    );
    res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar tipos de descuento:', err.message);
    sendVentasInternalError(res);
  }
});

router.get('/ventas/catalogos/tipo-departamento', async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          td.id_tipo_departamento,
          td.nombre_departamento,
          td.descripcion,
          td.estado
        FROM tipo_departamento td
        WHERE COALESCE(td.estado, true) = true
        ORDER BY td.nombre_departamento
      `
    );
    res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar tipos de departamento:', err.message);
    sendVentasInternalError(res);
  }
});

router.get('/ventas/catalogos/descuentos', async (req, res) => {
  try {
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
          td.nombre_tipo_descuento
        FROM descuentos_catalogos dc
        INNER JOIN tipo_descuentos td
          ON td.id_tipo_descuento = dc.id_tipo_descuento
        WHERE COALESCE(dc.estado, true) = true
          AND COALESCE(td.estado, true) = true
        ORDER BY dc.nombre_descuento ASC, dc.id_descuento_catalogo ASC
      `
    );
    res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar descuentos activos de catalogo:', err.message);
    sendVentasInternalError(res);
  }
});

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
        ${whereSql}
        ORDER BY dc.id_descuento_catalogo DESC
      `,
      params
    );

    res.status(200).json(result.rows || []);
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
        WHERE dc.id_descuento_catalogo = $1
        LIMIT 1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Descuento de catalogo no encontrado.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error al obtener descuento_catalogo por id:', err.message);
    return sendVentasInternalError(res);
  }
});

router.post('/ventas/descuentos-catalogos', checkPermission(VENTAS_DESCUENTOS_WRITE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const validated = await validateDescuentoCatalogoPayload(client, req.body, { mode: 'create' });
    if (!validated.ok) {
      await client.query('ROLLBACK');
      return res.status(validated.status).json({ error: true, message: validated.message });
    }

    const created = await client.query(
      `
        INSERT INTO descuentos_catalogos (
          nombre_descuento,
          descripcion,
          valor_descuento,
          alcance,
          id_producto,
          id_receta,
          id_combo,
          id_sucursal,
          fecha_inicio,
          fecha_fin,
          id_tipo_descuento,
          estado,
          fecha_creacion,
          id_usuario
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13)
        RETURNING id_descuento_catalogo
      `,
      [
        validated.data.nombre_descuento,
        validated.data.descripcion,
        validated.data.valor_descuento,
        validated.data.alcance,
        validated.data.id_producto,
        validated.data.id_receta,
        validated.data.id_combo,
        validated.data.id_sucursal,
        validated.data.fecha_inicio,
        validated.data.fecha_fin,
        validated.data.id_tipo_descuento,
        validated.data.estado,
        req.user?.id_usuario ?? null
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Descuento de catalogo creado exitosamente.',
      id_descuento_catalogo: created.rows[0].id_descuento_catalogo
    });
  } catch (err) {
    await client.query('ROLLBACK');
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

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id_descuento_catalogo FROM descuentos_catalogos WHERE id_descuento_catalogo = $1 LIMIT 1',
      [id]
    );
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Descuento de catalogo no encontrado.' });
    }

    const validated = await validateDescuentoCatalogoPayload(client, req.body, { mode: 'update' });
    if (!validated.ok) {
      await client.query('ROLLBACK');
      return res.status(validated.status).json({ error: true, message: validated.message });
    }

    await client.query(
      `
        UPDATE descuentos_catalogos
        SET
          nombre_descuento = $1,
          descripcion = $2,
          valor_descuento = $3,
          alcance = $4,
          id_producto = $5,
          id_receta = $6,
          id_combo = $7,
          id_sucursal = $8,
          fecha_inicio = $9,
          fecha_fin = $10,
          id_tipo_descuento = $11,
          estado = $12
        WHERE id_descuento_catalogo = $13
      `,
      [
        validated.data.nombre_descuento,
        validated.data.descripcion,
        validated.data.valor_descuento,
        validated.data.alcance,
        validated.data.id_producto,
        validated.data.id_receta,
        validated.data.id_combo,
        validated.data.id_sucursal,
        validated.data.fecha_inicio,
        validated.data.fecha_fin,
        validated.data.id_tipo_descuento,
        validated.data.estado,
        id
      ]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Descuento de catalogo actualizado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
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
      pushFilter('COALESCE(ep.descripcion, $IDX) ILIKE $IDX', `%${estado}%`);
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
              p.total,
              COALESCE(df_info.subtotal_neto, 0) + COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0)
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
        COALESCE(p.isv, COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0), 0) AS isv,
        COALESCE(
          p.total,
          COALESCE(df_info.subtotal_neto, 0) + COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0)
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
        f.isv_15,
        f.isv_18,
        fc_info.metodo_pago,
        CASE
          WHEN f.id_pedido IS NOT NULL THEN COALESCE(dp_info.total_items, 0)
          ELSE COALESCE(df_info.total_items, 0)
        END AS total_items,
        COALESCE(df_info.descuento_total, 0) AS descuento_total
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

    const countResult = await pool.query(countQuery, params);
    const summaryResult = await pool.query(summaryQuery, params);
    const total = Number.parseInt(String(countResult.rows?.[0]?.total ?? '0'), 10) || 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
    const queryParams = [...params, pageSize, offset];
    const result = await pool.query(dataQuery, queryParams);
    const summaryRow = summaryResult.rows?.[0] || {};
    const summaryVentas = Number.parseInt(String(summaryRow.ventas ?? '0'), 10) || 0;
    const summaryTotalVendido = roundMoney(summaryRow.total_vendido);
    const summaryCompletadas = Number.parseInt(String(summaryRow.completadas ?? '0'), 10) || 0;
    const summaryPendientes = Math.max(summaryVentas - summaryCompletadas, 0);
    const summaryTicketPromedio = summaryVentas > 0
      ? roundMoney(summaryTotalVendido / summaryVentas)
      : 0;

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
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      summary: {
        ventas: summaryVentas,
        totalVendido: summaryTotalVendido,
        ticketPromedio: summaryTicketPromedio,
        completadas: summaryCompletadas,
        pendientes: summaryPendientes
      },
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

// --- ENDPOINTS DE PEDIDOS (MENU PUBLICO) ---
// Gestion de validacion de pago y flujo operativo (Cocina/Entrega).
router.get('/ventas/pedidos-menu', checkPermission(['VENTAS_VER']), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await resolveRequestUserSucursalScope(req, client);
    const allowedSucursalIds = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.filter((value) => Number.isInteger(Number(value)) && Number(value) > 0).map(Number)
      : [];

    await expirePendingPublicOrders({ client, allowedSucursalIds });

    const hasEstadoPago = await hasPedidosColumn(client, 'estado_pago');
    const hasValidacionVence = await hasPedidosColumn(client, 'validacion_pago_vence_at');
    const hasPagoConfirmadoAt = await hasPedidosColumn(client, 'pago_confirmado_at');
    const hasCanceladoPorTimeoutAt = await hasPedidosColumn(client, 'cancelado_por_timeout_at');
    const hasIdUsuarioPagoConfirmado = await hasPedidosColumn(client, 'id_usuario_pago_confirmado');
    const hasKdsStartedAt = await hasPedidosColumn(client, 'kds_started_at');
    const hasKdsExpectedMinutes = await hasPedidosColumn(client, 'kds_expected_minutes');
    const hasKdsExpectedRule = await hasPedidosColumn(client, 'kds_expected_rule');

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

    if (allowedSucursalIds.length > 0) {
      params.push(allowedSucursalIds);
      filters.push(`p.id_sucursal = ANY($${params.length}::int[])`);
    }

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
          p.id_estado_pedido,
          p.origen_pedido,
          ep.descripcion AS nombre_estado_pedido,
          ${estadoPagoSelect},
          ${validacionSelect},
          ${pagoConfirmadoAtSelect},
          ${canceladoTimeoutSelect},
          ${pagoConfirmadorSelect},
          ${kdsStartedAtSelect},
          ${kdsExpectedMinutesSelect},
          ${kdsExpectedRuleSelect},
          ${kdsVencidoSelect},
          COALESCE(NULLIF(TRIM(f.codigo_venta), ''), NULL) AS codigo_venta,
          u_pago.nombre_usuario AS usuario_pago_confirmado,
          per.nombre AS nombres_cliente,
          per.apellido AS apellidos_cliente
        FROM pedidos p
        INNER JOIN estados_pedido ep ON p.id_estado_pedido = ep.id_estado_pedido
        LEFT JOIN facturas f ON f.id_pedido = p.id_pedido
        LEFT JOIN clientes c ON p.id_cliente = c.id_cliente
        LEFT JOIN personas per ON c.id_persona = per.id_persona
        LEFT JOIN usuarios u_pago ON u_pago.id_usuario = p.id_usuario_pago_confirmado
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
        pago_expirado: String(row.estado_pago || '').toUpperCase() === PEDIDO_ESTADO_PAGO.CANCELADO_TIMEOUT,
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

    const hasEstadoPago = await hasPedidosColumn(client, 'estado_pago');
    const hasValidacionVence = await hasPedidosColumn(client, 'validacion_pago_vence_at');
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

    if (normalizedTargetCode === 'EN_COCINA' && hasEstadoPago) {
      const estadoPago = String(pedido.estado_pago || '').toUpperCase();
      if (estadoPago !== PEDIDO_ESTADO_PAGO.PAGADO_CONFIRMADO) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          message: 'No se puede enviar a cocina sin confirmar el pago.'
        });
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
            message: 'El pedido ya vencio por timeout de validacion de pago.'
          });
        }
      }
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

  try {
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
                notificado_en = NOW(),
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

    return res.status(201).json({
      success: true,
      data: result,
      message: 'Reversión registrada correctamente.'
    });
  } catch (error) {
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

router.get('/ventas/buscar', checkPermission(['VENTAS_VER']), async (req, res) => {
  try {
    const codigoVenta = String(req.query.codigo_venta || '').trim().toUpperCase();
    const fechaOperacion = parseOptionalDateInput(req.query.fecha_operacion);
    const idSucursalRequested = parseOptionalPositiveInt(req.query.id_sucursal);

    if (!codigoVenta) {
      return res.status(400).json({ error: true, message: 'Ingresa el código de venta.' });
    }
    if (!fechaOperacion || fechaOperacion === '__INVALID_DATE__') {
      return res.status(400).json({ error: true, message: 'Selecciona la fecha de operación.' });
    }

    const scope = await resolveVentasHistoryScope(req);
    if (!scope.allowedSucursalIds.length) {
      return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal asignada.' });
    }

    let idSucursalEffective = null;
    if (scope.isSuperAdmin) {
      idSucursalEffective = idSucursalRequested;
      if (!idSucursalEffective) {
        return res.status(400).json({ error: true, message: 'Selecciona la sucursal.' });
      }
      if (!scope.allowedSucursalIds.includes(idSucursalEffective)) {
        return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
      }
    } else {
      idSucursalEffective = scope.userSucursalId;
      if (!idSucursalEffective) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal asignada.' });
      }
      if (idSucursalRequested && idSucursalRequested !== idSucursalEffective) {
        return res.status(403).json({
          error: 'SUCURSAL_NO_AUTORIZADA',
          message: 'No tienes permiso para consultar ventas de esta sucursal.'
        });
      }
    }

    const result = await pool.query(
      `
        SELECT
          f.id_factura,
          COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(f.id_factura::text, 5, '0')) AS codigo_venta,
          f.fecha_operacion::date AS fecha_operacion,
          f.id_sucursal,
          s.nombre_sucursal AS sucursal,
          COALESCE(
            NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
            emp.nombre_empresa,
            'Consumidor final'
          ) AS cliente,
          COALESCE(
            (
              SELECT SUM(COALESCE(df.total_detalle, 0))
              FROM detalle_facturas df
              WHERE df.id_factura = f.id_factura
            ),
            0
          )::numeric(12,2) AS total
        FROM facturas f
        LEFT JOIN sucursales s ON s.id_sucursal = f.id_sucursal
        LEFT JOIN clientes c ON c.id_cliente = f.id_cliente
        LEFT JOIN personas per ON per.id_persona = c.id_persona
        LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
        WHERE UPPER(COALESCE(f.codigo_venta, '')) = $1
          AND f.fecha_operacion = $2::date
          AND f.id_sucursal = $3
        LIMIT 1
      `,
      [codigoVenta, fechaOperacion, idSucursalEffective]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: true,
        message: 'No se encontró una venta con ese código, fecha y sucursal.'
      });
    }

    const row = result.rows[0];
    return res.status(200).json({
      data: {
        id_factura: Number(row.id_factura),
        codigo_venta: row.codigo_venta,
        fecha_operacion: row.fecha_operacion,
        id_sucursal: Number(row.id_sucursal),
        sucursal: row.sucursal || `Sucursal ${row.id_sucursal}`,
        cliente: row.cliente || 'Consumidor final',
        total: roundMoney(row.total),
        items: []
      }
    });
  } catch (err) {
    console.error('Error en búsqueda exacta de ventas:', err);
    return sendVentasInternalError(res);
  }
});

router.get('/ventas/pedidos-pendientes', checkPermission(['VENTAS_CREAR']), listarPedidosPendientesPago);

router.get('/ventas/:id', checkPermission(['VENTAS_VER']), async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const scope = await resolveVentasHistoryScope(req);
    if (!scope.allowedSucursalIds.length) {
      return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
    }
    const headerQuery = `
      SELECT
        f.id_factura,
        f.codigo_venta,
        f.fecha_operacion,
        f.id_pedido,
        p.descripcion_pedido,
        p.descripcion_envio,
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion) AS fecha_hora_pedido,
        COALESCE(p.sub_total, df_info.subtotal_neto, 0) AS sub_total,
        COALESCE(p.isv, COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0), 0) AS isv,
        COALESCE(
          p.total,
          COALESCE(df_info.subtotal_neto, 0) + COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0)
        ) AS total,
        p.id_estado_pedido,
        CASE
          WHEN p.id_pedido IS NULL THEN '${VENTA_DIRECTA_LABEL}'
          ELSE ep.descripcion
        END AS estado_pedido,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        s.nombre_sucursal,
        COALESCE(p.id_cliente, f.id_cliente) AS id_cliente,
        COALESCE(
          NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
          emp.nombre_empresa,
          'Consumidor final'
        ) AS cliente_nombre,
        COALESCE(NULLIF(trim(per.rtn), ''), NULLIF(trim(emp.rtn), '')) AS cliente_rtn,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        u.nombre_usuario,
        f.id_caja,
        cj.nombre_caja,
        cj.codigo_caja,
        f.id_sesion_caja,
        f.efectivo_entregado,
        f.cambio,
        f.fecha_hora_facturacion,
        f.isv_15,
        f.isv_18,
        f.id_config_facturacion,
        f.id_rango_cai,
        f.numero_factura_fiscal,
        f.facturacion_snapshot,
        COALESCE(df_info.subtotal_neto, 0) AS gravado_15,
        0::numeric(12,2) AS gravado_18,
        0::numeric(12,2) AS exento,
        (COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0))::numeric(12,2) AS total_isv,
        fc_info.metodo_pago,
        fc_info.codigo_transaccion,
        NULL::varchar AS banco,
        NULL::numeric AS exonerado,
        emp_info.nombre_empresa AS nombre_emisor,
        emp_info.rtn AS rtn_emisor,
        frc.cai,
        frc.numero_desde,
        frc.numero_hasta,
        frc.fecha_limite_emision,
        cfg.modo_fiscal,
        cfg.ancho_ticket_mm,
        cfg.mostrar_logo_ticket,
        COALESCE(df_info.total_items, 0) AS total_items,
        COALESCE(df_info.descuento_total, 0) AS descuento_total
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
      LEFT JOIN cajas cj ON cj.id_caja = f.id_caja
      LEFT JOIN LATERAL (
        SELECT e.nombre_empresa, e.rtn
        FROM empresas e
        WHERE COALESCE(e.estado, true) = true
        ORDER BY e.id_empresa
        LIMIT 1
      ) emp_info ON true
      LEFT JOIN LATERAL (
        SELECT
          frc.id_rango_cai,
          frc.cai,
          frc.numero_desde,
          frc.numero_hasta,
          frc.fecha_limite_emision
        FROM facturacion_rangos_cai frc
        WHERE frc.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
          AND COALESCE(UPPER(TRIM(frc.estado)), 'ACTIVO') IN ('ACTIVO', 'VIGENTE')
        ORDER BY frc.id_rango_cai DESC
        LIMIT 1
      ) frc ON true
      LEFT JOIN LATERAL (
        SELECT
          cfg.modo_fiscal,
          cfg.ancho_ticket_mm,
          cfg.mostrar_logo_ticket
        FROM facturacion_config_sucursal cfg
        WHERE cfg.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
          AND COALESCE(cfg.activo, true) = true
        ORDER BY cfg.id_config DESC
        LIMIT 1
      ) cfg ON true
      LEFT JOIN LATERAL (
        SELECT
          STRING_AGG(DISTINCT cmp.nombre, ', ' ORDER BY cmp.nombre) AS metodo_pago,
          STRING_AGG(
            DISTINCT NULLIF(TRIM(fc.referencia), ''),
            ', ' ORDER BY NULLIF(TRIM(fc.referencia), '')
          ) AS codigo_transaccion
        FROM facturas_cobros fc
        INNER JOIN cat_metodos_pago cmp
          ON cmp.id_metodo_pago = fc.id_metodo_pago
        WHERE fc.id_factura = f.id_factura
      ) fc_info ON true
      LEFT JOIN LATERAL (
        SELECT
          SUM(COALESCE(df.cantidad, 0))::int AS total_items,
          COALESCE(SUM(df.total_detalle), 0)::numeric(12,2) AS subtotal_neto,
          COALESCE(SUM(d.monto_descuento), 0)::numeric(12,2) AS descuento_total
        FROM detalle_facturas df
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = f.id_factura
      ) df_info ON true
      WHERE f.id_factura = $1
        AND (
          $2::boolean = false
          OR (
            f.fecha_hora_facturacion IS NOT NULL
            AND f.fecha_hora_facturacion >= ${VENTAS_LIMIT_72H_CUTOFF_SQL}
          )
        )
        AND COALESCE(p.id_sucursal, f.id_sucursal) = ANY($3::int[])
      LIMIT 1
    `;

    const headerResult = await pool.query(headerQuery, [
      idFactura,
      scope.limitedToLast72Hours,
      scope.allowedSucursalIds
    ]);
    if (headerResult.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Venta no encontrada.' });
    }

    const venta = headerResult.rows[0];
    const facturacionNormalizada = await normalizarDatosTicketDesdeSnapshot({
      client: pool,
      factura: venta
    });
    Object.assign(venta, mergeVentaWithFacturacion(venta, facturacionNormalizada));

    if (venta.id_pedido) {
      const pedidoItemsResult = await pool.query(
        `
          SELECT
            df.id_detalle_factura AS id_detalle,
            COALESCE(dfo.id_detalle_pedido, df.id_detalle_pedido::int) AS id_detalle_pedido,
            CASE
              WHEN NULLIF(TRIM(dfo.tipo_item), '') IS NOT NULL THEN UPPER(TRIM(dfo.tipo_item))
              WHEN NULLIF(TRIM(df.tipo_item), '') IS NOT NULL THEN UPPER(TRIM(df.tipo_item))
              WHEN dp.id_producto IS NOT NULL THEN 'PRODUCTO'
              WHEN dp.id_combo IS NOT NULL THEN 'COMBO'
              WHEN dp.id_receta IS NOT NULL THEN 'RECETA'
              ELSE 'ITEM'
            END AS tipo_item,
            COALESCE(dfo.id_producto, df.id_producto, dp.id_producto) AS id_producto,
            COALESCE(dfo.id_combo, df.id_combo::int, dp.id_combo) AS id_combo,
            COALESCE(dfo.id_receta, df.id_receta::int, dp.id_receta) AS id_receta,
            COALESCE(
              dfo.origen_snapshot->>'nombre_item',
              df.origen_snapshot->>'nombre_item',
              prod.nombre_producto,
              combo.descripcion,
              rec.nombre_receta,
              'Item de cocina'
            ) AS nombre_item,
            COALESCE(
              dfo.origen_snapshot->>'nombre_item',
              df.origen_snapshot->>'nombre_item',
              prod.nombre_producto,
              combo.descripcion,
              rec.nombre_receta,
              'Item de cocina'
            ) AS nombre_producto,
            COALESCE(df.cantidad, 1) AS cantidad,
            COALESCE(
              CASE
                WHEN dp.id_producto IS NOT NULL THEN prod.precio
                WHEN dp.id_combo IS NOT NULL THEN combo.precio
                WHEN dp.id_receta IS NOT NULL THEN rec.precio
                ELSE NULL
              END,
              CASE
                WHEN COALESCE(dp.sub_total_pedido, 0) > 0 THEN COALESCE(dp.sub_total_pedido, 0)
                ELSE COALESCE(dp.total_pedido, 0)
              END,
              0
            ) AS precio_unitario,
            COALESCE(df.sub_total, dp.sub_total_pedido, 0) AS sub_total,
            COALESCE(df.sub_total, dp.sub_total_pedido, 0) AS subtotal_linea,
            COALESCE(df.total_detalle, dp.total_pedido, COALESCE(dp.sub_total_pedido, 0)) AS total_linea,
            COALESCE(d.monto_descuento, 0) AS descuento,
            COALESCE(d.monto_descuento, 0) AS descuento_linea,
            NULL::numeric AS isv_15_linea,
            NULL::numeric AS isv_18_linea,
            NULL::numeric AS exento_linea,
            NULL::numeric AS exonerado_linea,
            dp.observacion,
            COALESCE(dfo.origen_snapshot, df.origen_snapshot) AS origen_snapshot
          FROM detalle_facturas df
          LEFT JOIN detalle_facturas_origen dfo
            ON dfo.id_detalle_factura = df.id_detalle_factura
          LEFT JOIN detalle_pedido dp ON dp.id_detalle_pedido = df.id_detalle_pedido
          LEFT JOIN productos prod ON prod.id_producto = COALESCE(dfo.id_producto, df.id_producto, dp.id_producto)
          LEFT JOIN combos combo ON combo.id_combo = COALESCE(dfo.id_combo, df.id_combo::int, dp.id_combo)
          LEFT JOIN recetas rec ON rec.id_receta = COALESCE(dfo.id_receta, df.id_receta::int, dp.id_receta)
          LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
          WHERE df.id_factura = $1
          ORDER BY df.id_detalle_factura
        `,
        [venta.id_factura]
      );

      return res.status(200).json({
        ...venta,
        numero_venta: resolveVentaNumero(venta),
        metodo_pago: venta.metodo_pago || null,
        items: buildKitchenSaleDetailItems(pedidoItemsResult.rows)
      });
    }

    const directItemsResult = await pool.query(
      `
        SELECT
          df.id_detalle_factura AS id_detalle,
          COALESCE(dfo.id_detalle_pedido, df.id_detalle_pedido::int) AS id_detalle_pedido,
          COALESCE(NULLIF(TRIM(dfo.tipo_item), ''), NULLIF(TRIM(df.tipo_item), ''), 'PRODUCTO') AS tipo_item,
          COALESCE(dfo.id_producto, df.id_producto) AS id_producto,
          COALESCE(dfo.id_combo, df.id_combo::int) AS id_combo,
          COALESCE(dfo.id_receta, df.id_receta::int) AS id_receta,
          COALESCE(dfo.origen_snapshot->>'nombre_item', df.origen_snapshot->>'nombre_item', p.nombre_producto, 'Producto') AS nombre_item,
          COALESCE(dfo.origen_snapshot->>'nombre_item', df.origen_snapshot->>'nombre_item', p.nombre_producto, 'Producto') AS nombre_producto,
          COALESCE(df.cantidad, 1) AS cantidad,
          COALESCE(df.precio_unitario, p.precio, 0) AS precio_unitario,
          COALESCE(df.sub_total, 0) AS sub_total,
          COALESCE(df.sub_total, 0) AS subtotal_linea,
          COALESCE(df.total_detalle, 0) AS total_linea,
          COALESCE(d.monto_descuento, 0) AS descuento,
          COALESCE(d.monto_descuento, 0) AS descuento_linea,
          NULL::numeric AS isv_15_linea,
          NULL::numeric AS isv_18_linea,
          NULL::numeric AS exento_linea,
          NULL::numeric AS exonerado_linea,
          NULL::varchar(200) AS observacion,
          COALESCE(dfo.origen_snapshot, df.origen_snapshot) AS origen_snapshot
        FROM detalle_facturas df
        LEFT JOIN detalle_facturas_origen dfo
          ON dfo.id_detalle_factura = df.id_detalle_factura
        LEFT JOIN productos p ON p.id_producto = COALESCE(dfo.id_producto, df.id_producto)
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = $1
        ORDER BY df.id_detalle_factura
      `,
      [venta.id_factura]
    );

    const directItems = buildDirectSaleDetailItems(directItemsResult.rows);

    res.status(200).json({
      ...venta,
      numero_venta: resolveVentaNumero(venta),
      metodo_pago: venta.metodo_pago || null,
      items: directItems
    });
  } catch (err) {
    console.error('Error al obtener detalle de venta:', err);
    sendVentasInternalError(res);
  }
});

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

  const client = await pool.connect();
  try {
    const scope = await resolveRequestUserSucursalScope(req, client);
    const allowedSucursalIds = Array.isArray(scope?.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((id) => parseOptionalPositiveInt(id)).filter(Boolean)
      : [];
    const userSucursalId = parseOptionalPositiveInt(scope?.userSucursalId);
    const effectiveAllowedSucursalIds = allowedSucursalIds.length > 0 ? allowedSucursalIds : userSucursalId ? [userSucursalId] : [];

    const filters = [
      'UPPER(TRIM(ppc.estado_pago_codigo)) = $1',
      'ppc.id_factura IS NULL',
      'COALESCE(ppc.monto_pendiente, 0) > 0',
      'f.id_factura IS NULL',
      'p.cancelado_por_timeout_at IS NULL',
      "COALESCE(UPPER(TRIM(p.estado_pago)), '') NOT IN ('PAGADO_CONFIRMADO', 'CANCELADO_TIMEOUT', 'PAGO_ANULADO', 'CANCELADO', 'ANULADO')"
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
      const codeMatch = search.match(/^PED[-\s]?0*(\d+)$/i);
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
      LEFT JOIN public.facturas f ON f.id_pedido = p.id_pedido
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
          p.fecha_hora_pedido,
          p.origen_pedido,
          CASE
            WHEN REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') IN ('EN_COCINA', 'EN_PREPARACION') THEN 'EN_COCINA'
            WHEN REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') IN ('LISTO', 'LISTO_PARA_ENTREGA') THEN 'LISTO_PARA_ENTREGA'
            ELSE REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_')
          END AS estado_pedido,
          UPPER(TRIM(ppc.estado_pago_codigo)) AS estado_pago,
          p.id_sucursal,
          s.nombre_sucursal,
          pc.nombre_contacto,
          pc.telefono_contacto,
          pc.telefono_normalizado,
          COALESCE(cpc.codigo, p.canal) AS canal,
          COALESCE(cme.codigo, p.tipo_entrega) AS modalidad,
          COALESCE(p.total, ppc.monto_total, 0)::numeric(14,2) AS total,
          COALESCE(ppc.monto_pendiente, 0)::numeric(14,2) AS monto_pendiente,
          (pd.id_pedido_delivery IS NOT NULL OR COALESCE(cme.codigo, p.tipo_entrega) = 'DELIVERY') AS es_delivery,
          COALESCE(pd.costo_envio, 0)::numeric(14,2) AS costo_envio,
          cde.codigo AS estado_delivery
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
      fecha_hora_pedido: row.fecha_hora_pedido,
      origen_pedido: row.origen_pedido,
      estado_pedido: row.estado_pedido,
      estado_pago: row.estado_pago,
      id_sucursal: Number(row.id_sucursal),
      nombre_sucursal: row.nombre_sucursal,
      nombre_contacto: row.nombre_contacto,
      telefono_contacto: row.telefono_contacto,
      telefono_normalizado: row.telefono_normalizado,
      canal: row.canal,
      modalidad: row.modalidad,
      total: roundMoney(row.total),
      monto_pendiente: roundMoney(row.monto_pendiente),
      es_delivery: Boolean(row.es_delivery),
      costo_envio: roundMoney(row.costo_envio)
    }));

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
  const discountIntent = hasDiscountIntentInPayload(req.body);
  const canApplyDiscount = await requestHasAnyPermission(req, [VENTAS_DESCUENTO_APLICAR_PERMISSION]);
  if (discountIntent && !canApplyDiscount) {
    return res.status(403).json({
      error: true,
      code: 'VENTAS_DESCUENTO_NO_AUTORIZADO',
      message: 'No tienes permiso para aplicar descuentos en ventas.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const scope = await resolveRequestUserSucursalScope(req, client);
    const userId = parseOptionalPositiveInt(scope.idUsuario);
    const prepared = await buildPedidoPendientePayload({
      client,
      body: req.body,
      userId,
      sucursalScope: scope,
      canApplyDiscount
    });

    if (!prepared.ok) {
      await client.query('ROLLBACK');
      return res.status(prepared.status).json(prepared.body);
    }

    const pedidoPendiente = prepared.data;

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

    const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
    for (const line of pedidoPendiente.pedido_lines) {
      const configuracionMenu = buildComplementLineConfig(line);
      if (hasDetallePedidoConfiguracionMenu) {
        await client.query(
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
              observacion,
              configuracion_menu
            )
            VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9::jsonb)
          `,
          [
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.observacion,
            configuracionMenu ? JSON.stringify(configuracionMenu) : null
          ]
        );
      } else {
        await client.query(
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
              observacion
            )
            VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
          `,
          [
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.observacion
          ]
        );
      }
    }

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

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Pedido pendiente creado correctamente.',
      id_pedido: idPedido,
      estado_pago: PEDIDO_PENDIENTE_ESTADO_PAGO,
      estado_pedido: 'EN_COCINA',
      origen_pedido: 'CAJA',
      canal: pedidoPendiente.canal,
      modalidad: pedidoPendiente.modalidad,
      total: pedidoPendiente.total,
      monto_pendiente: pedidoPendiente.total
    });
  } catch (err) {
    await client.query('ROLLBACK');
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
    client.release();
  }
});
router.post('/ventas/pedidos/:id/registrar-pago', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const idPedido = parseOptionalPositiveInt(req.params.id);
  if (!idPedido) {
    return res.status(400).json({ error: true, message: 'id_pedido invalido.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const pedidoResult = await client.query(
      `
        SELECT p.*
        FROM public.pedidos p
        WHERE p.id_pedido = $1
        FOR UPDATE
      `,
      [idPedido]
    );
    const pedido = pedidoResult.rows?.[0] || null;
    if (!pedido) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_NO_ENCONTRADO', message: 'Pedido no encontrado.' });
    }

    const controlResult = await client.query(
      `
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
      `,
      [idPedido]
    );
    const pagoControl = controlResult.rows?.[0] || null;
    if (!pagoControl) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_PAGO_CONTROL_NO_ENCONTRADO', message: 'El pedido no tiene control de pago pendiente.' });
    }

    const estadoPagoActual = normalizePedidoCatalogCode(pagoControl.estado_pago_codigo);
    if (estadoPagoActual !== PEDIDO_PENDIENTE_ESTADO_PAGO) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_NO_PENDIENTE_PAGO', message: 'El pedido no esta pendiente de pago.' });
    }
    if (pagoControl.id_factura || pagoControl.fecha_pago_confirmado || roundMoney(pagoControl.monto_pendiente) <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_YA_PAGADO', message: 'El pedido ya tiene pago confirmado o factura asociada.' });
    }

    const facturaPreviaResult = await client.query(
      `
        SELECT id_factura
        FROM public.facturas
        WHERE id_pedido = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idPedido]
    );
    if (facturaPreviaResult.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_FACTURA_EXISTENTE', message: 'El pedido ya tiene una factura asociada.' });
    }

    const detallePedidoResult = await client.query(
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
    if (detallePedidoResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_DETALLE_VACIO', message: 'El pedido no tiene detalle para facturar.' });
    }

    const scope = await resolveRequestUserSucursalScope(req, client);
    const userId = parseOptionalPositiveInt(scope.idUsuario);
    if (!userId) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: true, message: 'No se pudo resolver el usuario autenticado.' });
    }

    const idSucursalPedido = parseOptionalPositiveInt(pedido.id_sucursal);
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

    const totalPendiente = roundMoney(pagoControl.monto_pendiente || pedido.total);
    if (totalPendiente <= 0 || roundMoney(pedido.total) <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_TOTAL_INVALIDO', message: 'El total pendiente del pedido no es valido.' });
    }

    const montoRecibidoInput = req.body?.monto_recibido ?? req.body?.efectivo_entregado;
    const montoRecibido = metodoPagoAfectaEfectivo ? parseNonNegativeNumber(montoRecibidoInput) : null;
    if (metodoPagoAfectaEfectivo && montoRecibido === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'monto_recibido debe ser numerico para pagos en efectivo.' });
    }
    if (metodoPagoAfectaEfectivo && montoRecibido < totalPendiente) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'El efectivo recibido no puede ser menor al total pendiente.' });
    }

    const estadoPagadoCatalog = await resolveActiveCatalogCode({
      client,
      tableName: 'cat_pedidos_estados_pago',
      idColumn: 'id_estado_pago_pedido',
      code: PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO
    });
    if (!estadoPagadoCatalog) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'CAT_ESTADO_PAGO_NO_ENCONTRADO', message: 'No se encontro el estado PAGADO_CONFIRMADO.' });
    }

    const deliveryResult = await client.query(
      `
        SELECT costo_envio
        FROM public.pedidos_delivery
        WHERE id_pedido = $1
        ORDER BY id_pedido_delivery DESC
        LIMIT 1
        FOR UPDATE
      `,
      [idPedido]
    );
    const costoEnvio = roundMoney(deliveryResult.rows?.[0]?.costo_envio || 0);
    const isvPedido = roundMoney(pedido.isv || 0);
    const totalPedido = roundMoney(pedido.total || totalPendiente);
    if (Math.abs(totalPendiente - totalPedido) > 0.05) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_TOTAL_NO_CUADRA', message: 'El monto pendiente no coincide con el total del pedido.' });
    }

    const correlativoVenta = await generarCodigoDocumento({
      client,
      idSucursal: idSucursalPedido,
      tipoDocumento: 'VENTA'
    });
    const cambio = metodoPagoAfectaEfectivo ? roundMoney(montoRecibido - totalPendiente) : 0;

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
    const idFactura = Number(facturaResult.rows?.[0]?.id_factura || 0);

    const facturacionVenta = await obtenerConfigFacturacionParaVenta(client, idSucursalPedido);
    await aplicarSnapshotEnFactura(client, idFactura, facturacionVenta.snapshot, facturacionVenta.idConfig);

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
          fecha_cobro,
          fecha_creacion
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (NOW() AT TIME ZONE 'America/Tegucigalpa'), (NOW() AT TIME ZONE 'America/Tegucigalpa'))
      `,
      [
        idFactura,
        Number(sessionActiva.data.id_sesion_caja),
        Number(sessionActiva.data.id_caja),
        idSucursalPedido,
        userId,
        Number(metodoPago.id_metodo_pago),
        totalPendiente,
        referenciaPago,
        normalizePedidoText(req.body?.observacion_pago, 250)
      ]
    );

    let detallesTotal = 0;
    for (const row of detallePedidoResult.rows) {
      const inserted = await insertDetalleFacturaDesdePedido({ client, idFactura, idPedido, row });
      detallesTotal = roundMoney(detallesTotal + inserted.totalDetalle);
    }
    const deliveryFacturado = await insertDetalleFacturaDelivery({ client, idFactura, idPedido, costoEnvio });

    const baseFacturada = roundMoney(detallesTotal + deliveryFacturado);
    const totalFacturadoCalculado = roundMoney(baseFacturada + isvPedido);
    if (Math.abs(totalFacturadoCalculado - totalPendiente) > 0.05) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, code: 'PEDIDO_FACTURA_NO_CUADRA', message: 'El detalle facturado no cuadra con el total del pedido.' });
    }

    const observacionPago = normalizePedidoText(req.body?.observacion_pago, 250);
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
        totalPendiente,
        userId,
        Number(sessionActiva.data.id_sesion_caja),
        idFactura,
        observacionPago
      ]
    );

    await updatePedidoLegacyPagoConfirmado({ client, idPedido, userId });

    const acumulacionFidelizacion = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura,
      idPedido,
      idCliente: parseOptionalPositiveInt(pedido.id_cliente),
      idSucursal: idSucursalPedido,
      idUsuarioEjecutor: userId,
      montoFactura: totalPendiente
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Pago registrado correctamente.',
      id_pedido: idPedido,
      id_factura: idFactura,
      codigo_venta: correlativoVenta.codigo,
      estado_pago: PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO,
      total: totalPendiente,
      monto_pagado: totalPendiente,
      monto_pendiente: 0,
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
    client.release();
  }
});

router.post('/ventas', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const discountIntent = hasDiscountIntentInPayload(req.body);
  const canApplyDiscount = await requestHasAnyPermission(req, [VENTAS_DESCUENTO_APLICAR_PERMISSION]);
  if (discountIntent && !canApplyDiscount) {
    return res.status(403).json({
      error: true,
      code: 'VENTAS_DESCUENTO_NO_AUTORIZADO',
      message: 'No tienes permiso para aplicar descuentos en ventas.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const scope = await resolveRequestUserSucursalScope(req, client);
    const userId = parseOptionalPositiveInt(scope.idUsuario);
    const prepared = await buildVentaPayload({
      client,
      body: req.body,
      userId,
      sucursalScope: scope,
      canApplyDiscount
    });

    if (!prepared.ok) {
      await client.query('ROLLBACK');
      return res.status(prepared.status).json(prepared.body);
    }

    const venta = prepared.data;
    const allLines = [...venta.all_lines];
    const correlativoVenta = await generarCodigoDocumento({
      client,
      idSucursal: venta.id_sucursal,
      tipoDocumento: 'VENTA'
    });

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

    let idPedido = null;

    if (!venta.requires_pedido || !Array.isArray(venta.pedido_lines) || venta.pedido_lines.length === 0) {
      throw {
        httpStatus: 409,
        code: 'VENTAS_PEDIDO_REQUERIDO',
        publicMessage: 'No se pudo completar la venta: se requiere pedido de cocina.'
      };
    }

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
        RETURNING id_pedido
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

    idPedido = pedidoResult.rows[0].id_pedido;

    const hasDetallePedidoConfiguracionMenu = await hasColumn(
      client,
      'detalle_pedido',
      'configuracion_menu'
    );

    const pedidoLineRefs = [];
    for (const line of venta.pedido_lines) {
      const configuracionMenu = buildComplementLineConfig(line);

      let insertedDetallePedido;
      if (hasDetallePedidoConfiguracionMenu) {
        insertedDetallePedido = await client.query(
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
              observacion,
              configuracion_menu
            )
            VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9::jsonb)
            RETURNING id_detalle_pedido
          `,
          [
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.observacion,
            configuracionMenu ? JSON.stringify(configuracionMenu) : null
          ]
        );
      } else {
        insertedDetallePedido = await client.query(
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
              observacion
            )
            VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
            RETURNING id_detalle_pedido
          `,
          [
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.observacion
          ]
        );
      }

      const complementSnapshot = buildComplementSnapshot(line);
      pedidoLineRefs.push({
        ...line,
        id_detalle_pedido: Number(insertedDetallePedido.rows?.[0]?.id_detalle_pedido || 0),
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
          descuento: roundMoney(line.descuento),
          observacion: line.observacion || null,
          componentes: complementSnapshot
        }
      });
    }
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

    const idFactura = facturaResult.rows[0].id_factura;
    const facturacionVenta = await obtenerConfigFacturacionParaVenta(client, venta.id_sucursal);
    await aplicarSnapshotEnFactura(
      client,
      idFactura,
      facturacionVenta.snapshot,
      facturacionVenta.idConfig
    );

    const idMetodoPago = parseOptionalPositiveInt(venta.id_metodo_pago);
    if (!idMetodoPago) {
      throw {
        httpStatus: 409,
        code: 'VENTAS_METODO_PAGO_INVALIDO',
        publicMessage: 'No se pudo resolver el metodo de pago de la venta.'
      };
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

    for (const [index, line] of venta.all_lines.entries()) {
      const pedidoRef = pedidoLineRefs[index] || null;
      const complementSnapshot = buildComplementSnapshot(line);
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
          line.id_producto,
          line.id_descuento,
          line.cantidad,
          line.precio_unitario,
          line.sub_total,
          line.total_linea,
          idPedido,
          pedidoRef?.id_detalle_pedido || null,
          pedidoRef?.tipo_item || normalizeTipoItem(line.kind),
          line.id_receta,
          line.id_combo,
          JSON.stringify(
            pedidoRef?.origen_snapshot || {
              tipo_item: normalizeTipoItem(line.kind),
              nombre_item: line.nombre_item || null,
              id_producto: line.id_producto || null,
              id_receta: line.id_receta || null,
              id_combo: line.id_combo || null,
              cantidad: Number(line.cantidad || 0),
              precio_unitario: roundMoney(line.precio_unitario),
              total_detalle: roundMoney(line.total_linea),
              descuento: roundMoney(line.descuento),
              observacion: line.observacion || null,
              componentes: complementSnapshot
            }
          )
        ]
      );

      const idDetalleFactura = Number(detalleFacturaResult.rows?.[0]?.id_detalle_factura || 0);
      if (idDetalleFactura > 0) {
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
            pedidoRef?.id_detalle_pedido || null,
            pedidoRef?.tipo_item || normalizeTipoItem(line.kind),
            line.id_producto || null,
            line.id_receta || null,
            line.id_combo || null,
            JSON.stringify(
              pedidoRef?.origen_snapshot || {
                tipo_item: normalizeTipoItem(line.kind),
                nombre_item: line.nombre_item || null,
                id_producto: line.id_producto || null,
                id_receta: line.id_receta || null,
                id_combo: line.id_combo || null,
                cantidad: Number(line.cantidad || 0),
                precio_unitario: roundMoney(line.precio_unitario),
                total_detalle: roundMoney(line.total_linea),
                descuento: roundMoney(line.descuento),
                observacion: line.observacion || null,
                componentes: complementSnapshot
              }
            )
          ]
        );
      }
    }

    const acumulacionFidelizacion = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura,
      idPedido,
      idCliente: venta.id_cliente,
      idSucursal: venta.id_sucursal,
      idUsuarioEjecutor: venta.id_usuario,
      montoFactura: venta.total
    });

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Venta creada exitosamente.',
      id_factura: idFactura,
      id_pedido: idPedido,
      numero_venta: correlativoVenta.codigo,
      codigo_venta: correlativoVenta.codigo,
      total: venta.total,
      venta_directa: idPedido === null,
      fidelizacion: acumulacionFidelizacion.created
        ? {
            puntos_acumulados: acumulacionFidelizacion.points,
            saldo_nuevo: acumulacionFidelizacion.saldoNuevo
          }
        : null
    });
  } catch (err) {
    await client.query('ROLLBACK');
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
    client.release();
  }
});


export default router;
