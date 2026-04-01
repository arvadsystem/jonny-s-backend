/**
 * public_cliente.js
 * Rutas públicas para el flujo de cliente web:
 *   POST /api/public/register        — auto-registro de cliente (con verificación email)
 *   POST /api/public/login            — login de cliente (email+clave vía Supabase)
 *   POST /api/public/forgot-password  — recuperación de contraseña (SMTP propio)
 *   POST /api/public/verify-email     — verificar email desde link enviado
 *   POST /api/public/google-callback  — callback OAuth Google
 *   GET  /api/public/menu             — menú público (sin auth)
 *   GET  /api/public/menu/:id         — detalle de ítem del menú (sin auth)
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../config/db-connection.js';
import JWT_SECRET from '../config/jwt.js';
import { loginLimiter, registerLimiter, forgotPasswordLimiter } from '../middleware/rateLimiter.js';
import { getClientIp, parseUserAgent } from '../utils/security/clientInfo.js';
import { insertLoginLog } from '../utils/security/loginLogger.js';
import { createSession } from '../utils/security/sessionService.js';
import { enviarVerificacion, enviarRecuperacion } from '../utils/emailService.js';

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

// ── Helpers ──────────────────────────────────────────────────────────

const cookieConfig = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return { sameSite: isProd ? 'none' : 'lax', secure: isProd, path: '/' };
};

const issueCsrf = (res) => {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  res.cookie('csrf_token', csrfToken, { ...cookieConfig(), httpOnly: false, maxAge: 1000 * 60 * 60 * 8 });
  return csrfToken;
};

const emitirAppJwt = (usuario, id_sesion) => {
  const payload = {
    id_usuario: usuario.id_usuario,
    nombre_usuario: usuario.nombre_usuario,
    tipo_usuario: usuario.tipo_usuario,
    id_cliente: usuario.id_cliente,
    sid: id_sesion
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
};

/**
 * Obtener roles y permisos del usuario interno desde BD.
 */
const getUserAuthz = async (idUsuario) => {
  const [rolesRes, permisosRes] = await Promise.all([
    pool.query(
      `SELECT DISTINCT r.nombre FROM roles_usuarios ru
       INNER JOIN roles r ON r.id_rol = ru.id_rol
       WHERE ru.id_usuario = $1 ORDER BY r.nombre`,
      [idUsuario]
    ),
    pool.query(
      `SELECT DISTINCT p.nombre_permiso FROM roles_usuarios ru
       INNER JOIN roles_permisos rp ON rp.id_rol = ru.id_rol
       INNER JOIN permisos p ON p.id_permiso = rp.id_permiso
       WHERE ru.id_usuario = $1 ORDER BY p.nombre_permiso`,
      [idUsuario]
    )
  ]);
  return {
    roles: rolesRes.rows.map(r => String(r.nombre || '').trim()).filter(Boolean),
    permisos: permisosRes.rows.map(r => String(r.nombre_permiso || '').trim()).filter(Boolean)
  };
};

/**
 * Llamar a Supabase Admin API para crear usuario de identidad.
 * Retorna el auth_user_id (uuid) generado por Supabase.
 */
const crearIdentidadSupabase = async (email, password) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase no configurado en variables de entorno (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
  }
  // NO auto-confirmar email — el usuario debe verificar
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({ email, password, email_confirm: false })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || 'Error al crear identidad en Supabase');
  return data.id; // UUID de Supabase
};

/**
 * Generar link de acción (signup, recovery) vía Supabase Admin API.
 * Retorna la action_link que contiene el token.
 */
const generarLinkSupabase = async (type, email, options = {}) => {
  const body = { type, email, ...options };
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.msg || data?.message || 'Error al generar link de verificación');
  return data; // contiene action_link, hashed_token, redirect_to, etc.
};

/**
 * Autenticar con Supabase (email + password) y obtener el uuid del usuario.
 */
const autenticarConSupabase = async (email, password) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase no configurado (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
  }
  // Usar la anon key o service key según configuración
  const anonKey = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey
    },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description || data?.error || 'Credenciales inválidas');
  return { auth_user_id: data.user?.id };
};

