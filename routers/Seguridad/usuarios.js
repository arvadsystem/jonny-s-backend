/**
 * routers/seguridad/usuarios.js
 * HU1085 (Sprint 3): Listado global de usuarios (solo Super Admin)
 *
 * Requisitos:
 * - Tabla con todos los usuarios (filtros + paginación)
 * - Campos mínimos: id, usuario, nombre, rol, estado (activo/bloqueado), último acceso, sesiones activas (contador)
 */

import express from 'express';
import pool from '../../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../../middleware/checkPermission.js';
import { timestampAsHNToISO, toHNWallTimestamp } from '../../utils/dates.js';
import { insertSecurityAuditLog } from './auditLogger.js';
import { securityReadLimiter, securityWriteLimiter } from './securityRateLimit.js';

const router = express.Router();

const PERMISOS_USUARIOS_VER = [
  'SEGURIDAD_USUARIOS_VER',
  'SEGURIDAD_USUARIOS_AUDITORIA_VER',
  'SEGURIDAD_VER'
];
const PERMISOS_USUARIOS_SESIONES = [
  'SEGURIDAD_USUARIOS_AUDITORIA_SESIONES_VER',
  'SEGURIDAD_USUARIOS_AUDITORIA_VER',
  'SEGURIDAD_USUARIOS_VER',
  'SEGURIDAD_VER'
];
const PERMISOS_USUARIOS_LOGINS = [
  'SEGURIDAD_USUARIOS_AUDITORIA_LOGINS_VER',
  'SEGURIDAD_USUARIOS_AUDITORIA_VER',
  'SEGURIDAD_USUARIOS_VER',
  'SEGURIDAD_VER'
];
const PERMISOS_USUARIOS_CERRAR = [
  'SEGURIDAD_USUARIOS_SESIONES_CERRAR',
  'SEGURIDAD_SESIONES_CERRAR_GLOBAL',
  'SEGURIDAD_SESIONES_CERRAR'
];
const PERMISOS_BITACORAS_VER = [
  'SEGURIDAD_VER',
  'SEGURIDAD_LOGINS_VER',
  'SEGURIDAD_USUARIOS_AUDITORIA_VER',
  'SEGURIDAD_SESIONES_VER_GLOBAL'
];
const MAX_SEARCH_LEN = 120;

// =====================================================
// Helpers
// =====================================================
const requireSuperAdmin = async (req, res) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (!isSuperAdmin) {
    res.status(403).json({ error: true, message: 'Acceso denegado: solo Super Admin' });
    return false;
  }
  return true;
};

const clampInt = (value, def, min, max) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const toHNISO = (val) => timestampAsHNToISO(val);

const toUTCISO = (value) => {
  if (!value) return null;

  if (value instanceof Date) return value.toISOString();

  let s = String(value).trim().replace(' ', 'T');
  const hasTZ = /Z$|[+-]\d{2}:\d{2}$/.test(s);
  if (!hasTZ) s = `${s}Z`;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
};

const normalizeBitacoraFecha = (row) => {
  const modulo = String(row?.modulo ?? '').trim();

  // Legacy: registros viejos sin modulo suelen estar guardados como UTC wall-clock.
  // Nuevos (Seguridad y los que migremos) usan hora Honduras.
  if (!modulo) return toUTCISO(row?.fecha_hora);

  return toHNISO(row?.fecha_hora);
};

const tryParseJsonObject = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeFieldName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();

const parseLegacyPlainValue = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === '-') return '';
  if (text === 'null') return '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  const numeric = Number(text);
  if (!Number.isNaN(numeric) && text === String(numeric)) return numeric;
  return text;
};

const parseLegacyPairs = (valueText) => {
  const text = String(valueText ?? '').trim();
  if (!text || text === '-') return {};

  const output = {};
  const chunks = text.split('|').map((chunk) => chunk.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const idx = chunk.indexOf(':');
    if (idx < 0) continue;
    const key = normalizeFieldName(chunk.slice(0, idx));
    if (!key) continue;
    const rawValue = chunk.slice(idx + 1).trim();
    output[key] = parseLegacyPlainValue(rawValue);
  }
  return output;
};

