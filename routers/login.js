import express from 'express';
import pool from '../config/db-connection.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authRequired } from '../middleware/auth.js';
import { requireActiveSession } from '../middleware/requireActiveSession.js';
import {
  internalLoginIpLimiter,
  internalLoginAccountIpLimiter
} from '../middleware/rateLimiter.js';
import JWT_SECRET from '../config/jwt.js';
import {
  evaluatePasswordExpiration,
  ensurePasswordChangedAtColumn,
} from '../utils/security/passwordExpiration.js';
import {
  buildAuthRoleCompatFields,
  getUserAuthzSnapshot
} from '../utils/security/authTokenPayload.js';

// helpers de HU78
import { getClientIp, parseUserAgent } from '../utils/security/clientInfo.js';
import { insertLoginLog } from '../utils/security/loginLogger.js';
import { createSession, closeSession } from '../utils/security/sessionService.js';

const router = express.Router();
const LEGACY_BCRYPT_PREFIX_RE = /^\$2[abxy]?\$/i;
const MUST_CHANGE_PASSWORD_FIELDS = [
  'must_change_password',
  'debe_cambiar_clave',
  'requiere_cambio_clave',
  'force_password_change',
  'password_temporal',
];

const parseMustChangePasswordValue = (value) => {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'si', 'yes', 'y', 'activo', 'activa'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'n', 'inactivo', 'inactiva'].includes(normalized)) return false;
  return false;
};

const resolveMustChangePassword = (row) => {
  if (!row || typeof row !== 'object') return false;

  for (const field of MUST_CHANGE_PASSWORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    return parseMustChangePasswordValue(row[field]);
  }

  return false;
};