// ── POST /api/public/register ─────────────────────────────────────────
router.post('/api/public/register', registerLimiter, async (req, res) => {
  const { email, clave, nombre, apellido } = req.body;

  if (!email || !clave) {
    return res.status(400).json({ error: true, message: 'Email y contraseña son requeridos' });
  }

  // Fix 7: Validación de fuerza de contraseña
  if (clave.length < 8) {
    return res.status(400).json({ error: true, message: 'La contraseña debe tener al menos 8 caracteres' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verificar que no exista ese email ya registrado
    const emailExiste = await client.query(
      `SELECT ia.id_identidad_auth FROM identidades_auth ia WHERE ia.email_login = $1`,
      [email]
    );
    if (emailExiste.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'El correo ya está registrado' });
    }

    // 2. Crear identidad en Supabase (SIN confirmar email)
    const auth_user_id = await crearIdentidadSupabase(email, clave);

    // 3. Buscar o crear persona
    let id_persona = null;
    if (nombre) {
      const personaRes = await client.query(
        `INSERT INTO personas (nombre, apellido) VALUES ($1, $2) RETURNING id_persona`,
        [nombre || '', apellido || '']
      );
      id_persona = personaRes.rows[0]?.id_persona;
    }

    // 4. Crear registro en clientes (id_tipo_cliente=2 = 'General', tabla no tiene columna 'estado')
    let id_cliente = null;
    if (id_persona) {
      const clienteRes = await client.query(
        `INSERT INTO clientes (id_persona, id_tipo_cliente, fecha_ingreso, puntos)
         VALUES ($1, 2, CURRENT_DATE, 0) RETURNING id_cliente`,
        [id_persona]
      );
      id_cliente = clienteRes.rows[0]?.id_cliente;
    }

    // 5. Crear usuario interno (estado: false hasta verificar email)
    const nombre_usuario = email;
    const usuarioRes = await client.query(
      `INSERT INTO usuarios (nombre_usuario, clave, estado, tipo_usuario, id_cliente, must_change_password)
       VALUES ($1, 'SUPABASE_AUTH', false, 'CLIENTE', $2, false) RETURNING id_usuario, nombre_usuario, tipo_usuario, id_cliente`,
      [nombre_usuario, id_cliente]
    );
    const nuevoUsuario = usuarioRes.rows[0];

    // 6. Asignar rol Cliente
    const rolRes = await client.query(`SELECT id_rol FROM roles WHERE nombre = 'Cliente' LIMIT 1`);
    if (rolRes.rows.length > 0) {
      await client.query(
        `INSERT INTO roles_usuarios (id_rol, id_usuario) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [rolRes.rows[0].id_rol, nuevoUsuario.id_usuario]
      );
    }

    // 7. Registrar identidad_auth (email_verificado: false)
    await client.query(
      `INSERT INTO identidades_auth (id_usuario, auth_user_id, provider, email_login, email_verificado, activo)
       VALUES ($1, $2, 'email', $3, false, true)`,
      [nuevoUsuario.id_usuario, auth_user_id, email]
    );

    // 8. Registrar correo del usuario en tabla correos (ahora con id_persona)
    if (id_persona) {
      await client.query(
        `INSERT INTO correos (id_persona, direccion_correo) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id_persona, email]
      ).catch(() => {}); // silenciar si ya existe
    }

    await client.query('COMMIT');

    // 9. Generar link de verificación vía Supabase Admin y enviar por SMTP propio
    // redirect_to apunta a /auth/callback donde el frontend procesará el token
    try {
      const linkData = await generarLinkSupabase('signup', email, {
        redirect_to: `${FRONTEND_ORIGIN}/auth/callback`
      });
      const actionLink = linkData.action_link || linkData.properties?.action_link;

      if (actionLink) {
        await enviarVerificacion(email, nombre || '', actionLink, nuevoUsuario.id_usuario);
      } else {
        console.warn('[public/register] No se obtuvo action_link de Supabase, email no enviado');
      }
    } catch (emailErr) {
      // No fallar el registro si el correo no se pudo enviar
      console.error('[public/register] Error enviando correo de verificación:', emailErr.message);
    }

    return res.status(201).json({
      message: 'Te hemos enviado un correo de verificación. Revisa tu bandeja de entrada para activar tu cuenta.',
      requiresVerification: true
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[public/register] Error:', error);
    return res.status(500).json({ error: true, message: error.message || 'Error interno al registrar cliente' });
  } finally {
    client.release();
  }
});

// ── POST /api/public/login ────────────────────────────────────────────
router.post('/api/public/login', loginLimiter, async (req, res) => {
  const { email, clave } = req.body;
  if (!email || !clave) {
    return res.status(400).json({ error: true, message: 'Email y contraseña son requeridos' });
  }

  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;
  const { dispositivo, navegador, sistema_operativo } = parseUserAgent(user_agent);

  try {
    // 1. Autenticar contra Supabase
    const { auth_user_id } = await autenticarConSupabase(email, clave);

    // 2. Buscar identity y usuario interno
    const identRes = await pool.query(
      `SELECT ia.id_usuario FROM identidades_auth ia WHERE ia.auth_user_id = $1 LIMIT 1`,
      [auth_user_id]
    );

    if (identRes.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'No existe una cuenta interna asociada a ese correo' });
    }

    const id_usuario = identRes.rows[0].id_usuario;
    const usuarioRes = await pool.query(
      `SELECT id_usuario, nombre_usuario, tipo_usuario, id_cliente, estado, must_change_password FROM usuarios WHERE id_usuario = $1`,
      [id_usuario]
    );
    const usuario = usuarioRes.rows[0];

    if (!usuario || !usuario.estado) {
      return res.status(403).json({ error: true, message: 'Cuenta desactivada' });
    }

    // 3. Actualizar última autenticación
    await pool.query(
      `UPDATE identidades_auth SET ultima_autenticacion = NOW() WHERE auth_user_id = $1`,
      [auth_user_id]
    );

    // 4. Sesión y JWT
    const id_sesion = await createSession({
      id_usuario, ip_origen, user_agent, dispositivo, navegador, sistema_operativo, ubicacion: null
    });

    const authz = await getUserAuthz(id_usuario);
    const token = emitirAppJwt(usuario, id_sesion);
    const base = cookieConfig();

    res.cookie('access_token', token, { ...base, httpOnly: true, maxAge: 1000 * 60 * 60 * 8 });
    const csrfToken = issueCsrf(res);

    await insertLoginLog({
      id_usuario, id_sesion, ip_origen, nombre_usuario_intentado: email,
      user_agent, dispositivo, navegador, sistema_operativo, ubicacion: null, exito: true, mensaje_error: null
    });

    return res.json({
      message: 'Login exitoso',
      usuario: { ...usuario, roles: authz.roles, permisos: authz.permisos },
      roles: authz.roles,
      permisos: authz.permisos,
      csrfToken
    });
  } catch (error) {
    console.error('[public/login] Error:', error);
    await insertLoginLog({
      id_usuario: null, id_sesion: null, ip_origen, nombre_usuario_intentado: email,
      user_agent, dispositivo, navegador, sistema_operativo, ubicacion: null,
      exito: false, mensaje_error: error.message
    }).catch(() => {});
    return res.status(401).json({ error: true, message: 'Credenciales inválidas' });
  }
});