const LEGACY_SOFT_DELETE_ENTITIES = new Set([
  'PRODUCTOS',
  'INSUMOS',
  'CATEGORIAS_PRODUCTOS',
  'CATEGORIAS_INSUMOS'
]);

const parseLegacyBooleanLike = (value) => {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['true', '1', 't', 'si', 'yes', 'y', 'activo', 'activa'].includes(s)) return true;
  if (['false', '0', 'f', 'no', 'n', 'inactivo', 'inactiva'].includes(s)) return false;
  return null;
};

const mapLegacyTechnicalPayload = (payload, row) => {
  const obj = tryParseJsonObject(payload);
  if (!obj) return { data: payload, detail: '' };

  const hasEnvelopeShape = Object.prototype.hasOwnProperty.call(obj, 'request')
    || Object.prototype.hasOwnProperty.call(obj, 'metadata')
    || Object.prototype.hasOwnProperty.call(obj, 'response');
  const hasSummaryShape = Object.prototype.hasOwnProperty.call(obj, 'accion_real')
    || Object.prototype.hasOwnProperty.call(obj, 'campos')
    || Object.prototype.hasOwnProperty.call(obj, 'valores')
    || Object.prototype.hasOwnProperty.call(obj, 'detalle')
    || Object.prototype.hasOwnProperty.call(obj, 'rol');

  if (!hasEnvelopeShape && !hasSummaryShape) return { data: payload, detail: '' };

  const metadata = tryParseJsonObject(obj.metadata) || {};
  const request = tryParseJsonObject(obj.request) || {};
  const body = tryParseJsonObject(request.body) || {};

  const method = String(metadata.method || '').toUpperCase();
  let actionLabel = method === 'POST'
    ? 'CREAR'
    : (method === 'DELETE' ? 'ELIMINAR' : 'ACTUALIZAR');
  const modulo = String(metadata.modulo || row?.modulo || '').trim() || 'SISTEMA';
  const entidad = String(metadata.tabla_afectada || row?.tabla_afectada || modulo).trim() || 'SISTEMA';
  const registroId = Number(metadata.id_registro ?? row?.id_registro ?? 0) || 0;

  let campos = [];
  let cambios = {};

  if (typeof body.campo === 'string' && Object.prototype.hasOwnProperty.call(body, 'valor')) {
    const field = normalizeFieldName(body.campo);
    if (field) {
      campos = [field];
      cambios = { [field]: body.valor };
    }
  } else if (typeof body.columna_id === 'string' && Object.prototype.hasOwnProperty.call(body, 'valor_id')) {
    const field = normalizeFieldName(body.columna_id);
    if (field) {
      campos = [field];
      cambios = { [field]: body.valor_id };
    }
  } else {
    const entries = Object.entries(body).filter(([key, value]) => {
      if (value === undefined) return false;
      const k = normalizeFieldName(key);
      if (!k) return false;
      if (k === 'id' || k === 'created_by' || k === 'updated_by') return false;
      if (/^id(_|$)/i.test(k)) return false;
      if (k === 'token' || k === 'password' || k === 'csrf_token') return false;
      return true;
    }).slice(0, 8);

    campos = entries.map(([key]) => normalizeFieldName(key)).filter(Boolean);
    cambios = Object.fromEntries(entries);
  }

  if (!Object.keys(cambios).length && hasSummaryShape) {
    const valuesFromSummary = parseLegacyPairs(obj.valores);
    if (Object.keys(valuesFromSummary).length) {
      cambios = valuesFromSummary;
      campos = Object.keys(valuesFromSummary);
    } else {
      const camposText = String(obj.campos ?? '').trim();
      if (camposText && camposText !== '-') {
        campos = camposText
          .split(',')
          .map((item) => normalizeFieldName(item))
          .filter(Boolean);
      }
    }
  }

  const estadoDespues = parseLegacyBooleanLike(cambios.estado);
  const entidadUpper = String(entidad).trim().toUpperCase();

  if (actionLabel === 'ELIMINAR' && (estadoDespues === false || LEGACY_SOFT_DELETE_ENTITIES.has(entidadUpper))) {
    actionLabel = 'INACTIVAR';
  } else if (actionLabel === 'ACTUALIZAR' && estadoDespues !== null) {
    actionLabel = estadoDespues ? 'ACTIVAR' : 'INACTIVAR';
  }

  const detail = String(obj.detalle || '').trim()
    || `${actionLabel === 'ELIMINAR' ? 'Elimino' : (actionLabel === 'CREAR' ? 'Creo' : (actionLabel === 'INACTIVAR' ? 'Inactivo' : (actionLabel === 'ACTIVAR' ? 'Activo' : 'Actualizo')))} ${entidad}${registroId > 0 ? ` #${registroId}` : ''}${campos.length ? `: ${campos.join(', ')}` : ''}`.slice(0, 100);

  return {
    detail,
    data: cambios
  };
};

