import express from 'express';
import pool from '../config/db-connection.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authRequired } from '../middleware/auth.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'CAMBIA_ESTE_SECRET_EN_ENV';

const cookieConfig = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd, // en producción debe ser HTTPS si sameSite='none'
    path: '/'
  };
};

const issueCsrf = (res) => {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const base = cookieConfig();

  // csrf_token NO es HttpOnly para que el frontend lo pueda mandar en header
  res.cookie('csrf_token', csrfToken, {
    ...base,
    httpOnly: false,
    maxAge: 1000 * 60 * 60 * 8 // 8h
  });

  return csrfToken;
};

router.post('/login', async (req, res) => {
  const { nombre_usuario, clave } = req.body;

  try {
    const query = 'SELECT * FROM usuarios WHERE nombre_usuario = $1 AND clave = $2';
    const result = await pool.query(query, [nombre_usuario, clave]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: true, message: 'Usuario o contraseña incorrectos' });
    }

    const usuarioEncontrado = result.rows[0];

    const payload = {
      id_usuario: usuarioEncontrado.id_usuario,
      nombre_usuario: usuarioEncontrado.nombre_usuario,
      rol: usuarioEncontrado.id_empleado
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    const base = cookieConfig();

    // JWT en cookie HttpOnly (JS NO puede leerla)
    res.cookie('access_token', token, {
      ...base,
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8 // 8h
    });

    // CSRF token (doble-submit)
    const csrfToken = issueCsrf(res);

    return res.json({
      message: 'Login exitoso',
      usuario: payload,
      csrfToken // opcional, útil si quieres ver/debug, pero el frontend puede leer la cookie también
    });
  } catch (error) {
    console.error('Error en el login:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.post('/logout', (req, res) => {
  const base = cookieConfig();

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