// ── POST /api/public/forgot-password ─────────────────────────────────
router.post('/api/public/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: true, message: 'Email requerido' });
  }

  const genericMsg = 'Si el correo está registrado, recibirás un enlace de recuperación.';

  try {
    // Verificar que exista la identidad
    const identRes = await pool.query(
      `SELECT ia.id_identidad_auth, ia.id_usuario FROM identidades_auth ia WHERE ia.email_login = $1 LIMIT 1`,
      [email]
    );

    // Por seguridad: responder siempre OK aunque no exista el email
    if (identRes.rows.length === 0) {
      return res.json({ message: genericMsg });
    }

    const id_usuario = identRes.rows[0].id_usuario;

    // Generar link de recuperación vía Supabase Admin API y enviar por SMTP propio
    try {
      const linkData = await generarLinkSupabase('recovery', email, {
        redirect_to: `${FRONTEND_ORIGIN}/reset-password`
      });
      const actionLink = linkData.action_link || linkData.properties?.action_link;

      if (actionLink) {
        await enviarRecuperacion(email, actionLink, id_usuario);
      } else {
        console.warn('[public/forgot-password] No se obtuvo action_link de Supabase');
      }
    } catch (emailErr) {
      console.error('[public/forgot-password] Error enviando correo:', emailErr.message);
    }

    return res.json({ message: genericMsg });
  } catch (error) {
    console.error('[public/forgot-password] Error:', error);
    return res.status(500).json({ error: true, message: 'Error al procesar la solicitud' });
  }
});

// ── POST /api/public/verify-email ────────────────────────────────────
/**
 * Soporta dos flujos:
 * A) access_token en body: Supabase ya verificó el email internamente y nos da el token
 *    de sesión. Solo necesitamos activar el usuario local.
 * B) token_hash + type: Flujo manual donde enviamos el token a Supabase para verificar.
 */