const normalizeEstado = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;

  // Acepta: activo/bloqueado, true/false, 1/0
  if (s === 'activo' || s === 'true' || s === '1') return true;
  if (s === 'bloqueado' || s === 'false' || s === '0') return false;

  return null;
};

const parsePositiveInt = (value) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normalizeLoginEstado = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['success', 'exito', 'exitoso', 'exitosos', 'ok', 'true', '1'].includes(s)) return true;
  if (['fail', 'failed', 'fallido', 'fallidos', 'error', 'false', '0'].includes(s)) return false;
  return null;
};

const sanitizeSearchTerm = (value) =>
  String(value ?? '').trim().slice(0, MAX_SEARCH_LEN);

// =====================================================
// HU1085: Listado global de usuarios
// =====================================================

/**
 * GET /seguridad/usuarios/global
 * Query:
 * - buscar (opcional): usuario / nombre / apellido / rol
 * - estado (opcional): activo | bloqueado
 * - limit (default 10)
 * - offset (default 0)
 */
router.get('/usuarios/global', securityReadLimiter, checkPermission(PERMISOS_USUARIOS_VER), async (req, res) => {
  try {
    const user = req.user || req.usuario;

    if (!user?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }

    // 🔒 Solo Super Admin
    if (!(await requireSuperAdmin(req, res))) return;

    const buscar = sanitizeSearchTerm(req.query.buscar);
    const estadoBool = normalizeEstado(req.query.estado);

    const limit = clampInt(req.query.limit, 10, 1, 50);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

    const where = [];
    const params = [];
    let i = 1;

    if (estadoBool !== null) {
      where.push(`u.estado = $${i++}`);
      params.push(estadoBool);
    }

    if (buscar) {
      const like = `%${buscar}%`;
      where.push(`(
        u.nombre_usuario ILIKE $${i} OR
        COALESCE(p.nombre,'') ILIKE $${i} OR
        COALESCE(p.apellido,'') ILIKE $${i} OR
        EXISTS (
          SELECT 1
          FROM roles_usuarios ru2
          INNER JOIN roles r2 ON r2.id_rol = ru2.id_rol
          WHERE ru2.id_usuario = u.id_usuario
            AND r2.nombre ILIKE $${i}
        )
      )`);
      params.push(like);
      i += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // COUNT total
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      ${whereSql}
    `;

    const countRes = await pool.query(countSql, params);
    const total = countRes.rows?.[0]?.total ?? 0;

    // DATA
    const dataSql = `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        COALESCE(p.nombre,'') AS nombre,
        COALESCE(p.apellido,'') AS apellido,
        u.estado,
        COALESCE(la.ultimo_acceso, NULL) AS ultimo_acceso,
        COALESCE(sc.sesiones_activas, 0)::int AS sesiones_activas,
        COALESCE(STRING_AGG(DISTINCT r.nombre, ', '), '—') AS rol
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN roles_usuarios ru ON ru.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ru.id_rol
      LEFT JOIN (
        SELECT id_usuario, MAX(fecha_hora) AS ultimo_acceso
        FROM logins
        WHERE exito = TRUE
        GROUP BY id_usuario
      ) la ON la.id_usuario = u.id_usuario
      LEFT JOIN (
        SELECT id_usuario, COUNT(*)::int AS sesiones_activas
        FROM sesiones_activas
        WHERE activa = TRUE
        GROUP BY id_usuario
      ) sc ON sc.id_usuario = u.id_usuario
      ${whereSql}
      GROUP BY
        u.id_usuario,
        u.nombre_usuario,
        p.nombre,
        p.apellido,
        u.estado,
        la.ultimo_acceso,
        sc.sesiones_activas
      ORDER BY u.id_usuario ASC
      LIMIT $${i++} OFFSET $${i++}
    `;

    const dataRes = await pool.query(dataSql, [...params, limit, offset]);

    const rows = dataRes.rows.map((r) => ({
      ...r,
      ultimo_acceso: toHNISO(r.ultimo_acceso)
    }));

    return res.json({
      error: false,
      total,
      limit,
      offset,
      rows
    });
  } catch (err) {
    console.error('GET /seguridad/usuarios/global error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * GET /seguridad/usuarios/:id/detalle
 * HU1887: Perfil resumido del usuario para auditoria.
 */
router.get('/usuarios/:id/detalle', securityReadLimiter, checkPermission(PERMISOS_USUARIOS_VER), async (req, res) => {
  try {
    const actor = req.user || req.usuario;
    if (!actor?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!(await requireSuperAdmin(req, res))) return;

    const idUsuario = parsePositiveInt(req.params.id);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id de usuario invalido' });
    }

    const profileSql = `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        u.estado,
        u.foto_perfil,
        u.id_empleado,
        p.id_persona,
        COALESCE(p.nombre, '') AS nombre,
        COALESCE(p.apellido, '') AS apellido,
        p.dni,
        p.rtn,
        p.genero,
        p.fecha_nacimiento,
        t.telefono,
        c.direccion_correo AS correo,
        d.direccion,
        COALESCE(STRING_AGG(DISTINCT r.nombre, ', '), '—') AS rol
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
      LEFT JOIN roles_usuarios ru ON ru.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ru.id_rol
      WHERE u.id_usuario = $1
      GROUP BY
        u.id_usuario,
        u.nombre_usuario,
        u.estado,
        u.foto_perfil,
        u.id_empleado,
        p.id_persona,
        p.nombre,
        p.apellido,
        p.dni,
        p.rtn,
        p.genero,
        p.fecha_nacimiento,
        t.telefono,
        c.direccion_correo,
        d.direccion
      LIMIT 1
    `;

    const [profileRes, lastAccessRes, sessionsCountRes] = await Promise.all([
      pool.query(profileSql, [idUsuario]),
      pool.query(
        `
          SELECT fecha_hora, ip_origen, navegador, sistema_operativo, dispositivo
          FROM logins
          WHERE id_usuario = $1 AND exito = TRUE
          ORDER BY fecha_hora DESC
          LIMIT 1
        `,
        [idUsuario]
      ),
      pool.query(
        `
          SELECT COUNT(*)::int AS sesiones_activas
          FROM sesiones_activas
          WHERE id_usuario = $1 AND activa = TRUE
        `,
        [idUsuario]
      )
    ]);

    if (profileRes.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const perfil = profileRes.rows[0];
    const ultimo_acceso = lastAccessRes.rows?.[0]
      ? {
          ...lastAccessRes.rows[0],
          fecha_hora: toHNISO(lastAccessRes.rows[0].fecha_hora)
        }
      : null;

    return res.json({
      error: false,
      perfil: {
        ...perfil,
        fecha_nacimiento: toHNISO(perfil.fecha_nacimiento)
      },
      ultimo_acceso,
      sesiones_activas: sessionsCountRes.rows?.[0]?.sesiones_activas ?? 0
    });
  } catch (err) {
    console.error('GET /seguridad/usuarios/:id/detalle error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * GET /seguridad/usuarios/:id/sesiones
 * HU1887: Sesiones de un usuario especifico.
 */
router.get('/usuarios/:id/sesiones', securityReadLimiter, checkPermission(PERMISOS_USUARIOS_SESIONES), async (req, res) => {
  try {
    const actor = req.user || req.usuario;
    if (!actor?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!(await requireSuperAdmin(req, res))) return;

    const idUsuario = parsePositiveInt(req.params.id);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id de usuario invalido' });
    }

    const estadoRaw = String(req.query.estado ?? '').trim().toLowerCase();
    const limit = clampInt(req.query.limit, 10, 1, 50);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

    const where = ['id_usuario = $1'];
    const params = [idUsuario];

    if (estadoRaw === 'activas') where.push('activa = TRUE');
    if (estadoRaw === 'cerradas') where.push('activa = FALSE');

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM sesiones_activas
      ${whereSql}
    `;

    const dataSql = `
      SELECT
        id_sesion,
        id_usuario,
        ip_origen,
        dispositivo,
        navegador,
        sistema_operativo,
        ubicacion,
        fecha_inicio,
        ultima_actividad,
        activa,
        fecha_cierre,
        motivo_cierre,
        (id_sesion = $2) AS es_actual
      FROM sesiones_activas
      ${whereSql}
      ORDER BY activa DESC, ultima_actividad DESC
      LIMIT $3 OFFSET $4
    `;

    const [countRes, dataRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(dataSql, [idUsuario, actor.sid || null, limit, offset])
    ]);

    const rows = dataRes.rows.map((s) => ({
      ...s,
      fecha_inicio: toHNISO(s.fecha_inicio),
      ultima_actividad: toHNISO(s.ultima_actividad),
      fecha_cierre: toHNISO(s.fecha_cierre)
    }));

    return res.json({
      error: false,
      total: countRes.rows?.[0]?.total ?? 0,
      limit,
      offset,
      rows
    });
  } catch (err) {
    console.error('GET /seguridad/usuarios/:id/sesiones error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * GET /seguridad/usuarios/:id/logins
 * HU1887: Logins de usuario seleccionado (exitosos y fallidos), con filtros.
 */
router.get('/usuarios/:id/logins', securityReadLimiter, checkPermission(PERMISOS_USUARIOS_LOGINS), async (req, res) => {
  try {
    const actor = req.user || req.usuario;
    if (!actor?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!(await requireSuperAdmin(req, res))) return;

    const idUsuario = parsePositiveInt(req.params.id);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id de usuario invalido' });
    }

    const userRes = await pool.query(
      `SELECT nombre_usuario FROM usuarios WHERE id_usuario = $1 LIMIT 1`,
      [idUsuario]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const nombreUsuario = String(userRes.rows[0].nombre_usuario ?? '').trim();
    const estadoBool = normalizeLoginEstado(req.query.estado);
    const desde = toHNWallTimestamp(req.query.desde, { endOfDay: false });
    const hasta = toHNWallTimestamp(req.query.hasta, { endOfDay: true });
    const limit = clampInt(req.query.limit, 10, 1, 50);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

    const where = [
      `(l.id_usuario = $1 OR LOWER(COALESCE(l.nombre_usuario_intentado, '')) = LOWER($2))`
    ];
    const params = [idUsuario, nombreUsuario];
    let i = 3;

    if (estadoBool === true) {
      where.push(`l.exito = TRUE`);
    } else if (estadoBool === false) {
      // Incluye null como fallo para cubrir registros legacy sin bandera booleana.
      where.push(`(l.exito = FALSE OR l.exito IS NULL)`);
    }

    if (desde) {
      where.push(`l.fecha_hora >= $${i++}::timestamp`);
      params.push(desde);
    }

    if (hasta) {
      where.push(`l.fecha_hora <= $${i++}::timestamp`);
      params.push(hasta);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM logins l
      LEFT JOIN usuarios u ON u.id_usuario = l.id_usuario
      ${whereSql}
    `;

    const dataSql = `
      SELECT
        l.id_login,
        l.fecha_hora,
        l.ip_origen,
        l.exito,
        l.mensaje_error,
        l.dispositivo,
        l.navegador,
        l.sistema_operativo,
        l.nombre_usuario_intentado,
        l.id_usuario,
        u.nombre_usuario AS usuario
      FROM logins l
      LEFT JOIN usuarios u ON u.id_usuario = l.id_usuario
      ${whereSql}
      ORDER BY l.fecha_hora DESC
      LIMIT $${i++} OFFSET $${i++}
    `;

    const [countRes, dataRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(dataSql, [...params, limit, offset])
    ]);

    const rows = dataRes.rows.map((r) => ({
      ...r,
      fecha_hora: toHNISO(r.fecha_hora)
    }));

    return res.json({
      error: false,
      total: countRes.rows?.[0]?.total ?? 0,
      limit,
      offset,
      rows
    });
  } catch (err) {
    console.error('GET /seguridad/usuarios/:id/logins error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * GET /seguridad/bitacoras
 * Bitacoras generales de Seguridad (solo Super Admin).
 * Query:
 * - usuario (opcional): id_usuario o username/nombre
 * - limit (default 10)
 * - offset (default 0)
 */
router.get('/bitacoras', securityReadLimiter, checkPermission(PERMISOS_BITACORAS_VER), async (req, res) => {
  try {
    const actor = req.user || req.usuario;
    if (!actor?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!(await requireSuperAdmin(req, res))) return;

    const hasTableRes = await pool.query(`SELECT to_regclass('public.bitacoras') AS reg`);
    if (!hasTableRes.rows?.[0]?.reg) {
      return res.status(404).json({ error: true, message: 'Tabla bitacoras no disponible' });
    }

    const limit = clampInt(req.query.limit, 10, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
    const usuarioTerm = sanitizeSearchTerm(req.query.usuario);
    const actorId = parsePositiveInt(usuarioTerm);

    const where = [];
    const params = [];
    let i = 1;

    if (usuarioTerm) {
      const like = `%${usuarioTerm}%`;
      if (actorId) {
        where.push(`(
          b.id_usuario = $${i} OR
          COALESCE(u.nombre_usuario, '') ILIKE $${i + 1} OR
          COALESCE(p.nombre, '') ILIKE $${i + 1} OR
          COALESCE(p.apellido, '') ILIKE $${i + 1}
        )`);
        params.push(actorId, like);
        i += 2;
      } else {
        where.push(`(
          COALESCE(u.nombre_usuario, '') ILIKE $${i} OR
          COALESCE(p.nombre, '') ILIKE $${i} OR
          COALESCE(p.apellido, '') ILIKE $${i}
        )`);
        params.push(like);
        i += 1;
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const fromSql = `
      FROM bitacoras b
      LEFT JOIN usuarios u ON u.id_usuario = b.id_usuario
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN LATERAL (
        SELECT sa.ip_origen
        FROM sesiones_activas sa
        WHERE sa.id_usuario = b.id_usuario
          AND COALESCE(sa.ip_origen, '') <> ''
        ORDER BY sa.activa DESC, sa.ultima_actividad DESC NULLS LAST, sa.fecha_inicio DESC NULLS LAST
        LIMIT 1
      ) sa_last ON TRUE
      LEFT JOIN LATERAL (
        SELECT l.ip_origen
        FROM logins l
        WHERE l.id_usuario = b.id_usuario
          AND COALESCE(l.ip_origen, '') <> ''
        ORDER BY l.fecha_hora DESC
        LIMIT 1
      ) lg_last ON TRUE
    `;

    const countSql = `
      SELECT COUNT(*)::int AS total
      ${fromSql}
      ${whereSql}
    `;

    const dataSql = `
      SELECT
        b.id_bitacora,
        b.accion,
        COALESCE(b.descripcion, '') AS descripcion,
        b.fecha_hora,
        b.id_usuario,
        COALESCE(b.modulo, '') AS modulo,
        COALESCE(b.tabla_afectada, '') AS tabla_afectada,
        b.id_registro,
        COALESCE(
          NULLIF(COALESCE(b.ip_origen, ''), ''),
          NULLIF(COALESCE(b.datos_despues->>'ip_origen', ''), ''),
          NULLIF(COALESCE(b.datos_antes->>'ip_origen', ''), ''),
          NULLIF(COALESCE(sa_last.ip_origen, ''), ''),
          NULLIF(COALESCE(lg_last.ip_origen, ''), ''),
          ''
        ) AS ip_origen,
        b.datos_antes,
        b.datos_despues,
        u.nombre_usuario AS actor_usuario,
        TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS actor_nombre,
        COALESCE(
          NULLIF(TRIM(COALESCE(u.nombre_usuario, '')), ''),
          NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''),
          'N/D'
        ) AS usuario_display
      ${fromSql}
      ${whereSql}
      ORDER BY b.fecha_hora DESC, b.id_bitacora DESC
      LIMIT $${i++} OFFSET $${i++}
    `;

    const [countRes, dataRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(dataSql, [...params, limit, offset])
    ]);

    const total = countRes.rows?.[0]?.total ?? 0;
    const rows = dataRes.rows.map((r) => {
      const afterMapped = mapLegacyTechnicalPayload(r.datos_despues, r);
      const beforeMapped = mapLegacyTechnicalPayload(r.datos_antes, r);
      const descripcionRaw = String(r.descripcion || '').trim();

      return {
        ...r,
        descripcion: afterMapped.detail || descripcionRaw,
        datos_antes: beforeMapped.data,
        datos_despues: afterMapped.data,
        fecha_hora: normalizeBitacoraFecha(r)
      };
    });

    return res.json({
      error: false,
      limit,
      offset,
      total,
      rows
    });
  } catch (err) {
    console.error('GET /seguridad/bitacoras error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * POST /seguridad/usuarios/:id/sesiones/cerrar
 * HU1888: Cierra todas las sesiones activas de un usuario (forzado por Super Admin).
 */
router.post('/usuarios/:id/sesiones/cerrar', securityWriteLimiter, checkPermission(PERMISOS_USUARIOS_CERRAR), async (req, res) => {
  try {
    const actor = req.user || req.usuario;
    if (!actor?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!(await requireSuperAdmin(req, res))) return;

    const idUsuario = parsePositiveInt(req.params.id);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id de usuario invalido' });
    }

    const usernameRes = await pool.query(
      `SELECT nombre_usuario FROM usuarios WHERE id_usuario = $1 LIMIT 1`,
      [idUsuario]
    );
    if (usernameRes.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const username = usernameRes.rows[0].nombre_usuario;

    const closeRes = await pool.query(
      `
        UPDATE sesiones_activas
        SET activa = FALSE,
            fecha_cierre = timezone('America/Tegucigalpa', now()),
            motivo_cierre = 'cierre_forzado_superadmin'
        WHERE id_usuario = $1
          AND activa = TRUE
      `,
      [idUsuario]
    );

    await insertSecurityAuditLog({
      req,
      actorId: actor.id_usuario,
      accion: 'CERRAR_SESIONES_USUARIO',
      objetivo: { tabla_afectada: 'usuarios', id_registro: idUsuario },
      descripcion: `SuperAdmin ${actor.id_usuario} cerro sesiones de usuario ${idUsuario}`,
      detalle: {
        actor_id: actor.id_usuario,
        target_user_id: idUsuario,
        username,
        sesiones_cerradas: closeRes.rowCount,
        motivo_cierre: 'cierre_forzado_superadmin'
      }
    });

    if (closeRes.rowCount === 0) {
      return res.json({
        error: false,
        message: 'No hay sesiones activas para cerrar',
        cerradas: 0
      });
    }

    return res.json({
      error: false,
      message: 'Sesiones cerradas correctamente',
      cerradas: closeRes.rowCount
    });
  } catch (err) {
    console.error('POST /seguridad/usuarios/:id/sesiones/cerrar error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

export default router;
