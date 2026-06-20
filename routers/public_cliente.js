/**
 * public_cliente.js
 * Rutas públicas para el flujo de cliente web:
 *   POST /api/public/register        — auto-registro de cliente (con verificación email)
 *   POST /api/public/resend-verification — reenvío de verificación de cuenta
 *   POST /api/public/login            — login de cliente (email+clave vía Supabase)
 *   POST /api/public/forgot-password  — recuperación de contraseña (SMTP propio)
 *   POST /api/public/verify-email     — verificar email desde link enviado
 *   POST /api/public/google-callback  — callback OAuth Google
 *   GET  /api/public/menu*            — DEPRECATED (migrado a /api/public-menu/*)
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../config/db-connection.js';
import JWT_SECRET from '../config/jwt.js';
import {
  publicLoginIpLimiter,
  publicLoginAccountIpLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resendVerificationLimiter
} from '../middleware/rateLimiter.js';
import { getClientIp, parseUserAgent } from '../utils/security/clientInfo.js';
import { insertLoginLog } from '../utils/security/loginLogger.js';
import { createSession, closeAllUserSessions } from '../utils/security/sessionService.js';
import { enviarCorreo, enviarVerificacion, enviarRecuperacion } from '../utils/emailService.js';

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

const normalizeOrigin = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
};

const FRONTEND_ORIGIN =
  normalizeOrigin(process.env.FRONTEND_ORIGIN) ||
  (IS_PRODUCTION ? '' : 'http://localhost:5173');

const BACKEND_PUBLIC_ORIGIN = normalizeOrigin(
  process.env.BACKEND_PUBLIC_ORIGIN || process.env.API_PUBLIC_ORIGIN
);

const resolveRequestOrigin = (req) => {
  const protoHeader = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (!hostHeader) return '';
  const protocol = protoHeader || req.protocol || 'http';
  return normalizeOrigin(`${protocol}://${hostHeader}`);
};

const resolveFrontendOrigin = (req) => {
  if (FRONTEND_ORIGIN) return FRONTEND_ORIGIN;
  if (IS_PRODUCTION) return '';
  return resolveRequestOrigin(req);
};

const resolveBackendOrigin = (req) => {
  if (BACKEND_PUBLIC_ORIGIN) return BACKEND_PUBLIC_ORIGIN;
  if (IS_PRODUCTION) return '';
  return resolveRequestOrigin(req);
};

const buildUrlWithParams = (origin, path, params = {}) => {
  if (!origin) return '';
  try {
    const url = new URL(path, `${origin}/`);
    Object.entries(params).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  } catch {
    return '';
  }
};

// ── Helpers ──────────────────────────────────────────────────────────

const normalizeSameSite = (value, fallback) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'none' || normalized === 'lax' || normalized === 'strict') {
    return normalized;
  }
  return fallback;
};

const cookieConfig = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    sameSite: normalizeSameSite(process.env.AUTH_COOKIE_SAMESITE, isProd ? 'none' : 'lax'),
    secure: String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'true' || isProd,
    domain: String(process.env.AUTH_COOKIE_DOMAIN || '').trim() || undefined,
    path: '/'
  };
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
    nombre_cliente: usuario.nombre_cliente,
    apellido_cliente: usuario.apellido_cliente,
    nombre_completo_cliente: usuario.nombre_completo_cliente,
    nombre_completo: usuario.nombre_completo_cliente,
    sid: id_sesion
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
};

const CLIENTE_USUARIO_SELECT = `
  SELECT
    u.id_usuario,
    u.nombre_usuario,
    u.tipo_usuario,
    u.id_cliente,
    u.estado,
    u.must_change_password,
    c.id_persona,
    p.nombre AS nombre_cliente,
    p.apellido AS apellido_cliente,
    NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)), '') AS nombre_completo_cliente,
    NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)), '') AS nombre_completo
  FROM usuarios u
  LEFT JOIN clientes c ON c.id_cliente = u.id_cliente
  LEFT JOIN personas p ON p.id_persona = c.id_persona
`;

const getClienteUsuarioById = async (idUsuario) => {
  const result = await pool.query(
    `${CLIENTE_USUARIO_SELECT}
     WHERE u.id_usuario = $1
     LIMIT 1`,
    [idUsuario]
  );
  return result.rows[0] || null;
};

const normalizeIdentifier = (value) => String(value || '').trim();
const normalizeEmail = (value) => normalizeIdentifier(value).toLowerCase();
const normalizeGenero = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  // BD actual usa genero tipo CHAR(1) en personas: M/F/O.
  if (['M', 'MASCULINO', 'HOMBRE', 'MALE'].includes(raw)) return 'M';
  if (['F', 'FEMENINO', 'MUJER', 'FEMALE'].includes(raw)) return 'F';
  if (['O', 'OTRO', 'NO_BINARIO', 'NB'].includes(raw)) return 'O';
  return '';
};

const MAX_PERSON_NAME_LENGTH = 70;
const MAX_EMAIL_LENGTH = 254;
const MAX_USERNAME_LENGTH = 60;

const normalizeShortText = (value, maxLength = 120) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, Math.max(1, Number(maxLength) || 120));

const normalizePersonName = (value, fallback = '') => {
  const normalized = normalizeShortText(value, MAX_PERSON_NAME_LENGTH);
  if (normalized) return normalized;
  return normalizeShortText(fallback, MAX_PERSON_NAME_LENGTH) || '';
};

const splitEmailLocalPart = (email) => {
  const localPart = String(email || '').split('@')[0] || '';
  return localPart
    .replace(/[^a-zA-Z0-9._-]/g, ' ')
    .split(/[._\-\s]+/)
    .map((part) => normalizeShortText(part, MAX_PERSON_NAME_LENGTH))
    .filter(Boolean);
};

const resolvePersonaNames = ({ nombre, apellido, email }) => {
  const emailParts = splitEmailLocalPart(email);
  const fallbackNombre = emailParts[0] || 'Cliente';
  const fallbackApellido = emailParts.slice(1).join(' ') || 'Web';
  return {
    nombre: normalizePersonName(nombre, fallbackNombre),
    apellido: normalizePersonName(apellido, fallbackApellido)
  };
};

const sanitizeUsernameToken = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const buildUsernameSeed = ({ nombre, apellido, email }) => {
  const fromNombre = sanitizeUsernameToken(nombre).slice(0, 1);
  const fromApellido = sanitizeUsernameToken(apellido).slice(0, 16);
  const fromEmail = sanitizeUsernameToken(String(email || '').split('@')[0]).slice(0, 16);
  const base = `${fromNombre}${fromApellido}` || fromEmail || 'cliente';
  return base.slice(0, 24);
};

const resolveSupabaseProfile = ({ email = '', userData = null }) => {
  const metadata =
    (userData && typeof userData === 'object' && userData.user_metadata && typeof userData.user_metadata === 'object'
      ? userData.user_metadata
      : {}) || {};
  const fullName = normalizeShortText(metadata.full_name || metadata.name || '', MAX_PERSON_NAME_LENGTH * 2);
  const fullNameParts = fullName.split(/\s+/).filter(Boolean);
  const parsedNombre = normalizePersonName(metadata.nombre || fullNameParts[0] || '', '');
  const parsedApellido = normalizePersonName(
    metadata.apellido || fullNameParts.slice(1).join(' ') || '',
    ''
  );
  const parsedGenero = normalizeGenero(metadata.genero || metadata.gender || '');
  const fallbackNames = resolvePersonaNames({ nombre: parsedNombre, apellido: parsedApellido, email });
  return {
    nombre: fallbackNames.nombre,
    apellido: fallbackNames.apellido,
    genero: parsedGenero || 'O'
  };
};

const validatePasswordPolicy = (clave) => {
  const password = String(clave || '');
  if (password.length < 10) return 'La contraseña debe tener al menos 10 caracteres';
  if (!/[A-Z]/.test(password)) return 'La contraseña debe incluir al menos una mayúscula';
  if (!/[0-9]/.test(password)) return 'La contraseña debe incluir al menos un número';
  return '';
};

const apiError = (res, status, { code, message, field = null, details = null }) =>
  res.status(status).json({
    error: true,
    code: String(code || 'UNEXPECTED_ERROR'),
    message: String(message || 'Ocurrio un error'),
    field,
    details
  });

const apiSuccess = (res, status, payload = {}) =>
  res.status(status).json({
    error: false,
    ...payload
  });

const hashVerificationToken = (token) =>
  crypto.createHash('sha256').update(String(token || '')).digest('hex');

const generateVerificationToken = () => crypto.randomBytes(48).toString('base64url');

const assertVerificationTokenTable = async (queryRunner = pool) => {
  const result = await queryRunner.query(
    "SELECT to_regclass('public.verificacion_cuentas_tokens') AS table_name"
  );
  if (!result.rows?.[0]?.table_name) {
    const error = new Error('La migracion sprint5_registro_cliente_seguro.sql no esta aplicada.');
    error.code = 'VERIFICATION_TOKEN_TABLE_MISSING';
    throw error;
  }
};

const activateAccountFromVerificationToken = async (rawToken) => {
  const token = normalizeIdentifier(rawToken);
  if (!token) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Token de verificacion requerido.',
      field: 'token'
    };
  }

  await assertVerificationTokenTable();

  const tokenHash = hashVerificationToken(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tokenRes = await client.query(
      `SELECT vt.id_token, vt.id_usuario, vt.token_expires_at, vt.used_at,
              ia.auth_user_id
       FROM verificacion_cuentas_tokens vt
       INNER JOIN identidades_auth ia ON ia.id_usuario = vt.id_usuario
       WHERE vt.token_hash = $1
       LIMIT 1
       FOR UPDATE`,
      [tokenHash]
    );

    if (!tokenRes.rows.length) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 400,
        code: 'INVALID_TOKEN',
        message: 'El token de verificacion no es valido.',
        field: 'token'
      };
    }

    const row = tokenRes.rows[0];
    if (row.used_at) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 409,
        code: 'TOKEN_ALREADY_USED',
        message: 'El token de verificacion ya fue utilizado.',
        field: 'token'
      };
    }

    const exp = new Date(row.token_expires_at);
    if (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 400,
        code: 'TOKEN_EXPIRED',
        message: 'El token de verificacion expiro. Solicita uno nuevo.',
        field: 'token'
      };
    }

    await confirmarIdentidadSupabase(row.auth_user_id);

    await client.query(`UPDATE usuarios SET estado = true WHERE id_usuario = $1`, [row.id_usuario]);
    await client.query(
      `UPDATE identidades_auth
       SET email_verificado = true,
           ultima_autenticacion = NOW()
       WHERE id_usuario = $1`,
      [row.id_usuario]
    );
    await client.query(
      `UPDATE verificacion_cuentas_tokens
       SET used_at = NOW()
       WHERE id_token = $1`,
      [row.id_token]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      status: 200,
      code: 'EMAIL_VERIFIED',
      message: 'Email verificado exitosamente. Ya puedes iniciar sesion.',
      verified: true
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMessage =
      data?.msg
      || data?.message
      || data?.error_description
      || data?.error
      || `Supabase Auth error HTTP ${res.status}`;
    const error = new Error(String(rawMessage));
    error.status = res.status;
    error.code = data?.code || null;
    error.payload = data;
    throw error;
  }
  return data.id; // UUID de Supabase
};

const eliminarIdentidadSupabase = async (authUserId) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !authUserId) return;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUserId}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });

  if (!response.ok && response.status !== 404) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.message || payload?.msg || 'No se pudo compensar usuario de autenticacion.');
  }
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

const confirmarIdentidadSupabase = async (authUserId) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !authUserId) return;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUserId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({ email_confirm: true })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.message || payload?.msg || 'No se pudo confirmar usuario en Supabase');
  }
};

const resolveDefaultTipoClienteId = async (queryRunner) => {
  try {
    const preferred = await queryRunner.query(
      'SELECT id_tipo_cliente FROM public.tipo_cliente WHERE id_tipo_cliente = 2 LIMIT 1'
    );
    const preferredId = Number.parseInt(String(preferred.rows?.[0]?.id_tipo_cliente ?? ''), 10);
    if (Number.isInteger(preferredId) && preferredId > 0) return preferredId;
  } catch {
    // Tabla tipo_cliente no disponible o esquema distinto.
  }

  try {
    const firstAvailable = await queryRunner.query(
      'SELECT id_tipo_cliente FROM public.tipo_cliente ORDER BY id_tipo_cliente ASC LIMIT 1'
    );
    const firstId = Number.parseInt(String(firstAvailable.rows?.[0]?.id_tipo_cliente ?? ''), 10);
    if (Number.isInteger(firstId) && firstId > 0) return firstId;
  } catch {
    // Tabla tipo_cliente no disponible o esquema distinto.
  }

  return null;
};

const insertarClienteSeguro = async (queryRunner, idPersona) => {
  const defaultTipoClienteId = await resolveDefaultTipoClienteId(queryRunner);
  const attempts = [];

  if (defaultTipoClienteId) {
    attempts.push(async () => {
      const result = await queryRunner.query(
        `INSERT INTO clientes (id_persona, id_tipo_cliente, fecha_ingreso, puntos)
         VALUES ($1, $2, CURRENT_DATE, 0)
         RETURNING id_cliente`,
        [idPersona, defaultTipoClienteId]
      );
      return result.rows[0]?.id_cliente ?? null;
    });
  }

  attempts.push(async () => {
    const result = await queryRunner.query(
      `INSERT INTO clientes (id_persona) VALUES ($1) RETURNING id_cliente`,
      [idPersona]
    );
    return result.rows[0]?.id_cliente ?? null;
  });

  attempts.push(async () => {
    const fallback = await queryRunner.query(
      `INSERT INTO clientes (id_persona, id_tipo_cliente, fecha_ingreso, puntos)
       VALUES ($1, 2, CURRENT_DATE, 0) RETURNING id_cliente`,
      [idPersona]
    );
    return fallback.rows[0]?.id_cliente ?? null;
  });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const idCliente = await attempt();
      if (Number.isInteger(Number(idCliente)) && Number(idCliente) > 0) {
        return idCliente;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('CLIENT_INSERT_FAILED');
};

const buildUniqueClienteUsername = async (queryRunner, profile) => {
  const seed = buildUsernameSeed(profile);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const digits = Math.floor(100 + Math.random() * 900);
    const candidate = `${seed}${digits}`.slice(0, MAX_USERNAME_LENGTH);
    const exists = await queryRunner.query(
      `SELECT 1 FROM usuarios WHERE nombre_usuario = $1 LIMIT 1`,
      [candidate]
    );
    if (exists.rows.length === 0) return candidate;
  }

  return `cli${Date.now().toString(36)}${Math.floor(10 + Math.random() * 90)}`.slice(0, MAX_USERNAME_LENGTH);
};

const createLocalClienteAccount = async (
  queryRunner,
  {
    email,
    authUserId,
    nombre,
    apellido,
    genero = 'O',
    provider = 'email',
    emailVerificado = false,
    estadoUsuario = false,
    passwordMarker = 'SUPABASE_AUTH'
  }
) => {
  const safeEmail = normalizeShortText(normalizeEmail(email), MAX_EMAIL_LENGTH);
  if (!safeEmail) throw new Error('EMAIL_REQUIRED');
  if (!authUserId) throw new Error('AUTH_USER_REQUIRED');

  const names = resolvePersonaNames({ nombre, apellido, email: safeEmail });
  const safeGenero = normalizeGenero(genero) || 'O';
  const nombreUsuario = await buildUniqueClienteUsername(queryRunner, {
    nombre: names.nombre,
    apellido: names.apellido,
    email: safeEmail
  });

  const personaRes = await queryRunner.query(
    `INSERT INTO personas (nombre, apellido, genero) VALUES ($1, $2, $3) RETURNING id_persona`,
    [names.nombre, names.apellido, safeGenero]
  );
  const id_persona = personaRes.rows[0]?.id_persona ?? null;
  if (!id_persona) throw new Error('PERSONA_INSERT_FAILED');

  const id_cliente = await insertarClienteSeguro(queryRunner, id_persona);
  if (!Number.isInteger(Number(id_cliente)) || Number(id_cliente) <= 0) {
    throw new Error('CLIENT_INSERT_FAILED');
  }

  const usuarioRes = await queryRunner.query(
    `INSERT INTO usuarios (nombre_usuario, clave, estado, tipo_usuario, id_cliente, must_change_password)
     VALUES ($1, $2, $3, 'CLIENTE', $4, false)
     RETURNING id_usuario, nombre_usuario, tipo_usuario, id_cliente, estado, must_change_password`,
    [nombreUsuario, passwordMarker, Boolean(estadoUsuario), id_cliente]
  );
  const usuario = usuarioRes.rows[0];
  if (!usuario?.id_usuario) throw new Error('USER_INSERT_FAILED');

  const rolRes = await queryRunner.query(
    `SELECT id_rol FROM roles WHERE UPPER(TRIM(nombre)) = 'CLIENTE' LIMIT 1`
  );
  if (rolRes.rows.length > 0) {
    await queryRunner.query(
      `INSERT INTO roles_usuarios (id_rol, id_usuario) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [rolRes.rows[0].id_rol, usuario.id_usuario]
    );
  }

  await queryRunner.query(
    `
      INSERT INTO usuarios_clientes (
        id_usuario,
        id_cliente,
        estado,
        fecha_vinculacion,
        fecha_actualizacion
      )
      VALUES ($1, $2, true, NOW(), NOW())
      ON CONFLICT (id_usuario, id_cliente) DO UPDATE
      SET
        estado = true,
        fecha_actualizacion = NOW()
    `,
    [usuario.id_usuario, id_cliente]
  );

  await queryRunner.query(
    `INSERT INTO identidades_auth (id_usuario, auth_user_id, provider, email_login, email_verificado, activo)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [usuario.id_usuario, authUserId, provider, safeEmail, Boolean(emailVerificado)]
  );

  await queryRunner.query(
    `INSERT INTO correos (id_persona, direccion_correo) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id_persona, safeEmail]
  ).catch(() => {});

  return {
    usuario,
    id_usuario: usuario.id_usuario,
    id_persona,
    id_cliente
  };
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
  const { clave } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  const nombre = normalizeIdentifier(req.body?.nombre);
  const apellido = normalizeIdentifier(req.body?.apellido);
  const genero = normalizeGenero(req.body?.genero);
  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;

  if (!email || !clave || !nombre || !apellido || !genero) {
    return apiError(res, 400, {
      code: 'VALIDATION_ERROR',
      message: 'Nombre, apellido, genero, email y contrasena son obligatorios.',
      field: !genero ? 'genero' : null
    });
  }

  const passwordPolicyError = validatePasswordPolicy(clave);
  if (passwordPolicyError) {
    return apiError(res, 400, {
      code: 'PASSWORD_POLICY_FAILED',
      message: passwordPolicyError,
      field: 'clave'
    });
  }

  const client = await pool.connect();
  let authUserIdCreated = null;
  let verificationEmailSent = false;
  try {
    await assertVerificationTokenTable();
    await client.query('BEGIN');

    const emailExiste = await client.query(
      `SELECT ia.id_identidad_auth FROM identidades_auth ia WHERE ia.email_login = $1`,
      [email]
    );
    if (emailExiste.rows.length > 0) {
      await client.query('ROLLBACK');
      return apiError(res, 409, {
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'El correo ya esta registrado.',
        field: 'email'
      });
    }

    const personaProfile = resolvePersonaNames({ nombre, apellido, email });

    const auth_user_id = await crearIdentidadSupabase(email, clave);
    authUserIdCreated = auth_user_id;

    const createdAccount = await createLocalClienteAccount(client, {
      email,
      authUserId: auth_user_id,
      nombre: personaProfile.nombre,
      apellido: personaProfile.apellido,
      genero,
      provider: 'email',
      emailVerificado: false,
      estadoUsuario: false,
      passwordMarker: 'SUPABASE_AUTH'
    });
    const nuevoUsuario = createdAccount.usuario;

    const verificationToken = generateVerificationToken();
    const verificationTokenHash = hashVerificationToken(verificationToken);
    await client.query(
      `INSERT INTO verificacion_cuentas_tokens (
        id_usuario,
        token_hash,
        token_expires_at,
        request_ip,
        user_agent
      )
      VALUES ($1, $2, NOW() + INTERVAL '24 hours', $3, $4)`,
      [nuevoUsuario.id_usuario, verificationTokenHash, ip_origen, user_agent]
    );

    await client.query('COMMIT');

    const verificationLink =
      buildUrlWithParams(resolveBackendOrigin(req), '/api/public/verify-email-link', {
        token: verificationToken
      }) ||
      buildUrlWithParams(resolveFrontendOrigin(req), '/auth/callback', {
        verify_token: verificationToken
      });

    if (!verificationLink) {
      console.error(
        '[public/register] No se pudo resolver URL de verificacion. Configura FRONTEND_ORIGIN o BACKEND_PUBLIC_ORIGIN.'
      );
    }
    try {
      if (verificationLink) {
        await enviarVerificacion(email, nombre || '', verificationLink, nuevoUsuario.id_usuario);
        verificationEmailSent = true;
      }
    } catch (emailErr) {
      console.error('[public/register] Error enviando correo de verificacion:', emailErr.message);
    }

    return apiSuccess(res, 201, {
      message: verificationEmailSent
        ? 'Te hemos enviado un correo de verificacion. Revisa tu bandeja de entrada para activar tu cuenta.'
        : 'Cuenta creada. No se pudo enviar el correo de verificacion en este momento.',
      requiresVerification: true,
      verificationEmailSent
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (authUserIdCreated) {
      await eliminarIdentidadSupabase(authUserIdCreated).catch((cleanupError) => {
        console.error('[public/register] No se pudo compensar usuario auth:', cleanupError.message);
      });
    }

    console.error('[public/register] Error:', error);

    const normalizedErrorMsg = String(error?.message || '').toLowerCase();
    const isDuplicateEmail =
      normalizedErrorMsg.includes('user already registered')
      || normalizedErrorMsg.includes('has already been registered')
      || normalizedErrorMsg.includes('already exists')
      || normalizedErrorMsg.includes('already registered')
      || normalizedErrorMsg.includes('duplicate')
      || normalizedErrorMsg.includes('email_exists');

    if (isDuplicateEmail) {
      return apiError(res, 409, {
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'El correo electronico ya existe en autenticacion.',
        field: 'email'
      });
    }

    if (error?.code === '22001') {
      return apiError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Uno de los campos excede la longitud permitida por la base de datos.'
      });
    }

    return apiError(res, 500, {
      code: 'REGISTER_FAILED',
      message: 'No se pudo completar el registro del cliente.'
    });
  } finally {
    client.release();
  }
});

router.post('/api/public/resend-verification', resendVerificationLimiter, async (req, res) => {
  const identifier = normalizeIdentifier(req.body?.identifier ?? req.body?.email);
  const isEmailIdentifier = identifier.includes('@');
  const normalizedLookup = isEmailIdentifier ? normalizeEmail(identifier) : identifier;
  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;

  if (!normalizedLookup) {
    return apiError(res, 400, {
      code: 'VALIDATION_ERROR',
      message: 'Correo o usuario requerido.',
      field: 'identifier'
    });
  }

  const genericMessage =
    'Si la cuenta existe y esta pendiente de verificacion, enviaremos un nuevo correo de verificacion.';

  try {
    await assertVerificationTokenTable();

    const accountRes = await pool.query(
      `SELECT
          ia.id_usuario,
          ia.email_login,
          ia.email_verificado,
          ia.provider,
          u.estado,
          COALESCE(p.nombre, '') AS nombre
       FROM identidades_auth ia
       INNER JOIN usuarios u ON u.id_usuario = ia.id_usuario
       LEFT JOIN clientes c ON c.id_cliente = u.id_cliente
       LEFT JOIN personas p ON p.id_persona = c.id_persona
       WHERE (
         ($2::boolean = true AND ia.email_login = $1)
         OR
         ($2::boolean = false AND LOWER(u.nombre_usuario) = LOWER($1))
       )
       ORDER BY ia.id_identidad_auth DESC
       LIMIT 1`,
      [normalizedLookup, isEmailIdentifier]
    );

    if (!accountRes.rows.length) {
      return apiSuccess(res, 200, { message: genericMessage });
    }

    const account = accountRes.rows[0];
    const provider = String(account.provider || '').trim().toLowerCase();
    const emailVerificado = Boolean(account.email_verificado);
    const usuarioActivo = Boolean(account.estado);
    const safeEmail = normalizeEmail(account.email_login);

    if (!safeEmail || provider !== 'email' || emailVerificado || usuarioActivo) {
      return apiSuccess(res, 200, { message: genericMessage });
    }

    const dbClient = await pool.connect();
    let verificationToken = '';
    try {
      await dbClient.query('BEGIN');

      await dbClient.query(
        `UPDATE verificacion_cuentas_tokens
         SET used_at = NOW()
         WHERE id_usuario = $1
           AND used_at IS NULL`,
        [account.id_usuario]
      );

      verificationToken = generateVerificationToken();
      const verificationTokenHash = hashVerificationToken(verificationToken);
      await dbClient.query(
        `INSERT INTO verificacion_cuentas_tokens (
          id_usuario,
          token_hash,
          token_expires_at,
          request_ip,
          user_agent
        )
        VALUES ($1, $2, NOW() + INTERVAL '24 hours', $3, $4)`,
        [account.id_usuario, verificationTokenHash, ip_origen, user_agent]
      );

      await dbClient.query('COMMIT');
    } catch (dbError) {
      await dbClient.query('ROLLBACK').catch(() => {});
      throw dbError;
    } finally {
      dbClient.release();
    }

    const verificationLink =
      buildUrlWithParams(resolveBackendOrigin(req), '/api/public/verify-email-link', {
        token: verificationToken
      }) ||
      buildUrlWithParams(resolveFrontendOrigin(req), '/auth/callback', {
        verify_token: verificationToken
      });

    if (verificationLink) {
      try {
        await enviarVerificacion(safeEmail, account.nombre || '', verificationLink, account.id_usuario);
      } catch (emailErr) {
        console.error('[public/resend-verification] Error enviando correo de verificacion:', emailErr.message);
      }
    } else {
      console.error(
        '[public/resend-verification] No se pudo resolver URL de verificacion. Configura FRONTEND_ORIGIN o BACKEND_PUBLIC_ORIGIN.'
      );
    }

    return apiSuccess(res, 200, { message: genericMessage });
  } catch (error) {
    console.error('[public/resend-verification] Error:', error);
    return apiSuccess(res, 200, { message: genericMessage });
  }
});

router.post('/api/public/login', publicLoginIpLimiter, publicLoginAccountIpLimiter, async (req, res) => {
  const identifier = normalizeIdentifier(req.body?.identifier ?? req.body?.email);
  const { clave } = req.body || {};
  if (!identifier || !clave) {
    return apiError(res, 400, {
      code: 'VALIDATION_ERROR',
      message: 'Usuario/email y contrasena son requeridos.'
    });
  }

  const ip_origen = getClientIp(req);
  const user_agent = req.get('user-agent') || null;
  const { dispositivo, navegador, sistema_operativo } = parseUserAgent(user_agent);

  const attemptedIdentifier = identifier;
  let resolvedEmail = '';

  try {
    let email = identifier;

    if (!identifier.includes('@')) {
      const uRes = await pool.query(
        `SELECT ia.email_login
         FROM usuarios u
         JOIN identidades_auth ia ON u.id_usuario = ia.id_usuario
         WHERE u.nombre_usuario = $1 LIMIT 1`,
        [identifier]
      );
      if (uRes.rows.length === 0) {
        await insertLoginLog({
          id_usuario: null,
          id_sesion: null,
          ip_origen,
          nombre_usuario_intentado: attemptedIdentifier,
          user_agent,
          dispositivo,
          navegador,
          sistema_operativo,
          ubicacion: null,
          exito: false,
          mensaje_error: 'Credenciales invalidas'
        }).catch(() => {});
        return apiError(res, 401, {
          code: 'INVALID_CREDENTIALS',
          message: 'Credenciales invalidas.'
        });
      }
      email = uRes.rows[0].email_login;
    }

    resolvedEmail = email;
    const { auth_user_id } = await autenticarConSupabase(email, clave);

    const identRes = await pool.query(
      `SELECT ia.id_usuario FROM identidades_auth ia WHERE ia.auth_user_id = $1 LIMIT 1`,
      [auth_user_id]
    );

    if (identRes.rows.length === 0) {
      return apiError(res, 401, {
        code: 'INVALID_CREDENTIALS',
        message: 'Credenciales invalidas.'
      });
    }

    const id_usuario = identRes.rows[0].id_usuario;
    const usuario = await getClienteUsuarioById(id_usuario);

    if (!usuario || !usuario.estado) {
      return apiError(res, 403, {
        code: 'ACCOUNT_DISABLED',
        message: 'Cuenta desactivada.'
      });
    }

    if (String(usuario?.tipo_usuario || '').trim().toUpperCase() !== 'CLIENTE') {
      return apiError(res, 403, {
        code: 'ACCOUNT_SCOPE_INVALID',
        message: 'Este acceso corresponde solo a cuentas de cliente.'
      });
    }

    await pool.query(
      `UPDATE identidades_auth SET ultima_autenticacion = NOW() WHERE auth_user_id = $1`,
      [auth_user_id]
    );

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

    return apiSuccess(res, 200, {
      message: 'Login exitoso',
      usuario: { ...usuario, roles: authz.roles, permisos: authz.permisos },
      roles: authz.roles,
      permisos: authz.permisos,
      csrfToken
    });
  } catch (error) {
    const supabaseMessage = String(error?.message || '').toLowerCase();
    const isNotVerified = supabaseMessage.includes('email not confirmed') || supabaseMessage.includes('not confirmed');

    await insertLoginLog({
      id_usuario: null,
      id_sesion: null,
      ip_origen,
      nombre_usuario_intentado: resolvedEmail || attemptedIdentifier,
      user_agent,
      dispositivo,
      navegador,
      sistema_operativo,
      ubicacion: null,
      exito: false,
      mensaje_error: isNotVerified ? 'Email no verificado' : 'Credenciales invalidas'
    }).catch(() => {});

    if (isNotVerified) {
      return apiError(res, 403, {
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Debes verificar tu correo antes de iniciar sesion.'
      });
    }

    return apiError(res, 401, {
      code: 'INVALID_CREDENTIALS',
      message: 'Credenciales invalidas.'
    });
  }
});

// ── POST /api/public/forgot-password ─────────────────────────────────
const PUBLIC_FORGOT_PASSWORD_GENERIC_MESSAGE =
  'Si el correo esta registrado, recibiras instrucciones de recuperacion.';

const INTERNAL_TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const INTERNAL_TEMP_PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const INTERNAL_TEMP_PASSWORD_NUMBERS = '23456789';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const generateInternalTemporaryPassword = async () => {
  const length = crypto.randomInt(10, 13);
  const chars = [
    INTERNAL_TEMP_PASSWORD_UPPER[crypto.randomInt(0, INTERNAL_TEMP_PASSWORD_UPPER.length)],
    INTERNAL_TEMP_PASSWORD_NUMBERS[crypto.randomInt(0, INTERNAL_TEMP_PASSWORD_NUMBERS.length)]
  ];

  while (chars.length < length) {
    chars.push(INTERNAL_TEMP_PASSWORD_ALPHABET[crypto.randomInt(0, INTERNAL_TEMP_PASSWORD_ALPHABET.length)]);
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
};

const buildInternalTemporaryPasswordEmailHtml = ({ displayName, username, temporaryPassword }) => {
  const safeName = escapeHtml(displayName || 'usuario');
  const safeUsername = escapeHtml(username || 'N/D');
  const safePassword = escapeHtml(temporaryPassword || 'N/D');

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background:#0e0704; font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px; margin:28px auto; background:#1a1108; border:1px solid rgba(212,165,116,0.25); border-radius:14px;">
    <tr>
      <td style="padding:28px 32px; color:#fdfaf5;">
        <h2 style="margin:0 0 10px; color:#d4a574;">Credenciales temporales</h2>
        <p style="margin:0 0 16px; color:rgba(255,255,255,0.82); line-height:1.5;">
          Hola ${safeName},<br/>Hemos generado una nueva contrasena temporal para tu cuenta.
        </p>
        <div style="background:#24170f; border:1px solid rgba(212,165,116,0.28); border-radius:10px; padding:16px;">
          <p style="margin:0 0 8px; color:rgba(255,255,255,0.8);"><strong>Usuario:</strong> ${safeUsername}</p>
          <p style="margin:0; color:rgba(255,255,255,0.8);"><strong>Contrasena temporal:</strong> ${safePassword}</p>
        </div>
        <p style="margin:16px 0 0; color:rgba(255,255,255,0.68); line-height:1.5;">
          Por seguridad, inicia sesion y cambia la contrasena en tu primer acceso.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

const findActiveInternalUsersByEmail = async (email) => {
  const result = await pool.query(
    `
      SELECT DISTINCT ON (u.id_usuario)
        u.id_usuario,
        u.nombre_usuario,
        u.estado,
        u.tipo_usuario,
        COALESCE(
          NULLIF(TRIM(CONCAT_WS(' ', pe.nombre, pe.apellido)), ''),
          NULLIF(TRIM(u.nombre_usuario), '')
        ) AS nombre_visible,
        LOWER(TRIM(COALESCE(c_link.direccion_correo, c_persona.direccion_correo))) AS correo
      FROM usuarios u
      JOIN empleados e ON e.id_empleado = u.id_empleado
      JOIN personas pe ON pe.id_persona = e.id_persona
      LEFT JOIN correos c_link ON c_link.id_correo = pe.id_correo
      LEFT JOIN correos c_persona ON c_persona.id_persona = pe.id_persona
      WHERE LOWER(TRIM(COALESCE(c_link.direccion_correo, c_persona.direccion_correo))) = $1
        AND COALESCE(u.estado, true) = true
        AND UPPER(COALESCE(u.tipo_usuario, '')) <> 'CLIENTE'
      LIMIT 2
    `,
    [email]
  );

  return result.rows || [];
};

const resetInternalUserPasswordFromPublicForgot = async (user) => {
  const idUsuario = Number.parseInt(String(user?.id_usuario ?? ''), 10);
  if (!Number.isInteger(idUsuario) || idUsuario <= 0) return;

  const temporaryPassword = await generateInternalTemporaryPassword();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const updateResult = await client.query(
      `
        UPDATE usuarios
        SET
          clave = crypt($1::text, gen_salt('bf', 12)),
          must_change_password = true,
          fecha_cambio_clave = NULL
        WHERE id_usuario = $2
        RETURNING id_usuario, nombre_usuario, must_change_password
      `,
      [temporaryPassword, idUsuario]
    );

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[public/forgot-password] Error regenerando contrasena temporal interna:', error?.message || error);
    return;
  } finally {
    client.release();
  }

  await closeAllUserSessions(idUsuario, 'password_reset').catch(() => {});

  try {
    await enviarCorreo(
      user.correo,
      'Nueva contrasena temporal - Jonnys SmartOrder',
      buildInternalTemporaryPasswordEmailHtml({
        displayName: user.nombre_visible,
        username: user.nombre_usuario,
        temporaryPassword
      }),
      {
        id_usuario: idUsuario,
        tipo_correo: 'credenciales_temporales_reset',
        fromKey: 'ACCESO'
      }
    );
  } catch (error) {
    console.error('[public/forgot-password] Error enviando credenciales temporales internas:', error?.message || error);
  }
};

router.post('/api/public/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ error: true, message: 'Email requerido' });
  }

  try {
    // Verificar que exista la identidad
    const identRes = await pool.query(
      `SELECT ia.id_identidad_auth, ia.id_usuario FROM identidades_auth ia WHERE ia.email_login = $1 LIMIT 1`,
      [email]
    );

    if (identRes.rows.length === 0) {
      const internalUsers = await findActiveInternalUsersByEmail(email);

      if (internalUsers.length > 1) {
        console.warn('[public/forgot-password] Correo interno asociado a multiples usuarios');
        return res.json({ message: PUBLIC_FORGOT_PASSWORD_GENERIC_MESSAGE });
      }

      if (internalUsers.length === 1) {
        await resetInternalUserPasswordFromPublicForgot(internalUsers[0]);
      }

      return res.json({ message: PUBLIC_FORGOT_PASSWORD_GENERIC_MESSAGE });
    }

    const id_usuario = identRes.rows[0].id_usuario;

    // Generar link de recuperación vía Supabase Admin API y enviar por SMTP propio
    try {
      const frontendOrigin = resolveFrontendOrigin(req);
      const redirectTo = buildUrlWithParams(frontendOrigin, '/auth/callback', {
        next: '/reset-password'
      });

      if (!redirectTo) {
        throw new Error('FRONTEND_ORIGIN_NOT_CONFIGURED');
      }
      const linkData = await generarLinkSupabase('recovery', email, {
        redirect_to: redirectTo
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

    return res.json({ message: PUBLIC_FORGOT_PASSWORD_GENERIC_MESSAGE });
  } catch (error) {
    console.error('[public/forgot-password] Error:', error);
    return res.json({ message: PUBLIC_FORGOT_PASSWORD_GENERIC_MESSAGE });
  }
});

// ── POST /api/public/reset-password ───────────────────────────────────────────
router.post('/api/public/reset-password', forgotPasswordLimiter, async (req, res) => {
  const accessToken = normalizeIdentifier(req.body?.access_token);
  const nuevaClave = String(req.body?.nueva_clave || '');

  if (!accessToken || !nuevaClave) {
    return res.status(400).json({ error: true, message: 'Token y nueva contraseña son requeridos.' });
  }

  const passwordPolicyError = validatePasswordPolicy(nuevaClave);
  if (passwordPolicyError) {
    return res.status(400).json({ error: true, message: passwordPolicyError });
  }

  try {
    const anonKey = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
    const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ password: nuevaClave })
    });

    const updateData = await updateRes.json().catch(() => ({}));
    if (!updateRes.ok) {
      return res.status(400).json({
        error: true,
        message: 'El enlace de recuperación no es válido o expiró.'
      });
    }

    const authUserId = updateData?.id;
    if (authUserId) {
      const userRes = await pool.query(
        `SELECT ia.id_usuario
         FROM identidades_auth ia
         WHERE ia.auth_user_id = $1
         LIMIT 1`,
        [authUserId]
      );

      if (userRes.rows.length > 0) {
        await closeAllUserSessions(userRes.rows[0].id_usuario, 'password_reset').catch(() => {});
      }
    }

    return res.json({ message: 'Contraseña actualizada correctamente.' });
  } catch (_error) {
    console.error('[public/reset-password] Failed to reset password');
    return res.status(500).json({ error: true, message: 'No se pudo restablecer la contraseña.' });
  }
});

// ── POST /api/public/verify-email ────────────────────────────────────
/**
 * Soporta dos flujos:
 * A) access_token en body: Supabase ya verificó el email internamente y nos da el token
 *    de sesión. Solo necesitamos activar el usuario local.
 * B) token_hash + type: Flujo manual donde enviamos el token a Supabase para verificar.
 */
