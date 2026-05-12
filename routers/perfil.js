/**
 * routers/perfil.js
 * HU80: Endpoints del perfil del usuario autenticado.
 */

import express from 'express';
import crypto from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import pool from '../config/db-connection.js';
import jwt from 'jsonwebtoken';
import JWT_SECRET from '../config/jwt.js';
import { ensurePasswordChangedAtColumn } from '../utils/security/passwordExpiration.js';
import { supabase } from '../services/supabaseClient.js';
import { passwordChangeLimiter } from '../middleware/rateLimiter.js';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  SUPABASE_ASSETS_BUCKET,
  buildAbsolutePublicUrl,
  UPLOADS_DIR,
  detectImageMimeTypeFromBuffer
} from '../utils/uploads.js';

const router = express.Router();
const LEGACY_BCRYPT_PREFIX_RE = /^\$2[abxy]?\$/i;
const PERFIL_FOTO_PERFIL_MAX_LENGTH = 500;
const PERFIL_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const PERFIL_SUPABASE_SUBDIR = 'FotoPerfil_Usuarios';
const PERFIL_LEGACY_UPLOADS_SUBDIR = 'usuarios';
const PERFIL_UPLOADS_PREFIX = '/uploads/usuarios/';
const PERFIL_BASE64_BODY_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const PERFIL_DATA_URL_PARSE_RE = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i;
const PERFIL_IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;
const PERFIL_IMAGE_URL_RE = /^(https?:\/\/|\/uploads\/)/i;
const PASSWORD_HISTORY_KEEP = 5;

const normalizePerfilText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const estimatePerfilDataUrlBytes = (dataUrl) => {
  const safe = normalizePerfilText(dataUrl);
  const commaIndex = safe.indexOf(',');
  if (commaIndex < 0) return 0;

  const base64 = safe.slice(commaIndex + 1);
  const paddingMatch = base64.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

const validatePerfilPhotoPayload = (fotoPerfil) => {
  if (fotoPerfil === null || fotoPerfil === undefined || normalizePerfilText(fotoPerfil) === '') {
    return { ok: true, value: '', kind: 'empty' };
  }

  const value = normalizePerfilText(fotoPerfil);
  const isDataImage = PERFIL_IMAGE_DATA_URL_RE.test(value);
  const isShortUrl = PERFIL_IMAGE_URL_RE.test(value);

  if (isDataImage) {
    const estimatedBytes = estimatePerfilDataUrlBytes(value);
    if (estimatedBytes <= 0) {
      return {
        ok: false,
        status: 400,
        message: 'Formato de foto no valido. Use una URL (http/https o /uploads/...) o una imagen mas ligera.',
      };
    }

    if (estimatedBytes > PERFIL_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        message: 'La imagen supera el limite de 20 MB.',
      };
    }

    return { ok: true, value, kind: 'data_url' };
  }

  if (value.length > PERFIL_FOTO_PERFIL_MAX_LENGTH) {
    return {
      ok: false,
      status: 413,
      message: 'URL de imagen demasiado larga. Maximo 500 caracteres.',
    };
  }

  if (isShortUrl) {
    return { ok: true, value, kind: 'url' };
  }

  return {
    ok: false,
    status: 400,
    message: 'Formato de foto no valido. Use una URL (http/https o /uploads/...) o una imagen mas ligera.',
  };
};

const parsePerfilDataImagePayload = (dataUrl) => {
  const value = normalizePerfilText(dataUrl);
  const match = value.match(PERFIL_DATA_URL_PARSE_RE);
  if (!match) {
    return {
      ok: false,
      status: 400,
      message: 'Formato de foto no valido. Use una URL (http/https o /uploads/...) o una imagen mas ligera.',
    };
  }

  return {
    ok: true,
    mimeType: String(match[1] || '').toLowerCase(),
    base64Body: String(match[2] || ''),
  };
};

const decodePerfilBase64Image = (base64Body) => {
  const normalized = String(base64Body || '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !PERFIL_BASE64_BODY_REGEX.test(normalized)) {
    return {
      ok: false,
      status: 400,
      message: 'Formato de foto no valido. Use una URL (http/https o /uploads/...) o una imagen mas ligera.',
    };
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    return {
      ok: false,
      status: 400,
      message: 'Formato de foto no valido. Use una URL (http/https o /uploads/...) o una imagen mas ligera.',
    };
  }

  if (buffer.length > PERFIL_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: 'La imagen supera el limite de 20 MB.',
    };
  }

  return { ok: true, buffer };
};