const getClienteNameSnapshot = async (idUsuario) => {
  const userId = Number.parseInt(String(idUsuario ?? ''), 10);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  const result = await pool.query(
    `
      SELECT
        p.nombre AS nombre_cliente,
        p.apellido AS apellido_cliente,
        NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)), '') AS nombre_completo_cliente,
        NULLIF(TRIM(co.direccion_correo), '') AS correo_cliente,
        NULLIF(TRIM(t.telefono), '') AS telefono_cliente,
        LEFT(REGEXP_REPLACE(COALESCE(t.telefono, ''), '\\D', '', 'g'), 8) AS telefono_cliente_normalizado
      FROM usuarios u
      LEFT JOIN clientes c ON c.id_cliente = u.id_cliente
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN LATERAL (
        SELECT co_inner.direccion_correo
        FROM correos co_inner
        WHERE co_inner.id_correo = p.id_correo
           OR (p.id_correo IS NULL AND co_inner.id_persona = p.id_persona)
        ORDER BY
          CASE WHEN co_inner.id_correo = p.id_correo THEN 0 ELSE 1 END,
          co_inner.id_correo ASC
        LIMIT 1
      ) co ON true
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      WHERE u.id_usuario = $1
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
};

const normalizeRoleName = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

const buildPasswordPolicyFlags = (passwordExpiration) => {
  const ageDays = Number.isInteger(passwordExpiration?.ageDays)
    ? passwordExpiration.ageDays
    : null;
  const excludedByClienteRole = Boolean(passwordExpiration?.excludedByClienteRole);

  const recommendation30d =
    !excludedByClienteRole && ageDays !== null && ageDays >= 30;
  const warning58d =
    !excludedByClienteRole && ageDays !== null && ageDays >= 58 && ageDays < 60;
  const daysToExpire =
    !excludedByClienteRole && ageDays !== null
      ? Math.max(0, 60 - ageDays)
      : null;

  return {
    password_age_days: ageDays,
    password_recommend_change: recommendation30d,
    password_warning_58d: warning58d,
    password_days_to_expire: daysToExpire,
    password_policy_excluded: excludedByClienteRole,
  };
};

const normalizeSameSite = (value, fallback) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'none' || normalized === 'lax' || normalized === 'strict') {
    return normalized;
  }
  return fallback;
};

const authCookieOptions = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'true' || isProd,
    sameSite: normalizeSameSite(process.env.AUTH_COOKIE_SAMESITE, isProd ? 'none' : 'lax'),
    domain: String(process.env.AUTH_COOKIE_DOMAIN || '').trim() || undefined,
    path: '/'
  };
};

const csrfCookieOptions = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: false,
    secure: String(process.env.CSRF_COOKIE_SECURE || '').toLowerCase() === 'true' || isProd,
    sameSite: normalizeSameSite(process.env.CSRF_COOKIE_SAMESITE, isProd ? 'none' : 'lax'),
    domain: String(process.env.CSRF_COOKIE_DOMAIN || '').trim() || undefined,
    path: '/'
  };
};

const CSRF_TOKEN_RE = /^[a-f0-9]{64}$/i;

const getExistingCsrfToken = (req) => {
  const token = String(req?.cookies?.csrf_token || '').trim();
  if (!token) return null;
  return CSRF_TOKEN_RE.test(token) ? token : null;
};

const issueCsrf = (req, res, { reuseIfPresent = false } = {}) => {
  const existingToken = reuseIfPresent ? getExistingCsrfToken(req) : null;
  const csrfToken = existingToken || crypto.randomBytes(32).toString('hex');

  res.cookie('csrf_token', csrfToken, {
    ...csrfCookieOptions(),
    maxAge: 1000 * 60 * 60 * 8 // 8h
  });

  return csrfToken;
};

const verifyLoginPassword = async (plainPassword, storedPassword, userId) => {
  const plain = String(plainPassword ?? '');
  const stored = String(storedPassword ?? '');

  if (!plain || !stored) return false;

  // Contraseña en texto plano — validar y migrar a bcrypt on-the-fly
  if (plain === stored) {
    try {
      if (userId) {
        await pool.query(
          "UPDATE usuarios SET clave = crypt($1, gen_salt('bf', 12)) WHERE id_usuario = $2",
          [plain, userId]
        );
        console.log(`[security] Contraseña migrada a bcrypt para usuario ${userId}`);
      }
    } catch (hashErr) {
      console.error('[security] Error migrando contraseña a bcrypt:', hashErr.message);
    }
    return true;
  }

  if (!LEGACY_BCRYPT_PREFIX_RE.test(stored)) return false;

  const result = await pool.query(
    'SELECT crypt($1::text, $2::text) = $2::text AS ok',
    [plain, stored]
  );

  return Boolean(result.rows?.[0]?.ok);
};

router.post('/login', internalLoginIpLimiter, internalLoginAccountIpLimiter, async (req, res) => {
  const { nombre_usuario, clave } = req.body;

  if (!JWT_SECRET) {
    return res.status(500).json({
      error: true,
      message: 'Configuracion de seguridad incompleta: JWT_SECRET no definido'
    });
  }

  //capturar IP + User-Agent + parseo
  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;
  const { dispositivo, navegador, sistema_operativo } = parseUserAgent(user_agent);

  try {
    await ensurePasswordChangedAtColumn();

    const query = `
      SELECT u.*, e.id_sucursal 
      FROM usuarios u 
      LEFT JOIN empleados e ON u.id_empleado = e.id_empleado 
      LEFT JOIN identidades_auth ia ON u.id_usuario = ia.id_usuario
      WHERE u.nombre_usuario = $1 OR ia.email_login = $1
      LIMIT 1
    `;
    const result = await pool.query(query, [nombre_usuario]);
    const usuarioEncontrado = result.rows[0] || null;
    const passwordValida = await verifyLoginPassword(clave, usuarioEncontrado?.clave, usuarioEncontrado?.id_usuario);

    // Login fallido: registrar intento
    if (!usuarioEncontrado || !passwordValida) {
      await insertLoginLog({
        id_usuario: usuarioEncontrado?.id_usuario ?? null,
        id_sesion: null, // HU79 lo llenaremos luego
        ip_origen,
        nombre_usuario_intentado: nombre_usuario,
        user_agent,
        dispositivo,
        navegador,
        sistema_operativo,
        ubicacion: null,
        exito: false,
        mensaje_error: 'Usuario o contraseña incorrectos'
      });

      return res.status(401).json({ error: true, message: 'Usuario o contraseña incorrectos' });
    }


    // ✅ HU79: crear sesión activa y obtener id_sesion (UUID)
    const id_sesion = await createSession({
      id_usuario: usuarioEncontrado.id_usuario,
      ip_origen,
      user_agent,
      dispositivo,
      navegador,
      sistema_operativo,
      ubicacion: null
    });

    // Payload actual
    const payload = {
      id_usuario: usuarioEncontrado.id_usuario,
      nombre_usuario: usuarioEncontrado.nombre_usuario,
      rol: null,
      id_sucursal: usuarioEncontrado.id_sucursal, // <-- INYECTAR SUCURSAL
      must_change_password: false,
      sid: id_sesion // HU79: id de sesión actual
    };

    let authz = { roles: [], permisos: [] };
    try {
      authz = await getUserAuthzSnapshot(pool, usuarioEncontrado.id_usuario);
    } catch (authzError) {
      console.error('Error resolviendo roles/permisos en /login:', authzError);
    }

    const normalizedRoles = Array.isArray(authz.roles)
      ? authz.roles.map(normalizeRoleName).filter(Boolean)
      : [];
    const tipoUsuarioNormalizado = normalizeRoleName(usuarioEncontrado?.tipo_usuario);
    const isClienteScope =
      tipoUsuarioNormalizado === 'CLIENTE' || normalizedRoles.includes('CLIENTE');
    const hasInternalRole = normalizedRoles.some((roleName) => roleName !== 'CLIENTE');

    if (!usuarioEncontrado?.estado) {
      await closeSession(id_sesion, 'account_disabled').catch(() => {});
      await insertLoginLog({
        id_usuario: usuarioEncontrado.id_usuario,
        id_sesion: null,
        ip_origen,
        nombre_usuario_intentado: nombre_usuario,
        user_agent,
        dispositivo,
        navegador,
        sistema_operativo,
        ubicacion: null,
        exito: false,
        mensaje_error: 'Cuenta desactivada'
      }).catch(() => {});
      return res.status(403).json({
        error: true,
        code: 'ACCOUNT_DISABLED',
        message: 'La cuenta está desactivada.'
      });
    }

    if (isClienteScope) {
      await closeSession(id_sesion, 'scope_cliente').catch(() => {});
      await insertLoginLog({
        id_usuario: usuarioEncontrado.id_usuario,
        id_sesion: null,
        ip_origen,
        nombre_usuario_intentado: nombre_usuario,
        user_agent,
        dispositivo,
        navegador,
        sistema_operativo,
        ubicacion: null,
        exito: false,
        mensaje_error: 'Acceso interno no permitido para rol cliente'
      }).catch(() => {});
      return res.status(403).json({
        error: true,
        code: 'ACCOUNT_SCOPE_INVALID',
        message: 'Este acceso corresponde a cuentas de cliente.'
      });
    }

    if (!hasInternalRole) {
      await closeSession(id_sesion, 'without_roles').catch(() => {});
      await insertLoginLog({
        id_usuario: usuarioEncontrado.id_usuario,
        id_sesion: null,
        ip_origen,
        nombre_usuario_intentado: nombre_usuario,
        user_agent,
        dispositivo,
        navegador,
        sistema_operativo,
        ubicacion: null,
        exito: false,
        mensaje_error: 'Usuario sin roles internos asignados'
      }).catch(() => {});
      return res.status(403).json({
        error: true,
        code: 'ACCOUNT_WITHOUT_ROLES',
        message: 'La cuenta no tiene roles internos asignados.'
      });
    }

    const passwordExpiration = evaluatePasswordExpiration({
      roles: authz.roles,
      tipoUsuario: usuarioEncontrado?.tipo_usuario,
      mustChangePassword: resolveMustChangePassword(usuarioEncontrado),
      passwordChangedAt: usuarioEncontrado?.fecha_cambio_clave,
      createdAt: usuarioEncontrado?.fecha_creacion
    });
    const roleFields = buildAuthRoleCompatFields(authz.roles, payload);
    payload.rol = roleFields.rol;
    payload.nombre_rol = roleFields.nombre_rol;
    payload.roles = roleFields.roles;
    payload.must_change_password = passwordExpiration.mustChangePassword;
    const passwordPolicyFlags = buildPasswordPolicyFlags(passwordExpiration);

    const usuarioResponse = {
      ...payload,
      ...passwordPolicyFlags,
      permisos: authz.permisos
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.cookie('access_token', token, {
      ...authCookieOptions(),
      maxAge: 1000 * 60 * 60 * 8
    });

    const csrfToken = issueCsrf(req, res);

    // Login exitoso: registrar intento
    await insertLoginLog({
      id_usuario: usuarioEncontrado.id_usuario,
      id_sesion: id_sesion,
      ip_origen,
      nombre_usuario_intentado: nombre_usuario,
      user_agent,
      dispositivo,
      navegador,
      sistema_operativo,
      ubicacion: null,
      exito: true,
      mensaje_error: null
    });

    return res.json({
      message: 'Login exitoso',
      usuario: usuarioResponse,
      roles: authz.roles,
      permisos: authz.permisos,
      csrfToken
    });
  } catch (error) {
    console.error('Error en el login:', error);

    // ✅ Si ocurre error interno, también logueamos
    try {
      await insertLoginLog({
        id_usuario: null,
        id_sesion: null,
        ip_origen,
        nombre_usuario_intentado: nombre_usuario,
        user_agent,
        dispositivo,
        navegador,
        sistema_operativo,
        ubicacion: null,
        exito: false,
        mensaje_error: 'Error interno del servidor'
      });
    } catch (e) {
      console.error('No se pudo insertar logins:', e);
    }

    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * ✅ FIX: Logout debe cerrar la sesión activa en la BD (sesiones_activas)
 * usando el sid del JWT, y luego limpiar cookies.
 */
router.post('/logout', authRequired, async (req, res) => {
  try {
    const sid = req.user?.sid;
    if (sid) {
      await closeSession(sid, 'logout');
    }
  } catch (err) {
    console.error('Error cerrando sesión en BD (logout):', err);
  }

  res.clearCookie('access_token', authCookieOptions());
  res.clearCookie('csrf_token', csrfCookieOptions());

  return res.json({ message: 'Logout exitoso' });
});

router.get('/me', authRequired, requireActiveSession, async (req, res) => {
  const csrfToken = issueCsrf(req, res, { reuseIfPresent: true });
  const usuario = { ...(req.user || {}) };
  const idUsuario = Number.parseInt(String(usuario?.id_usuario ?? ''), 10);

  let authz = { roles: [], permisos: [] };
  try {
    if (Number.isInteger(idUsuario) && idUsuario > 0) {
      authz = await getUserAuthzSnapshot(pool, idUsuario);
    }
  } catch (authzError) {
    console.error('Error resolviendo roles/permisos en /me:', authzError);
  }

  try {
    await ensurePasswordChangedAtColumn();

    if (Number.isInteger(idUsuario) && idUsuario > 0) {
      const result = await pool.query(
        `
          SELECT
            id_usuario,
            nombre_usuario,
            tipo_usuario,
            estado,
            must_change_password,
            id_empleado,
            id_cliente,
            foto_perfil,
            fecha_creacion,
            fecha_cambio_clave
          FROM usuarios
          WHERE id_usuario = $1
          LIMIT 1
        `,
        [idUsuario]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        Object.assign(usuario, {
          id_cliente: row.id_cliente,
          tipo_usuario: row.tipo_usuario,
          foto_perfil: row.foto_perfil
        });

        if (String(row?.tipo_usuario || '').trim().toUpperCase() === 'CLIENTE') {
          const clienteName = await getClienteNameSnapshot(idUsuario);
          if (clienteName) {
            Object.assign(usuario, {
              nombre_cliente: clienteName.nombre_cliente,
              apellido_cliente: clienteName.apellido_cliente,
              nombre_completo_cliente: clienteName.nombre_completo_cliente,
              correo_cliente: clienteName.correo_cliente,
              telefono_cliente: clienteName.telefono_cliente,
              telefono_cliente_normalizado: clienteName.telefono_cliente_normalizado,
              nombre_completo: clienteName.nombre_completo_cliente || usuario.nombre_completo
            });
          }
        }

        const passwordExpiration = evaluatePasswordExpiration({
          roles: authz.roles,
          tipoUsuario: row?.tipo_usuario,
          mustChangePassword: resolveMustChangePassword(row),
          passwordChangedAt: row?.fecha_cambio_clave,
          createdAt: row?.fecha_creacion
        });
        usuario.must_change_password = passwordExpiration.mustChangePassword;
        Object.assign(usuario, buildPasswordPolicyFlags(passwordExpiration));
      } else if (!Object.prototype.hasOwnProperty.call(usuario, 'must_change_password')) {
        usuario.must_change_password = false;
      }
    }
  } catch (error) {
    console.error('Error en /me al resolver must_change_password:', error);
    if (!Object.prototype.hasOwnProperty.call(usuario, 'must_change_password')) {
      usuario.must_change_password = false;
    }
  }

  if (!Object.prototype.hasOwnProperty.call(usuario, 'password_age_days')) {
    usuario.password_age_days = null;
    usuario.password_recommend_change = false;
    usuario.password_warning_58d = false;
    usuario.password_days_to_expire = null;
    usuario.password_policy_excluded = false;
  }

  Object.assign(usuario, buildAuthRoleCompatFields(authz.roles, usuario), {
    permisos: authz.permisos
  });

  return res.json({
    usuario,
    roles: authz.roles,
    permisos: authz.permisos,
    csrfToken
  });
});

export default router;
