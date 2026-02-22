import express from 'express';
import pool from '../config/db-connection.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authRequired } from '../middleware/auth.js';

// helpers de HU78
import { getClientIp, parseUserAgent } from '../utils/security/clientInfo.js';
import { insertLoginLog } from '../utils/security/loginLogger.js';
import { createSession, closeSession } from '../utils/security/sessionService.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'CAMBIA_ESTE_SECRET_EN_ENV';

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

router.post('/login', async (req, res) => {
  const { nombre_usuario, clave } = req.body;

  // HU78: capturar IP + User-Agent + parseo
  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;
  const { dispositivo, navegador, sistema_operativo } = parseUserAgent(user_agent);

  try {
    const query = 'SELECT * FROM usuarios WHERE nombre_usuario = $1 AND clave = $2';
    const result = await pool.query(query, [nombre_usuario, clave]);

    // Login fallido: registrar intento
    if (result.rows.length === 0) {
      await insertLoginLog({
        id_usuario: null,
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

    const usuarioEncontrado = result.rows[0];

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

    // Payload actual (no lo rompemos)
    const payload = {
      id_usuario: usuarioEncontrado.id_usuario,
      nombre_usuario: usuarioEncontrado.nombre_usuario,
      rol: usuarioEncontrado.id_empleado,
      sid: id_sesion // HU79: id de sesión actual
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
      usuario: payload,
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

router.get('/me', authRequired, (req, res) => {
  // Re-emite CSRF por si el frontend refresca y lo perdió
  const csrfToken = issueCsrf(res);

  return res.json({
    usuario: req.user,
    csrfToken
  });
});

export default router;