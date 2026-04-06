import express from 'express';
import pool from '../config/db-connection.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authRequired } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimiter.js';
import JWT_SECRET from '../config/jwt.js';

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

const getUserAuthzSnapshot = async (idUsuario) => {
  const userId = Number.parseInt(String(idUsuario ?? ''), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { roles: [], permisos: [] };
  }

  const [rolesResult, permisosResult] = await Promise.all([
    pool.query(
      `
        SELECT DISTINCT r.nombre
        FROM roles_usuarios ru
        INNER JOIN roles r ON r.id_rol = ru.id_rol
        WHERE ru.id_usuario = $1
        ORDER BY r.nombre
      `,
      [userId]
    ),
    pool.query(
      `
        SELECT DISTINCT p.nombre_permiso
        FROM roles_usuarios ru
        INNER JOIN roles_permisos rp ON rp.id_rol = ru.id_rol
        INNER JOIN permisos p ON p.id_permiso = rp.id_permiso
        WHERE ru.id_usuario = $1
        ORDER BY p.nombre_permiso
      `,
      [userId]
    )
  ]);

  return {
    roles: rolesResult.rows
      .map((row) => String(row?.nombre || '').trim())
      .filter(Boolean),
    permisos: permisosResult.rows
      .map((row) => String(row?.nombre_permiso || '').trim())
      .filter(Boolean)
  };
};

const cookieConfig = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    path: '/'
  };
};

const issueCsrf = (res) => {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const base = cookieConfig();

  res.cookie('csrf_token', csrfToken, {
    ...base,
    httpOnly: false,
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

router.post('/login', loginLimiter, async (req, res) => {
  const { nombre_usuario, clave } = req.body;

  if (!JWT_SECRET) {
    return res.status(500).json({
      error: true,
      message: 'Configuracion de seguridad incompleta: JWT_SECRET no definido'
    });
  }

  // HU78: capturar IP + User-Agent + parseo
  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;
  const { dispositivo, navegador, sistema_operativo } = parseUserAgent(user_agent);

  try {
    const query = `
      SELECT u.*, e.id_sucursal 
      FROM usuarios u 
      LEFT JOIN empleados e ON u.id_empleado = e.id_empleado 
      WHERE u.nombre_usuario = $1 LIMIT 1
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
      rol: usuarioEncontrado.id_empleado,
      id_sucursal: usuarioEncontrado.id_sucursal, // <-- INYECTAR SUCURSAL
      must_change_password: resolveMustChangePassword(usuarioEncontrado),
      sid: id_sesion // HU79: id de sesión actual
    };

    let authz = { roles: [], permisos: [] };
    try {
      authz = await getUserAuthzSnapshot(usuarioEncontrado.id_usuario);
    } catch (authzError) {
      console.error('Error resolviendo roles/permisos en /login:', authzError);
    }

    const usuarioResponse = {
      ...payload,
      roles: authz.roles,
      permisos: authz.permisos
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    const base = cookieConfig();

    res.cookie('access_token', token, {
      ...base,
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8
    });

    const csrfToken = issueCsrf(res);

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
  const base = cookieConfig();

  try {
    const sid = req.user?.sid;
    if (sid) {
      await closeSession(sid, 'logout');
    }
  } catch (err) {
    console.error('Error cerrando sesión en BD (logout):', err);
    // No bloqueamos el logout aunque falle el cierre en BD
  }

  res.clearCookie('access_token', base);
  res.clearCookie('csrf_token', base);

  return res.json({ message: 'Logout exitoso' });
});

router.get('/me', authRequired, async (req, res) => {
  // Re-emite CSRF por si el frontend refresca y lo perdió
  const csrfToken = issueCsrf(res);
  const usuario = { ...(req.user || {}) };
  const idUsuario = Number.parseInt(String(usuario?.id_usuario ?? ''), 10);

  try {
    if (Number.isInteger(idUsuario) && idUsuario > 0) {
      const result = await pool.query(
        'SELECT id_usuario, nombre_usuario, tipo_usuario, estado, must_change_password, id_empleado, id_cliente, foto_perfil FROM usuarios WHERE id_usuario = $1 LIMIT 1',
        [idUsuario]
      );

      if (result.rows.length > 0) {
        usuario.must_change_password = resolveMustChangePassword(result.rows[0]);
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

  let authz = { roles: [], permisos: [] };
  try {
    if (Number.isInteger(idUsuario) && idUsuario > 0) {
      authz = await getUserAuthzSnapshot(idUsuario);
    }
  } catch (authzError) {
    console.error('Error resolviendo roles/permisos en /me:', authzError);
  }

  usuario.roles = authz.roles;
  usuario.permisos = authz.permisos;

  return res.json({
    usuario,
    roles: authz.roles,
    permisos: authz.permisos,
    csrfToken
  });
});

export default router;