router.get('/api/public/verify-email-link', async (req, res) => {
  const token = normalizeIdentifier(req.query?.token ?? req.query?.verify_token);
  const frontendOrigin = resolveFrontendOrigin(req);
  const loginVerifiedUrl = buildUrlWithParams(frontendOrigin, '/auth/login', { verified: 1 });

  try {
    const tokenResult = await activateAccountFromVerificationToken(token);
    if (!tokenResult.ok) {
      if (loginVerifiedUrl) {
        const retryUrl = buildUrlWithParams(frontendOrigin, '/auth/login', {
          verify_error: tokenResult.code || 'INVALID_TOKEN'
        });
        if (retryUrl) return res.redirect(302, retryUrl);
      }

      return res.status(tokenResult.status || 400).type('html').send(`
        <!DOCTYPE html>
        <html lang="es">
          <head><meta charset="utf-8"><title>Verificacion de cuenta</title></head>
          <body style="font-family:Arial,sans-serif;padding:24px;">
            <h2>No se pudo verificar el correo</h2>
            <p>${tokenResult.message || 'El token no es valido o ya expiro.'}</p>
          </body>
        </html>
      `);
    }

    if (loginVerifiedUrl) {
      return res.redirect(302, loginVerifiedUrl);
    }

    return res.status(200).type('html').send(`
      <!DOCTYPE html>
      <html lang="es">
        <head><meta charset="utf-8"><title>Cuenta verificada</title></head>
        <body style="font-family:Arial,sans-serif;padding:24px;">
          <h2>Cuenta verificada correctamente</h2>
          <p>Ya puedes iniciar sesion.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('[public/verify-email-link] Error:', error);
    return res.status(500).type('html').send(`
      <!DOCTYPE html>
      <html lang="es">
        <head><meta charset="utf-8"><title>Error de verificacion</title></head>
        <body style="font-family:Arial,sans-serif;padding:24px;">
          <h2>Error al verificar el correo</h2>
          <p>Intenta de nuevo mas tarde.</p>
        </body>
      </html>
    `);
  }
});

router.post('/api/public/verify-email', async (req, res) => {
  const token = normalizeIdentifier(req.body?.token ?? req.body?.verify_token);
  const { token_hash, type, access_token } = req.body || {};

  try {
    await assertVerificationTokenTable();

    if (token) {
      const tokenResult = await activateAccountFromVerificationToken(token);
      if (!tokenResult.ok) {
        return apiError(res, tokenResult.status, {
          code: tokenResult.code,
          message: tokenResult.message,
          field: tokenResult.field || 'token'
        });
      }
      return apiSuccess(res, tokenResult.status || 200, {
        code: tokenResult.code || 'EMAIL_VERIFIED',
        message: tokenResult.message || 'Email verificado exitosamente.',
        verified: true
      });
    }

    if (!access_token && (!token_hash || !type)) {
      return apiError(res, 400, {
        code: 'VALIDATION_ERROR',
        message: 'Se requiere token o (access_token) o (token_hash + type).'
      });
    }

    const anonKey = process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY;
    let authUserId = null;
    let email = null;
    let supabaseUserPayload = null;

    if (access_token) {
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${access_token}`
        }
      });

      if (!userRes.ok) {
        return apiError(res, 400, {
          code: 'INVALID_TOKEN',
          message: 'Token de verificacion invalido o expirado.',
          field: 'access_token'
        });
      }

      const userData = await userRes.json();
      authUserId = userData.id;
      email = userData.email;
      supabaseUserPayload = userData;
    } else {
      const verifyRes = await fetch(
        `${SUPABASE_URL}/auth/v1/verify?token=${token_hash}&type=${type}`,
        { method: 'GET', headers: { apikey: anonKey } }
      );

      if (!verifyRes.ok) {
        return apiError(res, 400, {
          code: 'INVALID_TOKEN',
          message: 'Token invalido o expirado.',
          field: 'token_hash'
        });
      }

      const verifyData = await verifyRes.json();
      authUserId = verifyData?.user?.id || verifyData?.id;
      email = verifyData?.user?.email || verifyData?.email;
      supabaseUserPayload = verifyData?.user || verifyData || null;
    }

    const identQuery = authUserId
      ? await pool.query(`SELECT id_usuario FROM identidades_auth WHERE auth_user_id = $1 LIMIT 1`, [authUserId])
      : await pool.query(`SELECT id_usuario FROM identidades_auth WHERE email_login = $1 LIMIT 1`, [email]);

    let id_usuario = identQuery.rows[0]?.id_usuario || null;

    if (!id_usuario) {
      if (!authUserId || !email) {
        return apiSuccess(res, 200, {
          message: 'Email verificado. Inicia sesion para continuar.',
          verified: true
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const profile = resolveSupabaseProfile({ email, userData: supabaseUserPayload });
        const createdAccount = await createLocalClienteAccount(client, {
          email,
          authUserId,
          nombre: profile.nombre,
          apellido: profile.apellido,
          genero: profile.genero,
          provider: 'email',
          emailVerificado: true,
          estadoUsuario: true,
          passwordMarker: 'SUPABASE_AUTH'
        });
        id_usuario = createdAccount.id_usuario;
        await client.query('COMMIT');
      } catch (creationError) {
        await client.query('ROLLBACK').catch(() => {});
        throw creationError;
      } finally {
        client.release();
      }
    }

    await pool.query(`UPDATE usuarios SET estado = true WHERE id_usuario = $1`, [id_usuario]);
    await pool.query(
      `UPDATE identidades_auth SET email_verificado = true, ultima_autenticacion = NOW() WHERE id_usuario = $1`,
      [id_usuario]
    );

    return apiSuccess(res, 200, {
      message: 'Email verificado exitosamente. Ya puedes iniciar sesion.',
      verified: true
    });
  } catch (error) {
    console.error('[public/verify-email] Error:', error);
    return apiError(res, 500, {
      code: 'VERIFY_EMAIL_FAILED',
      message: 'Error al verificar email',
      details: process.env.NODE_ENV === 'development' ? String(error?.message || error) : null
    });
  }
});
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
    const profile = resolveSupabaseProfile({ email, userData: supaUser });

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

        const createdAccount = await createLocalClienteAccount(client, {
          email,
          authUserId: auth_user_id,
          nombre: profile.nombre,
          apellido: profile.apellido,
          genero: profile.genero,
          provider: 'google',
          emailVerificado: true,
          estadoUsuario: true,
          passwordMarker: 'GOOGLE_AUTH'
        });
        id_usuario = createdAccount.id_usuario;

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // Emitir sesión y JWT
    const usuario = await getClienteUsuarioById(id_usuario);

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

// ── LEGACY DEPRECATED: /api/public/menu* ──────────────────────────────
// Flujo oficial activo: /api/public-menu/*
router.get('/api/public/menu', async (_req, res) => {
  return res.status(410).json({
    error: true,
    code: 'PUBLIC_MENU_LEGACY_DEPRECATED',
    message: 'Este endpoint fue descontinuado. Usa /api/public-menu/catalogo con id_sucursal y tipo_pedido.'
  });
});

router.get('/api/public/menu/:id', async (_req, res) => {
  return res.status(410).json({
    error: true,
    code: 'PUBLIC_MENU_LEGACY_DEPRECATED',
    message: 'Este endpoint fue descontinuado. Usa /api/public-menu/items/:id_detalle_menu con id_sucursal.'
  });
});

export default router;