const buildPerfilSupabaseStoragePath = (fileName) => `${PERFIL_SUPABASE_SUBDIR}/${fileName}`;
const buildPerfilDbStoredPath = (storagePath) => `${SUPABASE_ASSETS_BUCKET}/${storagePath}`;

const parsePerfilStoredStoragePath = (rawValue) => {
  const input = normalizePerfilText(rawValue);
  if (!input) return null;

  let candidate = input;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(String(parsed.pathname || '')).replace(/^\/+/, '');
      const publicMarker = 'storage/v1/object/public/';
      const markerIndex = candidate.indexOf(publicMarker);
      if (markerIndex >= 0) {
        candidate = candidate.slice(markerIndex + publicMarker.length);
      }
    } catch {
      return null;
    }
  }

  const parts = candidate.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  return {
    bucket: parts[0],
    filePath: parts.slice(1).join('/')
  };
};

const storePerfilPhotoDataUrlInSupabase = async (dataUrl) => {
  const parsed = parsePerfilDataImagePayload(dataUrl);
  if (!parsed.ok) return parsed;

  const decoded = decodePerfilBase64Image(parsed.base64Body);
  if (!decoded.ok) return decoded;

  const detectedMimeType = detectImageMimeTypeFromBuffer(decoded.buffer);
  const declaredMimeType = parsed.mimeType;
  const effectiveMimeType = detectedMimeType || declaredMimeType;

  if (!effectiveMimeType || !Object.prototype.hasOwnProperty.call(ALLOWED_IMAGE_MIME_TYPES, effectiveMimeType)) {
    return {
      ok: false,
      status: 400,
      message: 'Solo se permiten imagenes JPG, PNG o WEBP.',
    };
  }

  if (declaredMimeType && detectedMimeType && declaredMimeType !== detectedMimeType) {
    return {
      ok: false,
      status: 400,
      message: 'El tipo de archivo de la imagen no coincide con su contenido.',
    };
  }

  const extension = ALLOWED_IMAGE_MIME_TYPES[effectiveMimeType];
  const fileName = `perfil-${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const storagePath = buildPerfilSupabaseStoragePath(fileName);
  const storedPath = buildPerfilDbStoredPath(storagePath);

  const { error: uploadError } = await supabase.storage
    .from(SUPABASE_ASSETS_BUCKET)
    .upload(storagePath, decoded.buffer, {
      contentType: effectiveMimeType,
      cacheControl: '3600',
      upsert: false
    });

  if (uploadError) {
    console.error('PUT /perfil storage upload error:', uploadError);
    return {
      ok: false,
      status: 500,
      message: 'No se pudo guardar la imagen en Storage.',
    };
  }

  return {
    ok: true,
    storedPath,
    uploadedStoragePath: storagePath,
  };
};

const tryDeletePerfilStoredFile = async (storedPath) => {
  const safe = normalizePerfilText(storedPath);
  if (!safe) return;

  const storagePath = parsePerfilStoredStoragePath(safe);
  if (
    storagePath &&
    storagePath.bucket === SUPABASE_ASSETS_BUCKET &&
    storagePath.filePath.startsWith(`${PERFIL_SUPABASE_SUBDIR}/`)
  ) {
    await supabase.storage.from(storagePath.bucket).remove([storagePath.filePath]).catch(() => null);
    return;
  }

  if (!safe.startsWith(PERFIL_UPLOADS_PREFIX)) return;

  const fileName = safe.slice(PERFIL_UPLOADS_PREFIX.length).trim();
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) return;

  const absolutePath = path.join(UPLOADS_DIR, PERFIL_LEGACY_UPLOADS_SUBDIR, fileName);
  await fs.unlink(absolutePath).catch(() => null);
};

const cookieConfig = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    path: '/',
  };
};

const verifyStoredPassword = async (plainPassword, storedPassword) => {
  const plain = String(plainPassword ?? '');
  const stored = String(storedPassword ?? '');
  if (!plain || !stored) return false;

  if (plain === stored) return true;
  if (!LEGACY_BCRYPT_PREFIX_RE.test(stored)) return false;

  const result = await pool.query(
    'SELECT crypt($1::text, $2::text) = $2::text AS ok',
    [plain, stored]
  );
  return Boolean(result.rows?.[0]?.ok);
};

const issueUpdatedAccessToken = (req, res) => {
  const currentUser = req.user || {};
  const payload = {
    id_usuario: currentUser.id_usuario,
    nombre_usuario: currentUser.nombre_usuario,
    rol: currentUser.rol,
    id_sucursal: currentUser.id_sucursal,
    sid: currentUser.sid,
    must_change_password: false,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  const base = cookieConfig();
  res.cookie('access_token', token, {
    ...base,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8,
  });
};

/**
 * GET /perfil
 * Devuelve información del perfil (usuario + persona + contacto + roles + último acceso).
 */
router.get('/perfil', async (req, res) => {
  try {
    await ensurePasswordChangedAtColumn();

    const user = req.user; // lo setea authRequired
    const idUsuario = user?.id_usuario;

    if (!idUsuario) {
      return res.status(401).json({ error: true, message: 'No autorizado' });
    }

    // Perfil base: usuario -> empleado -> persona -> (correo/telefono/direccion)
    const sqlPerfil = `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        u.estado,
        u.foto_perfil,
        u.fecha_cambio_clave,
        u.fecha_creacion,
        e.id_empleado,
        p.id_persona,
        p.nombre,
        p.apellido,
        p.fecha_nacimiento,
        p.genero,
        p.dni,
        p.rtn,
        t.telefono,
        c.direccion_correo AS email,
        d.direccion
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
      WHERE u.id_usuario = $1
      LIMIT 1
    `;

    const perfil = await pool.query(sqlPerfil, [idUsuario]);

    if (perfil.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Perfil no encontrado' });
    }

    // Roles del usuario (many-to-many)
    const sqlRoles = `
      SELECT r.id_rol, r.nombre
      FROM roles_usuarios ru
      INNER JOIN roles r ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = $1
      ORDER BY r.nombre
    `;
    const roles = await pool.query(sqlRoles, [idUsuario]);

    // Último acceso exitoso (logins)
    const sqlUltimoAcceso = `
      SELECT fecha_hora, ip_origen, navegador, sistema_operativo, dispositivo, ubicacion
      FROM logins
      WHERE id_usuario = $1 AND exito = TRUE
      ORDER BY fecha_hora DESC
      LIMIT 1
    `;
    const ultimo = await pool.query(sqlUltimoAcceso, [idUsuario]);

    // Conteo historico de sesiones exitosas del usuario
    const sqlSesionesTotales = `
      SELECT COUNT(*)::int AS total
      FROM logins
      WHERE id_usuario = $1 AND exito = TRUE
    `;
    const sesionesTotalesRes = await pool.query(sqlSesionesTotales, [idUsuario]);
    const sesionesTotales = Number(sesionesTotalesRes.rows[0]?.total || 0);

    const perfilRow = perfil.rows[0] || {};
    const fotoPerfilResolved = buildAbsolutePublicUrl(req, perfilRow.foto_perfil);
    const perfilPayload = {
      ...perfilRow,
      foto_perfil: fotoPerfilResolved || ''
    };

    return res.json({
      error: false,
      perfil: perfilPayload,
      roles: roles.rows,
      ultimo_acceso: ultimo.rows[0] || null,
      sesiones_totales: sesionesTotales
    });
  } catch (err) {
    console.error('GET /perfil error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * PUT /perfil
 * Actualiza información del perfil del usuario autenticado.
 * Recomendación: enviar solo los campos que el usuario puede editar.
 */
router.put('/perfil', async (req, res) => {
  const client = await pool.connect();
  let uploadedPhotoStoragePath = '';
  let previousStoredPhoto = '';
  let nextStoredPhoto = '';

  try {
    const user = req.user;
    const idUsuario = user?.id_usuario;

    if (!idUsuario) {
      return res.status(401).json({ error: true, message: 'No autorizado' });
    }

    // Campos permitidos (evita que te manden cosas que no deben)
    const {
      // personas
      nombre,
      apellido,
      fecha_nacimiento,
      genero,
      dni,
      rtn,

      // contacto (valores)
      telefono,
      email,
      direccion,

      // usuarios
      foto_perfil
    } = req.body || {};

    let photoUpdatePlan = null;
    if (foto_perfil !== undefined) {
      photoUpdatePlan = validatePerfilPhotoPayload(foto_perfil);
      if (!photoUpdatePlan.ok) {
        return res.status(photoUpdatePlan.status || 400).json({
          error: true,
          message: photoUpdatePlan.message
        });
      }
    }

    await client.query('BEGIN');

    // 1) Obtener ids relacionados (empleado, persona y sus referencias)
    const qIds = `
      SELECT
        u.id_usuario,
        u.id_empleado,
        u.foto_perfil,
        e.id_persona,
        p.id_telefono,
        p.id_correo,
        p.id_direccion
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      WHERE u.id_usuario = $1
      LIMIT 1
    `;
    const idsRes = await client.query(qIds, [idUsuario]);

    if (idsRes.rows.length === 0 || !idsRes.rows[0].id_persona) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Perfil no encontrado' });
    }

    const { id_persona, id_telefono, id_correo, id_direccion } = idsRes.rows[0];

    // 2) Actualizar PERSONAS (solo si vienen campos)
    const setParts = [];
    const values = [];
    let idx = 1;

    const addField = (fieldName, value) => {
      if (value !== undefined) {
        setParts.push(`${fieldName} = $${idx++}`);
        values.push(value);
      }
    };

    addField('nombre', nombre);
    addField('apellido', apellido);
    addField('fecha_nacimiento', fecha_nacimiento);
    addField('genero', genero);
    addField('dni', dni);
    addField('rtn', rtn);

    if (setParts.length > 0) {
      values.push(id_persona);
      const qPersona = `
        UPDATE personas
        SET ${setParts.join(', ')}
        WHERE id_persona = $${idx}
      `;
      await client.query(qPersona, values);
    }

    // 3) Actualizar / crear TELEFONO (si viene)
    if (telefono !== undefined) {
      if (id_telefono) {
        await client.query(
          'UPDATE telefonos SET telefono = $1 WHERE id_telefono = $2',
          [telefono, id_telefono]
        );
      } else {
        // si no existía, creamos y lo referenciamos en personas
        const telRes = await client.query(
          'INSERT INTO telefonos (telefono) VALUES ($1) RETURNING id_telefono',
          [telefono]
        );
        const newIdTel = telRes.rows[0].id_telefono;
        await client.query(
          'UPDATE personas SET id_telefono = $1 WHERE id_persona = $2',
          [newIdTel, id_persona]
        );
      }
    }

    // 4) Actualizar / crear CORREO (si viene)
    if (email !== undefined) {
      if (id_correo) {
        await client.query(
          'UPDATE correos SET direccion_correo = $1 WHERE id_correo = $2',
          [email, id_correo]
        );
      } else {
        const mailRes = await client.query(
          'INSERT INTO correos (direccion_correo) VALUES ($1) RETURNING id_correo',
          [email]
        );
        const newIdMail = mailRes.rows[0].id_correo;
        await client.query(
          'UPDATE personas SET id_correo = $1 WHERE id_persona = $2',
          [newIdMail, id_persona]
        );
      }
    }

    // 5) Actualizar / crear DIRECCION (si viene)
    if (direccion !== undefined) {
      if (id_direccion) {
        await client.query(
          'UPDATE direcciones SET direccion = $1 WHERE id_direccion = $2',
          [direccion, id_direccion]
        );
      } else {
        const dirRes = await client.query(
          'INSERT INTO direcciones (direccion) VALUES ($1) RETURNING id_direccion',
          [direccion]
        );
        const newIdDir = dirRes.rows[0].id_direccion;
        await client.query(
          'UPDATE personas SET id_direccion = $1 WHERE id_persona = $2',
          [newIdDir, id_persona]
        );
      }
    }

    // 6) Actualizar foto en USUARIOS (si viene)
    if (photoUpdatePlan) {
      previousStoredPhoto = normalizePerfilText(idsRes.rows[0].foto_perfil);
      let valueToPersist = photoUpdatePlan.value;

      if (photoUpdatePlan.kind === 'data_url') {
        const storedPhoto = await storePerfilPhotoDataUrlInSupabase(photoUpdatePlan.value);
        if (!storedPhoto.ok) {
          await client.query('ROLLBACK');
          return res.status(storedPhoto.status || 400).json({ error: true, message: storedPhoto.message });
        }

        uploadedPhotoStoragePath = storedPhoto.uploadedStoragePath || '';
        valueToPersist = storedPhoto.storedPath;
      }

      nextStoredPhoto = normalizePerfilText(valueToPersist);
      await client.query(
        'UPDATE usuarios SET foto_perfil = $1 WHERE id_usuario = $2',
        [valueToPersist, idUsuario]
      );
    }

    await client.query('COMMIT');
    uploadedPhotoStoragePath = '';
    if (photoUpdatePlan && previousStoredPhoto && previousStoredPhoto !== nextStoredPhoto) {
      await tryDeletePerfilStoredFile(previousStoredPhoto);
    }
    return res.json({ error: false, message: 'Perfil actualizado correctamente' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (uploadedPhotoStoragePath) {
      await supabase.storage.from(SUPABASE_ASSETS_BUCKET).remove([uploadedPhotoStoragePath]).catch(() => null);
    }
    if (err?.code === '22001') {
      return res.status(413).json({ error: true, message: 'URL de imagen demasiado larga. Maximo 500 caracteres.' });
    }
    console.error('PUT /perfil error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

import { validatePasswordPolicy } from '../utils/security/passwordPolicy.js';

/**
 * PUT /perfil/password
 * Cambia contraseña del usuario autenticado.
 * Body:
 * {
 *   "clave_actual": "....",
 *   "clave_nueva": "...."
 * }
 */
router.put('/perfil/password', passwordChangeLimiter, async (req, res) => {
  try {
    const idUsuario = Number.parseInt(String(req.user?.id_usuario ?? ''), 10);
    if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
      return res.status(401).json({ error: true, message: 'No autorizado' });
    }

    const claveActual = String(
      req.body?.clave_actual
      ?? req.body?.password_actual
      ?? ''
    ).trim();
    const claveNueva = String(
      req.body?.clave_nueva
      ?? req.body?.password_nueva
      ?? ''
    ).trim();

    if (!claveActual || !claveNueva) {
      return res.status(400).json({ error: true, message: 'clave_actual y clave_nueva son requeridas' });
    }

    await ensurePasswordChangedAtColumn();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const qUser = 'SELECT id_usuario, clave FROM usuarios WHERE id_usuario = $1 LIMIT 1 FOR UPDATE';
      const rUser = await client.query(qUser, [idUsuario]);

      if (rUser.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
      }

      const claveBD = String(rUser.rows[0]?.clave ?? '');
      const passwordOk = await verifyStoredPassword(claveActual, claveBD);
      if (!passwordOk) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: true, message: 'La contrasena actual no es correcta' });
      }

      const samePassword = await verifyStoredPassword(claveNueva, claveBD);
      if (samePassword) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: true, message: 'La nueva contrasena no puede ser igual a la actual' });
      }

      const policyCheck = await validatePasswordPolicy(claveNueva);
      if (!policyCheck?.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: true, message: policyCheck?.message || 'La contrasena no cumple la politica' });
      }

      const reuseResult = await client.query(
        `
          WITH ultimas AS (
            SELECT h.password_hash
            FROM usuarios_password_history h
            WHERE h.id_usuario = $1
            ORDER BY h.fecha_creacion DESC, h.id_historial DESC
            LIMIT $3
          )
          SELECT EXISTS(
            SELECT 1
            FROM ultimas
            WHERE crypt($2::text, password_hash) = password_hash
          ) AS reused
        `,
        [idUsuario, claveNueva, PASSWORD_HISTORY_KEEP]
      );

      if (Boolean(reuseResult.rows?.[0]?.reused)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: true,
          message: 'La nueva contrasena ya fue utilizada recientemente. Elige una diferente',
        });
      }

      if (claveBD) {
        await client.query(
          `
            INSERT INTO usuarios_password_history (id_usuario, password_hash)
            VALUES ($1, $2)
          `,
          [idUsuario, claveBD]
        );
      }

      await client.query(
        `
          UPDATE usuarios
          SET
            clave = crypt($1::text, gen_salt('bf')),
            must_change_password = FALSE,
            fecha_cambio_clave = timezone('America/Tegucigalpa', now())
          WHERE id_usuario = $2
        `,
        [claveNueva, idUsuario]
      );

      await client.query(
        `
          DELETE FROM usuarios_password_history
          WHERE id_historial IN (
            SELECT id_historial FROM (
              SELECT id_historial,
                     ROW_NUMBER() OVER (
                       PARTITION BY id_usuario
                       ORDER BY fecha_creacion DESC, id_historial DESC
                     ) AS rn
              FROM usuarios_password_history
              WHERE id_usuario = $1
            ) t
            WHERE t.rn > $2
          )
        `,
        [idUsuario, PASSWORD_HISTORY_KEEP]
      );

      await client.query('COMMIT');
    } catch (txError) {
      try { await client.query('ROLLBACK'); } catch {}
      throw txError;
    } finally {
      client.release();
    }

    issueUpdatedAccessToken(req, res);
    return res.json({ error: false, message: 'Contrasena actualizada correctamente' });
  } catch (err) {
    console.error('PUT /perfil/password error:', err?.message || err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

export default router;