router.post('/api/public/verify-email', async (req, res) => {
  const { token_hash, type, access_token } = req.body;

  // Validar que venga al menos un forma de verificación
  if (!access_token && (!token_hash || !type)) {
    return res.status(400).json({ error: true, message: 'Se requiere access_token o (token_hash + type)' });
  }

  try {
    const anonKey = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
    let authUserId = null;
    let email = null;

    if (access_token) {
      // ── Flujo A: access_token ya válido (Supabase ya confirmó el email) ───
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${access_token}`
        }
      });

      if (!userRes.ok) {
        return res.status(400).json({ error: true, message: 'Token de verificación inválido o expirado' });
      }

      const userData = await userRes.json();
      authUserId = userData.id;
      email = userData.email;
    } else {
      // ── Flujo B: token_hash + type ───────────────────────────
      const verifyRes = await fetch(
        `${SUPABASE_URL}/auth/v1/verify?token=${token_hash}&type=${type}`,
        { method: 'GET', headers: { apikey: anonKey } }
      );

      if (!verifyRes.ok) {
        return res.status(400).json({ error: true, message: 'Token inválido o expirado' });
      }

      const verifyData = await verifyRes.json();
      authUserId = verifyData?.user?.id || verifyData?.id;
      email = verifyData?.user?.email || verifyData?.email;
    }

    if (!authUserId && !email) {
      return res.status(400).json({ error: true, message: 'No se pudo identificar al usuario verificado' });
    }

    // Buscar identidad local
    const identQuery = authUserId
      ? await pool.query(`SELECT id_usuario FROM identidades_auth WHERE auth_user_id = $1 LIMIT 1`, [authUserId])
      : await pool.query(`SELECT id_usuario FROM identidades_auth WHERE email_login = $1 LIMIT 1`, [email]);

    if (identQuery.rows.length === 0) {
      console.warn('[verify-email] No se encontró identidad local para:', authUserId || email);
      // Aun así respondemos OK para no bloquear si Supabase ya validó
      return res.json({ message: 'Email verificado. Inicia sesión para continuar.', verified: true });
    }

    const id_usuario = identQuery.rows[0].id_usuario;

    // Activar usuario y marcar email como verificado en BD local
    await pool.query(`UPDATE usuarios SET estado = true WHERE id_usuario = $1`, [id_usuario]);
    await pool.query(
      `UPDATE identidades_auth SET email_verificado = true, ultima_autenticacion = NOW() WHERE id_usuario = $1`,
      [id_usuario]
    );

    console.log(`[verify-email] Usuario ${id_usuario} activado correctamente`);

    return res.json({
      message: 'Email verificado exitosamente. Ya puedes iniciar sesión.',
      verified: true
    });
  } catch (error) {
    console.error('[public/verify-email] Error:', error);
    return res.status(500).json({ error: true, message: 'Error al verificar email' });
  }
});

// ── POST /api/public/google-callback ─────────────────────────────────
router.post('/api/public/google-callback', async (req, res) => {
  const { access_token, refresh_token } = req.body;
  if (!access_token) {
    return res.status(400).json({ error: true, message: 'access_token requerido' });
  }

  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;
  const { dispositivo, navegador, sistema_operativo } = parseUserAgent(user_agent);

  try {
    // Obtener datos del usuario de Supabase con el access_token
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${access_token}`
      }
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: true, message: 'Token de Google inválido' });
    }

    const supaUser = await userRes.json();
    const auth_user_id = supaUser.id;
    const email = supaUser.email;
    const fullName = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || '';
    const [nombre = '', apellido = ''] = fullName.split(' ', 2);

    // Buscar si ya existe identidad local
    const identRes = await pool.query(
      `SELECT ia.id_usuario FROM identidades_auth ia WHERE ia.auth_user_id = $1 LIMIT 1`,
      [auth_user_id]
    );

    let id_usuario;

    if (identRes.rows.length > 0) {
      // Ya existe — solo actualizar última autenticación
      id_usuario = identRes.rows[0].id_usuario;
      await pool.query(
        `UPDATE identidades_auth SET ultima_autenticacion = NOW() WHERE auth_user_id = $1`,
        [auth_user_id]
      );
    } else {
      // No existe — crear usuario local
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        let id_persona = null;
        if (nombre) {
          const personaRes = await client.query(
            `INSERT INTO personas (nombre, apellido) VALUES ($1, $2) RETURNING id_persona`,
            [nombre, apellido]
          );
          id_persona = personaRes.rows[0]?.id_persona;
        }

        let id_cliente = null;
        if (id_persona) {
          const clienteRes = await client.query(
            `INSERT INTO clientes (id_persona, id_tipo_cliente, fecha_ingreso, puntos)
             VALUES ($1, 2, CURRENT_DATE, 0) RETURNING id_cliente`,
            [id_persona]
          );
          id_cliente = clienteRes.rows[0]?.id_cliente;
        }

        const usuarioInsert = await client.query(
          `INSERT INTO usuarios (nombre_usuario, clave, estado, tipo_usuario, id_cliente, must_change_password)
           VALUES ($1, 'GOOGLE_AUTH', true, 'CLIENTE', $2, false) RETURNING id_usuario`,
          [email, id_cliente]
        );
        id_usuario = usuarioInsert.rows[0].id_usuario;

        const rolRes = await client.query(`SELECT id_rol FROM roles WHERE nombre = 'Cliente' LIMIT 1`);
        if (rolRes.rows.length > 0) {
          await client.query(
            `INSERT INTO roles_usuarios (id_rol, id_usuario) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [rolRes.rows[0].id_rol, id_usuario]
          );
        }

        await client.query(
          `INSERT INTO identidades_auth (id_usuario, auth_user_id, provider, email_login, email_verificado, activo)
           VALUES ($1, $2, 'google', $3, true, true)`,
          [id_usuario, auth_user_id, email]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // Emitir sesión y JWT
    const usuarioRes2 = await pool.query(
      `SELECT id_usuario, nombre_usuario, tipo_usuario, id_cliente, estado, must_change_password FROM usuarios WHERE id_usuario = $1`,
      [id_usuario]
    );
    const usuario = usuarioRes2.rows[0];

    const id_sesion = await createSession({
      id_usuario, ip_origen, user_agent, dispositivo, navegador, sistema_operativo, ubicacion: null
    });

    const authz = await getUserAuthz(id_usuario);
    const token = emitirAppJwt(usuario, id_sesion);
    const base = cookieConfig();

    res.cookie('access_token', token, { ...base, httpOnly: true, maxAge: 1000 * 60 * 60 * 8 });
    const csrfToken = issueCsrf(res);

    await insertLoginLog({
      id_usuario, id_sesion, ip_origen, nombre_usuario_intentado: email,
      user_agent, dispositivo, navegador, sistema_operativo, ubicacion: null, exito: true, mensaje_error: null
    });

    return res.json({
      message: 'Login con Google exitoso',
      usuario: { ...usuario, roles: authz.roles, permisos: authz.permisos },
      roles: authz.roles,
      permisos: authz.permisos,
      csrfToken
    });
  } catch (error) {
    console.error('[public/google-callback] Error:', error);
    return res.status(500).json({ error: true, message: 'Error al procesar login con Google' });
  }
});

// ── GET /api/public/menu ──────────────────────────────────────────────
router.get('/api/public/menu', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.id_menu,
        m.nombre,
        m.descripcion,
        m.precio,
        m.id_sucursal,
        a.url_publica AS imagen_url,
        cm.nombre AS categoria
      FROM menu m
      LEFT JOIN archivos a ON a.id_archivo = m.id_archivo
      LEFT JOIN categorias_productos cm ON cm.id_categoria_producto = m.id_categoria_producto
      WHERE m.disponible = true OR m.disponible IS NULL
      ORDER BY cm.nombre, m.nombre
    `);
    return res.json({ menu: result.rows });
  } catch (error) {
    console.error('[public/menu] Error:', error);
    return res.status(500).json({ error: true, message: 'Error al cargar el menú' });
  }
});

// ── GET /api/public/menu/:id ──────────────────────────────────────────
router.get('/api/public/menu/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: true, message: 'ID inválido' });
  }

  try {
    const result = await pool.query(`
      SELECT
        m.id_menu,
        m.nombre,
        m.descripcion,
        m.precio,
        m.id_sucursal,
        a.url_publica AS imagen_url,
        cm.nombre AS categoria
      FROM menu m
      LEFT JOIN archivos a ON a.id_archivo = m.id_archivo
      LEFT JOIN categorias_productos cm ON cm.id_categoria_producto = m.id_categoria_producto
      WHERE m.id_menu = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Ítem no encontrado' });
    }

    return res.json({ item: result.rows[0] });
  } catch (error) {
    console.error('[public/menu/:id] Error:', error);
    return res.status(500).json({ error: true, message: 'Error al cargar el ítem' });
  }
});

export default router;
