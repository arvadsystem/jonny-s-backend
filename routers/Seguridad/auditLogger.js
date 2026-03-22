import pool from '../../config/db-connection.js';
import { getClientIp } from '../../utils/security/clientInfo.js';

const MODULO_SEGURIDAD = 'SEGURIDAD';
const DEFAULT_ACTION = 'SISTEMA_ACCION';
const DEFAULT_MODULE = 'SISTEMA';
const DEFAULT_TABLE = 'N_D';
const DEFAULT_IP = '-';
const DEFAULT_ID_REGISTRO = 0;
const ACTION_MAX = 50;
const DESC_MAX = 100;
const MODULO_MAX = 60;
const TABLE_MAX = 60;
const ROLE_CACHE_TTL_MS = 120_000;
const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'PASSWORD',
  'PASS',
  'CLAVE',
  'CONTRASENA',
  'TOKEN',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'CSRF',
  'CSRF_TOKEN',
  'AUTHORIZATION',
  'COOKIE',
  'SET_COOKIE',
  'SECRET',
  'JWT'
]);

let hasBitacorasPromise = null;
const roleCache = new Map();

const parsePositiveInt = (value) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const truncateText = (value, maxLen) => {
  const text = String(value ?? '').trim();
  if (!Number.isInteger(maxLen) || maxLen <= 0) return text;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
};

const normalizeToken = (value, { max = 64, fallback = '' } = {}) => {
  const normalized = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toUpperCase();

  const safe = normalized || fallback;
  return truncateText(safe, max);
};

const isSensitiveKey = (key) => {
  const normalized = String(key ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const compact = normalized.replace(/_/g, '');

  if (!normalized) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return [...SENSITIVE_KEYS].some((token) => {
    const compactToken = token.replace(/_/g, '');
    return normalized.includes(token) || compact.includes(compactToken);
  });
};

export const sanitizeAuditPayload = (value, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditPayload(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const output = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        output[key] = REDACTED;
      } else {
        output[key] = sanitizeAuditPayload(val, seen);
      }
    }
    return output;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
};

const toJsonObject = (value) => {
  const sanitized = sanitizeAuditPayload(value);
  if (sanitized === null || sanitized === undefined) return {};
  if (Array.isArray(sanitized)) return { items: sanitized };
  if (typeof sanitized === 'object') return sanitized;
  return { value: sanitized };
};

export const normalizeRoleName = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();

export const resolveActorRole = async (actorId, reqUser = null) => {
  const actor = parsePositiveInt(actorId);
  if (!actor) return 'sin_rol';

  const tokenRoles = Array.isArray(reqUser?.roles)
    ? reqUser.roles.map(normalizeRoleName).filter(Boolean)
    : [];
  if (tokenRoles.length) return tokenRoles[0];

  const cached = roleCache.get(actor);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.role;

  const roleSql = `
    SELECT r.nombre
    FROM roles_usuarios ru
    INNER JOIN roles r ON r.id_rol = ru.id_rol
    WHERE ru.id_usuario = $1
    ORDER BY CASE
      WHEN UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN' THEN 0
      ELSE 1
    END, r.id_rol ASC
    LIMIT 1
  `;

  const roleRes = await pool.query(roleSql, [actor]);
  const role = normalizeRoleName(roleRes.rows?.[0]?.nombre) || 'sin_rol';

  roleCache.set(actor, { role, expiresAt: now + ROLE_CACHE_TTL_MS });
  return role;
};

const toShortDescription = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'Accion administrativa del sistema';
  return truncateText(text, DESC_MAX);
};

const buildDefaultDescription = ({ action, tablaAfectada, idRegistro }) => {
  const table = tablaAfectada || DEFAULT_TABLE;
  const target = Number.isInteger(idRegistro) && idRegistro > 0 ? `#${idRegistro}` : '#0';
  return `${action} sobre ${table} (${target})`;
};

const hasBitacorasTable = async () => {
  if (!hasBitacorasPromise) {
    hasBitacorasPromise = pool
      .query(`SELECT to_regclass('public.bitacoras') AS reg`)
      .then((r) => Boolean(r.rows?.[0]?.reg))
      .catch((err) => {
        hasBitacorasPromise = null;
        throw err;
      });
  }
  return hasBitacorasPromise;
};

export const prepareAuditRecord = ({
  req,
  actorId,
  accion,
  objetivo = {},
  modulo = MODULO_SEGURIDAD,
  descripcion = '',
  detalle = {},
  datosAntes,
  datosDespues,
  ip_origen
} = {}) => {
  const action = normalizeToken(accion, { max: ACTION_MAX, fallback: DEFAULT_ACTION });
  const actor = parsePositiveInt(actorId) ?? DEFAULT_ID_REGISTRO;
  const tablaAfectada = normalizeToken(
    objetivo?.tabla_afectada ?? objetivo?.tabla ?? DEFAULT_TABLE,
    { max: TABLE_MAX, fallback: DEFAULT_TABLE }
  );
  const idRegistro = parsePositiveInt(objetivo?.id_registro ?? objetivo?.id) ?? DEFAULT_ID_REGISTRO;
  const moduloValue = normalizeToken(modulo || DEFAULT_MODULE, { max: MODULO_MAX, fallback: DEFAULT_MODULE });
  const ipOrigenRaw = String(req ? getClientIp(req) : ip_origen ?? '').trim();
  const ipOrigen = ipOrigenRaw || DEFAULT_IP;

  const detailJson = toJsonObject(detalle);
  const beforeRaw = datosAntes !== undefined ? datosAntes : detailJson?.datos_antes ?? detailJson?.before ?? {};
  const afterRaw = datosDespues !== undefined ? datosDespues : detailJson?.datos_despues ?? detailJson?.after ?? detailJson ?? {};
  const beforeJson = toJsonObject(beforeRaw);
  const afterJson = toJsonObject(afterRaw);

  const description = toShortDescription(
    descripcion || buildDefaultDescription({ action, tablaAfectada, idRegistro })
  );

  return {
    accion: action,
    descripcion: description,
    id_usuario: actor,
    modulo: moduloValue,
    tabla_afectada: tablaAfectada,
    id_registro: idRegistro,
    ip_origen: ipOrigen,
    datos_antes: beforeJson,
    datos_despues: afterJson
  };
};

export const insertSecurityAuditLog = async (payload = {}) => {
  const hasTable = await hasBitacorasTable();
  if (!hasTable) return { inserted: false, reason: 'TABLE_NOT_FOUND' };

  const record = prepareAuditRecord(payload);
  if (!record.accion) return { inserted: false, reason: 'MISSING_ACTION' };
  if (!record.id_usuario || record.id_usuario <= 0) return { inserted: false, reason: 'MISSING_ACTOR' };

  const sql = `
    INSERT INTO bitacoras (
      accion,
      descripcion,
      fecha_hora,
      id_usuario,
      modulo,
      tabla_afectada,
      id_registro,
      ip_origen,
      datos_antes,
      datos_despues
    )
    VALUES (
      $1,
      $2,
      timezone('America/Tegucigalpa', now()),
      $3,
      $4,
      $5,
      $6,
      $7,
      $8::jsonb,
      $9::jsonb
    )
    RETURNING id_bitacora, fecha_hora
  `;

  const result = await pool.query(sql, [
    record.accion,
    record.descripcion,
    record.id_usuario,
    record.modulo,
    record.tabla_afectada,
    record.id_registro,
    record.ip_origen,
    record.datos_antes,
    record.datos_despues
  ]);

  return {
    inserted: true,
    row: result.rows?.[0] || null,
    record
  };
};
