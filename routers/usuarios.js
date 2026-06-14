import express from 'express';
import crypto from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import jwt from 'jsonwebtoken';
import pool from '../config/db-connection.js';
import JWT_SECRET from '../config/jwt.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import { passwordChangeLimiter } from '../middleware/rateLimiter.js';
import { supabase } from '../services/supabaseClient.js';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  SUPABASE_ASSETS_BUCKET,
  UPLOADS_DIR,
  detectImageMimeTypeFromBuffer
} from '../utils/uploads.js';
import { ensurePasswordChangedAtColumn } from '../utils/security/passwordExpiration.js';
import { enviarCorreo } from '../utils/emailService.js';
import { buildAuthTokenPayload, getUserAuthzSnapshot } from '../utils/security/authTokenPayload.js';

const router = express.Router();
const USUARIOS_LIST_PERMISSIONS = ['USUARIOS_LISTADO_VER'];
const USUARIOS_CREATE_PERMISSIONS = ['USUARIOS_CREAR'];
const USUARIOS_EDIT_PERMISSIONS = ['USUARIOS_EDITAR'];
const USUARIOS_DELETE_PERMISSIONS = ['USUARIOS_ELIMINAR'];
const USUARIOS_RESET_PASSWORD_PERMISSIONS = ['USUARIOS_PASSWORD_RESETEAR'];
const USUARIOS_IMAGE_EDIT_PERMISSIONS = ['USUARIOS_IMAGEN_SUBIR', 'USUARIOS_IMAGEN_ELIMINAR'];
const USUARIOS_ROLES_CATALOG_PERMISSIONS = ['USUARIOS_ROL_ASIGNAR', 'USUARIOS_CREAR', 'USUARIOS_EDITAR'];
const USUARIOS_ROLE_ASSIGN_PERMISSIONS = ['USUARIOS_ROL_ASIGNAR'];
const USUARIOS_CHANGE_OWN_PASSWORD_PERMISSIONS = ['USUARIOS_PASSWORD_CAMBIAR_PROPIO'];
const USUARIOS_MODAL_CATALOG_PERMISSIONS = [...new Set([
  ...USUARIOS_LIST_PERMISSIONS,
  ...USUARIOS_CREATE_PERMISSIONS,
  ...USUARIOS_EDIT_PERMISSIONS,
])];
const USUARIOS_LEGACY_ROUTES_ENABLED = String(process.env.USUARIOS_LEGACY_ROUTES_ENABLED ?? 'false').trim().toLowerCase() === 'true';

const sendLegacyUsuariosRouteDisabled = (res) =>
  res.status(410).json({
    error: true,
    code: 'USUARIOS_LEGACY_DISABLED',
    message: 'Endpoint legado deshabilitado. Use /usuarios/v2/*',
  });

const usuariosV2CookieConfig = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    path: '/',
  };
};

const issueUpdatedAccessTokenForOwnPasswordChange = async (req, res, idUsuarioChanged) => {
  const idUsuarioJwt = Number.parseInt(String(req.user?.id_usuario ?? ''), 10);
  if (!Number.isInteger(idUsuarioJwt) || idUsuarioJwt <= 0) return;
  if (idUsuarioJwt !== idUsuarioChanged) return;
  if (!JWT_SECRET) return;

  let authz = { roles: [] };
  try {
    authz = await getUserAuthzSnapshot(pool, idUsuarioJwt);
  } catch (error) {
    console.error('Error resolviendo roles/permisos al refrescar token en usuarios:', error);
  }

  const payload = buildAuthTokenPayload({
    id_usuario: idUsuarioJwt,
    nombre_usuario: req.user?.nombre_usuario,
    id_sucursal: req.user?.id_sucursal,
    sid: req.user?.sid,
    must_change_password: false,
    rol: req.user?.rol,
    nombre_rol: req.user?.nombre_rol,
    roles: req.user?.roles
  }, authz);

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  const base = usuariosV2CookieConfig();
  res.cookie('access_token', token, {
    ...base,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8,
  });
};

// ------------------------------------------------------------------------------------
// GET: Obtener usuarios
// ------------------------------------------------------------------------------------
// GET: Obtener usuarios
router.get('/usuarios', checkPermission(USUARIOS_LIST_PERMISSIONS), async (req, res) => {
    if (!USUARIOS_LEGACY_ROUTES_ENABLED) {
        return sendLegacyUsuariosRouteDisabled(res);
    }
    try {
        const tabla = 'usuarios';
        
        // CORRECCIÓN AQUÍ: Cambiamos 'cod_usuario' por 'id_usuario'
        // También aseguramos que 'clave' y 'estado' estén bien escritos.
        const columnas = 'id_usuario, nombre_usuario, estado, id_empleado'; 

        // Llamamos a la función
        const query = 'SELECT function_select($1, $2) as resultado';
        const result = await pool.query(query, [tabla, columnas]);

        // Extraemos el resultado
        const datos = result.rows[0].resultado || [];
        res.status(200).json(datos);

    } catch (err) {
        console.error('Error al obtener usuarios:', err.message);
        res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
});

// ------------------------------------------------------------------------------------
// POST: Crear nuevo usuario
// ------------------------------------------------------------------------------------
router.post('/usuarios', checkPermission(USUARIOS_CREATE_PERMISSIONS), async (req, res) => {
    if (!USUARIOS_LEGACY_ROUTES_ENABLED) {
        return sendLegacyUsuariosRouteDisabled(res);
    }
    try {
        const tabla = 'usuarios';
        const datosUsuario = req.body; 
        
/* IMPORTANTE: 
Desde Postman debes enviar el JSON con las llaves correctas:
{
"nombre_usuario": "Juan",
"clave": "12345",
"estado": true,
"id_empleado": 1
}
*/

        const query = 'CALL pa_insert($1, $2)';
        await pool.query(query, [tabla, datosUsuario]);

        res.status(201).json({ message: 'Usuario creado exitosamente.' });

    } catch (err) {
        console.error('Error al crear usuario:', err.message);
        res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
});

const USUARIOS_LEGACY_ALLOWED_UPDATE_FIELDS = new Set([
  'nombre_usuario',
  'estado',
  'id_empleado',
  'id_cliente',
  'tipo_usuario',
  'foto_perfil'
]);
const USUARIOS_LEGACY_ALLOWED_ID_FIELDS = new Set(['id_usuario']);

// ------------------------------------------------------------------------------------
// PUT: Actualizar usuario
// ------------------------------------------------------------------------------------
router.put('/usuarios', checkPermission(USUARIOS_EDIT_PERMISSIONS), async (req, res) => {
    if (!USUARIOS_LEGACY_ROUTES_ENABLED) {
        return sendLegacyUsuariosRouteDisabled(res);
    }
    try {
        const { campo, valor, id_campo, id_valor } = req.body;

        if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
            return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
        }

        const safeCampo = String(campo).trim().toLowerCase();
        const safeIdCampo = String(id_campo).trim().toLowerCase();
        if (!USUARIOS_LEGACY_ALLOWED_UPDATE_FIELDS.has(safeCampo)) {
            return res.status(400).json({ error: true, message: `Campo no permitido: ${campo}` });
        }
        if (!USUARIOS_LEGACY_ALLOWED_ID_FIELDS.has(safeIdCampo)) {
            return res.status(400).json({ error: true, message: `Identificador no permitido: ${id_campo}` });
        }

        const tabla = 'usuarios';
        
/* EN POSTMAN, para actualizar el nombre del usuario 1, enviarías:
{
"campo": "nombre_usuario",
"valor": "NuevoNombre",
"id_campo": "id_usuario",   <-- OJO AQUÍ: id_usuario
"id_valor": 1 
}
*/

        const strNuevoDato = String(valor);
        const strValorCondicion = String(id_valor);

        const query = 'CALL pa_update($1, $2, $3, $4, $5)';
        await pool.query(query, [tabla, safeCampo, strNuevoDato, safeIdCampo, strValorCondicion]);

        res.status(200).json({ message: 'Usuario actualizado correctamente.' });

    } catch (err) {
        console.error('Error al actualizar:', err.message);
        res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
});

// ------------------------------------------------------------------------------------
// DELETE: Eliminar usuario
// ------------------------------------------------------------------------------------
router.delete('/usuarios', checkPermission(USUARIOS_DELETE_PERMISSIONS), async (req, res) => {
    if (!USUARIOS_LEGACY_ROUTES_ENABLED) {
        return sendLegacyUsuariosRouteDisabled(res);
    }
    try {
        const { columna_id, valor_id } = req.body;
        // En Postman enviarías: { "columna_id": "id_usuario", "valor_id": 1 }

        if (!columna_id || !valor_id) {
            return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
        }

        const safeColumnaId = String(columna_id).trim().toLowerCase();
        if (!USUARIOS_LEGACY_ALLOWED_ID_FIELDS.has(safeColumnaId)) {
            return res.status(400).json({ error: true, message: `Identificador no permitido: ${columna_id}` });
        }

        const tabla = 'usuarios';
        const strValorId = String(valor_id);

        const query = 'CALL pa_delete($1, $2, $3)';
        await pool.query(query, [tabla, safeColumnaId, strValorId]);

        res.status(200).json({ message: 'Usuario eliminado.' });

    } catch (err) {
        console.error('Error al eliminar:', err.message);
        res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
});
export default router;
// ====================================================================================
// V2: Submodulo de usuarios (CRUD + credenciales temporales)
// NOTA: se agrega al final para no alterar endpoints existentes.
// ====================================================================================

const USUARIOS_V2_MAX_LIMIT = 100;
const USUARIOS_V2_FOTO_PERFIL_MAX_LENGTH = 500;
const USUARIOS_V2_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const USUARIOS_V2_UPLOADS_SUBDIR = 'usuarios';
const USUARIOS_V2_UPLOADS_PREFIX = '/uploads/usuarios/';
const USUARIOS_V2_SUPABASE_SUBDIR = 'usuarios';
const USUARIOS_V2_BASE64_BODY_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const USUARIOS_V2_DATA_URL_PARSE_RE = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i;
const USUARIOS_V2_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const USUARIOS_V2_BCRYPT_PREFIX_RE = /^\$2[abxy]?\$/i;
const USUARIOS_V2_IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;
const USUARIOS_V2_IMAGE_URL_RE = /^(https?:\/\/|\/uploads\/)/i;
const USUARIOS_V2_CREATE_PASSWORD_MIN = 10;
// Transicion controlada:
// - Login soporta claves legacy en texto plano y hashes bcrypt.
// - Nuevas claves se almacenan en bcrypt para mejorar seguridad gradualmente.
const USUARIOS_V2_LOGIN_EXPECTS_PLAIN_PASSWORD = false;

let usuariosV2CapabilitiesPromise = null;

const v2ParsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const v2ParseBoolean = (value) => {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return Boolean(value);
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'si', 'activo', 'activa'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'inactivo', 'inactiva'].includes(normalized)) return false;
  return null;
};

const v2NormalizeText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const v2NormalizeEmail = (value) => v2NormalizeText(value).toLowerCase();
const V2_SAFE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const v2IsSafeEmail = (value) => V2_SAFE_EMAIL_RE.test(v2NormalizeEmail(value));

const v2ValidateCreatePassword = (plainPassword) => {
  const value = String(plainPassword ?? '');
  if (!value) {
    return { ok: false, message: 'Contrasena requerida' };
  }
  if (value.length < USUARIOS_V2_CREATE_PASSWORD_MIN) {
    return { ok: false, message: 'La contrasena debe tener minimo 10 caracteres' };
  }
  if (!/[A-Z]/.test(value)) {
    return { ok: false, message: 'La contrasena debe incluir al menos una mayuscula (A-Z)' };
  }
  if (!/[0-9]/.test(value)) {
    return { ok: false, message: 'La contrasena debe incluir al menos un numero (0-9)' };
  }
  return { ok: true, message: '' };
};

const v2ToUpperNoAccents = (value) =>
  v2NormalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

const v2SanitizeUsernameToken = (value) => v2ToUpperNoAccents(value).replace(/[^A-Z0-9]/g, '');

const v2SplitWords = (value) =>
  v2NormalizeText(value)
    .split(/\s+/)
    .map((part) => v2SanitizeUsernameToken(part))
    .filter(Boolean);

const v2EstimateDataUrlBytes = (dataUrl) => {
  const safe = v2NormalizeText(dataUrl);
  const commaIndex = safe.indexOf(',');
  if (commaIndex < 0) return 0;

  const base64 = safe.slice(commaIndex + 1);
  const paddingMatch = base64.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

const v2ParseDataImagePayload = (dataUrl) => {
  const value = v2NormalizeText(dataUrl);
  const match = value.match(USUARIOS_V2_DATA_URL_PARSE_RE);
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

const v2DecodeBase64Image = (base64Body) => {
  const normalized = String(base64Body || '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !USUARIOS_V2_BASE64_BODY_REGEX.test(normalized)) {
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

  if (buffer.length > USUARIOS_V2_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: 'La imagen supera el limite de 20 MB.',
    };
  }

  return { ok: true, buffer };
};

const v2EnsureUsuariosUploadsDir = async () => {
  await fs.mkdir(path.join(UPLOADS_DIR, USUARIOS_V2_UPLOADS_SUBDIR), { recursive: true });
};

const v2BuildUsuariosStoredPath = (fileName) => `${USUARIOS_V2_UPLOADS_PREFIX}${fileName}`;
const v2BuildUsuariosSupabaseStoragePath = (fileName) => `${USUARIOS_V2_SUPABASE_SUBDIR}/${fileName}`;
const v2BuildUsuariosSupabaseDbPath = (storagePath) => `${SUPABASE_ASSETS_BUCKET}/${storagePath}`;
const v2ResolvePublicImageUrl = (rawValue) => {
  const normalized = v2NormalizeText(rawValue);
  if (!normalized) return '';
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (normalized.startsWith(`${SUPABASE_ASSETS_BUCKET}/`)) {
    const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    if (supabaseUrl) {
      return `${supabaseUrl}/storage/v1/object/public/${normalized}`;
    }
  }
  return normalized;
};

const v2StorePhotoDataUrlAsFile = async (dataUrl) => {
  const parsed = v2ParseDataImagePayload(dataUrl);
  if (!parsed.ok) return parsed;

  const decoded = v2DecodeBase64Image(parsed.base64Body);
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
  const fileName = `usuario-${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const fileAbsolutePath = path.join(UPLOADS_DIR, USUARIOS_V2_UPLOADS_SUBDIR, fileName);
  const storedPath = v2BuildUsuariosStoredPath(fileName);

  await v2EnsureUsuariosUploadsDir();
  await fs.writeFile(fileAbsolutePath, decoded.buffer, { flag: 'wx' });

  return {
    ok: true,
    storedPath,
    writtenFileAbsolutePath: fileAbsolutePath,
  };
};

const v2ParseUsuariosStoredStoragePath = (rawValue) => {
  const input = v2NormalizeText(rawValue);
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

const v2StorePhotoDataUrlInSupabase = async (dataUrl) => {
  const parsed = v2ParseDataImagePayload(dataUrl);
  if (!parsed.ok) return parsed;

  const decoded = v2DecodeBase64Image(parsed.base64Body);
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
  const fileName = `usuario-${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const storagePath = v2BuildUsuariosSupabaseStoragePath(fileName);
  const storedPath = v2BuildUsuariosSupabaseDbPath(storagePath);

  const { error: uploadError } = await supabase.storage
    .from(SUPABASE_ASSETS_BUCKET)
    .upload(storagePath, decoded.buffer, {
      contentType: effectiveMimeType,
      cacheControl: '3600',
      upsert: false
    });

  if (uploadError) {
    console.error('PUT /usuarios/v2/photo storage upload error:', uploadError);
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

const v2TryDeleteUsuariosStoredFile = async (storedPath) => {
  const safe = v2NormalizeText(storedPath);
  if (!safe) return;

  const storagePath = v2ParseUsuariosStoredStoragePath(safe);
  if (
    storagePath &&
    storagePath.bucket === SUPABASE_ASSETS_BUCKET &&
    storagePath.filePath.startsWith(`${USUARIOS_V2_SUPABASE_SUBDIR}/`)
  ) {
    await supabase.storage.from(storagePath.bucket).remove([storagePath.filePath]).catch(() => null);
    return;
  }

  if (!safe.startsWith(USUARIOS_V2_UPLOADS_PREFIX)) return;

  const fileName = safe.slice(USUARIOS_V2_UPLOADS_PREFIX.length).trim();
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) return;

  const absolutePath = path.join(UPLOADS_DIR, USUARIOS_V2_UPLOADS_SUBDIR, fileName);
  await fs.unlink(absolutePath).catch(() => null);
};

const v2ValidatePhotoPayload = (fotoPerfil) => {
  if (fotoPerfil === null || fotoPerfil === undefined || v2NormalizeText(fotoPerfil) === '') {
    return { ok: true, value: '', kind: 'empty' };
  }

  const value = v2NormalizeText(fotoPerfil);
  const isDataImage = USUARIOS_V2_IMAGE_DATA_URL_RE.test(value);
  const isShortUrl = USUARIOS_V2_IMAGE_URL_RE.test(value);

  if (isDataImage) {
    const estimatedBytes = v2EstimateDataUrlBytes(value);
    if (estimatedBytes <= 0) {
      return {
        ok: false,
        status: 400,
        message: 'Formato de foto no valido. Use una URL (http/https o /uploads/...) o una imagen mas ligera.',
      };
    }

    if (estimatedBytes > USUARIOS_V2_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        message: 'La imagen supera el limite de 20 MB.',
      };
    }

    return { ok: true, value, kind: 'data_url' };
  }

  if (value.length > USUARIOS_V2_FOTO_PERFIL_MAX_LENGTH) {
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

const v2IsBcryptHash = (value) => USUARIOS_V2_BCRYPT_PREFIX_RE.test(v2NormalizeText(value));

const v2HashPasswordBcrypt = async (plainPassword, queryRunner = pool) => {
  const safePassword = String(plainPassword ?? '');
  if (!safePassword) throw new Error('La contrasena temporal no puede estar vacia');

  const result = await queryRunner.query(
    'SELECT crypt($1::text, gen_salt(\'bf\')) AS hash',
    [safePassword]
  );

  const hash = result.rows?.[0]?.hash;
  if (!hash) throw new Error('No se pudo generar el hash de la contrasena');
  return String(hash);
};

const v2VerifyPassword = async (plainPassword, storedPassword, queryRunner = pool) => {
  const plain = String(plainPassword ?? '');
  const stored = String(storedPassword ?? '');

  if (!plain || !stored) return false;
  if (plain === stored) return true;
  if (!v2IsBcryptHash(stored)) return false;

  const result = await queryRunner.query(
    'SELECT crypt($1::text, $2::text) = $2::text AS ok',
    [plain, stored]
  );

  return Boolean(result.rows?.[0]?.ok);
};

const v2BuildPasswordForStorage = async (plainPassword, queryRunner = pool) => {
  const safePassword = String(plainPassword ?? '');
  if (!safePassword) throw new Error('La contrasena no puede estar vacia');

  if (USUARIOS_V2_LOGIN_EXPECTS_PLAIN_PASSWORD) {
    // Fallback conservador para entornos legacy.
    return safePassword;
  }

  return v2HashPasswordBcrypt(safePassword, queryRunner);
};

const v2GenerateTemporaryPassword = async () => {
  const { randomInt } = await import('node:crypto');
  const length = randomInt(10, 13);

  let output = '';
  for (let i = 0; i < length; i += 1) {
    const idx = randomInt(0, USUARIOS_V2_PASSWORD_ALPHABET.length);
    output += USUARIOS_V2_PASSWORD_ALPHABET[idx];
  }

  return output;
};

const v2GetCapabilities = async () => {
  if (!usuariosV2CapabilitiesPromise) {
    usuariosV2CapabilitiesPromise = (async () => {
      const columnsResult = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'usuarios'
      `);
      const clientesColumnsResult = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'clientes'
      `);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const clientesColumns = new Set(clientesColumnsResult.rows.map((row) => row.column_name));
      const mustChangeFieldCandidates = [
        'must_change_password',
        'debe_cambiar_clave',
        'requiere_cambio_clave',
        'force_password_change',
        'password_temporal',
      ];

      const mustChangePasswordField =
        mustChangeFieldCandidates.find((field) => columns.has(field)) || null;

      return {
        columns,
        hasEstado: columns.has('estado'),
        hasFotoPerfil: columns.has('foto_perfil'),
        hasFechaCreacion: columns.has('fecha_creacion'),
        mustChangePasswordField,
        hasClienteEmpresaField: clientesColumns.has('id_empresa_cliente'),
      };
    })().catch((error) => {
      usuariosV2CapabilitiesPromise = null;
      throw error;
    });
  }

  return usuariosV2CapabilitiesPromise;
};

const v2MapUsuarioRow = (row) => {
  if (!row) return null;

  const resolvedNombreCompleto = v2NormalizeText(
    row.nombre_completo
      || row.nombre_completo_empleado
      || row.nombre_completo_cliente
  ) || v2NormalizeText(row.nombre_usuario) || `Usuario ${row.id_usuario ?? ''}`.trim();

  const empleado = {
    id_empleado: row.id_empleado ?? null,
    nombre_completo: v2NormalizeText(row.nombre_completo_empleado),
    dni: row.dni_empleado ?? null,
    telefono: row.telefono_empleado ?? null,
    correo: row.correo_empleado ?? null,
    sucursal: row.sucursal_nombre ?? null,
    sucursal_nombre: row.sucursal_nombre ?? null,
  };

  const cliente = {
    id_cliente: row.id_cliente ?? null,
    nombre_completo: v2NormalizeText(row.nombre_completo_cliente) || v2NormalizeText(row.nombre_empresa_cliente),
    dni: row.dni_cliente ?? null,
    telefono: row.telefono_cliente ?? null,
    correo: row.correo_cliente ?? null,
  };

  const rawRoles = Array.isArray(row.roles) ? row.roles : [];
  const roles = rawRoles
    .map((role) => ({
      id_rol: Number(role?.id_rol),
      nombre: v2NormalizeText(role?.nombre) || null,
    }))
    .filter((role) => Number.isInteger(role.id_rol) && role.id_rol > 0 && role.nombre);

  const rolId = row.id_rol ?? row.rol_id ?? null;
  const rolNombre = row.rol_nombre ?? row.nombre_rol ?? row.nombre_rol_usuario ?? null;
  const rol = roles[0] || (rolId
    ? {
      id_rol: Number(rolId),
      nombre: v2NormalizeText(rolNombre) || null,
    }
    : null);

  return {
    id_usuario: row.id_usuario,
    nombre_usuario: row.nombre_usuario,
    estado: row.estado,
    foto_perfil: v2ResolvePublicImageUrl(row.foto_perfil),
    fecha_creacion: row.fecha_creacion ?? null,
    tipo_usuario: row.tipo_usuario ?? null,
    id_empleado: row.id_empleado ?? null,
    id_cliente: row.id_cliente ?? null,
    nombre_completo: resolvedNombreCompleto,
    dni: empleado.dni || cliente.dni || null,
    telefono: empleado.telefono || cliente.telefono || null,
    correo: empleado.correo || cliente.correo || null,
    sucursal_nombre: row.id_cliente ? null : empleado.sucursal_nombre,
    roles,
    rol,
    empleado,
    cliente,
  };
};

const v2FetchUsuarioById = async (idUsuario, queryRunner = pool) => {
  const query = `
    SELECT
      u.id_usuario,
      u.nombre_usuario,
      u.estado,
      u.foto_perfil,
      u.fecha_creacion,
      u.tipo_usuario,
      e.id_empleado,
      cl.id_cliente,
      TRIM(CONCAT(COALESCE(pe.nombre, ''), ' ', COALESCE(pe.apellido, ''))) AS nombre_completo_empleado,
      COALESCE(
        NULLIF(TRIM(CONCAT(COALESCE(pc.nombre, ''), ' ', COALESCE(pc.apellido, ''))), ''),
        NULLIF(TRIM(COALESCE(ec.nombre_empresa, '')), '')
      ) AS nombre_completo_cliente,
      ec.nombre_empresa AS nombre_empresa_cliente,
      COALESCE(
        NULLIF(TRIM(CONCAT(COALESCE(pe.nombre, ''), ' ', COALESCE(pe.apellido, ''))), ''),
        NULLIF(TRIM(CONCAT(COALESCE(pc.nombre, ''), ' ', COALESCE(pc.apellido, ''))), ''),
        NULLIF(TRIM(COALESCE(ec.nombre_empresa, '')), ''),
        NULLIF(TRIM(COALESCE(u.nombre_usuario, '')), '')
      ) AS nombre_completo,
      pe.dni AS dni_empleado,
      pc.dni AS dni_cliente,
      te.telefono AS telefono_empleado,
      tc.telefono AS telefono_cliente,
      ce.direccion_correo AS correo_empleado,
      cc.direccion_correo AS correo_cliente,
      s.nombre_sucursal AS sucursal_nombre,
      roles_info.id_rol,
      roles_info.rol_nombre,
      roles_info.roles
    FROM usuarios u
    LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
    LEFT JOIN personas pe ON pe.id_persona = e.id_persona
    LEFT JOIN telefonos te ON te.id_telefono = pe.id_telefono
    LEFT JOIN correos ce ON ce.id_correo = pe.id_correo
    LEFT JOIN clientes cl ON cl.id_cliente = u.id_cliente
    LEFT JOIN personas pc ON pc.id_persona = cl.id_persona
    LEFT JOIN empresas ec ON ec.id_empresa = cl.id_empresa
    LEFT JOIN telefonos tc ON tc.id_telefono = pc.id_telefono
    LEFT JOIN correos cc ON cc.id_correo = pc.id_correo
    LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
    LEFT JOIN LATERAL (
      SELECT
        MIN(r2.id_rol) AS id_rol,
        (ARRAY_AGG(r2.nombre ORDER BY r2.id_rol ASC))[1] AS rol_nombre,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT('id_rol', r2.id_rol, 'nombre', r2.nombre)
            ORDER BY r2.id_rol ASC
          ),
          '[]'::json
        ) AS roles
      FROM roles_usuarios ru2
      INNER JOIN roles r2 ON r2.id_rol = ru2.id_rol
      WHERE ru2.id_usuario = u.id_usuario
    ) roles_info ON TRUE
    WHERE u.id_usuario = $1
    LIMIT 1
  `;

  const result = await queryRunner.query(query, [idUsuario]);
  return v2MapUsuarioRow(result.rows[0] || null);
};

const v2ResolveUsuarioEmail = async (idUsuario, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT
        COALESCE(
          NULLIF(TRIM(ce_link.direccion_correo), ''),
          NULLIF(TRIM(ce_persona.direccion_correo), ''),
          NULLIF(TRIM(cc_link.direccion_correo), ''),
          NULLIF(TRIM(cc_persona.direccion_correo), '')
        ) AS correo
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas pe ON pe.id_persona = e.id_persona
      LEFT JOIN correos ce_link ON ce_link.id_correo = pe.id_correo
      LEFT JOIN correos ce_persona ON (pe.id_correo IS NULL AND ce_persona.id_persona = pe.id_persona)
      LEFT JOIN clientes cl ON cl.id_cliente = u.id_cliente
      LEFT JOIN personas pc ON pc.id_persona = cl.id_persona
      LEFT JOIN correos cc_link ON cc_link.id_correo = pc.id_correo
      LEFT JOIN correos cc_persona ON (pc.id_correo IS NULL AND cc_persona.id_persona = pc.id_persona)
      WHERE u.id_usuario = $1
      LIMIT 1
    `,
    [idUsuario]
  );

  return v2NormalizeEmail(result.rows?.[0]?.correo);
};

const v2BuildTemporaryPasswordEmailHtml = ({
  displayName,
  username,
  temporaryPassword,
  mode = 'create',
}) => {
  const safeName = v2NormalizeText(displayName) || 'usuario';
  const safeUsername = v2NormalizeText(username) || 'N/D';
  const safePassword = v2NormalizeText(temporaryPassword) || 'N/D';
  const modeLabel = mode === 'reset'
    ? 'Hemos generado una nueva contrasena temporal para tu cuenta.'
    : 'Tu cuenta fue creada y se genero una contrasena temporal.';

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
          Hola ${safeName},<br/>${modeLabel}
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

const v2SendTemporaryPasswordEmail = async ({
  idUsuario,
  username,
  displayName,
  temporaryPassword,
  mode = 'create',
  queryRunner = pool,
}) => {
  const id = v2ParsePositiveInt(idUsuario);
  if (!id) {
    return { sent: false, skipped: true, reason: 'INVALID_USER_ID', to: null };
  }

  const targetEmail = await v2ResolveUsuarioEmail(id, queryRunner);
  if (!v2IsSafeEmail(targetEmail)) {
    return { sent: false, skipped: true, reason: 'EMAIL_NOT_AVAILABLE', to: null };
  }

  const subject = mode === 'reset'
    ? 'Nueva contrasena temporal - Jonnys SmartOrder'
    : 'Credenciales temporales - Jonnys SmartOrder';
  const html = v2BuildTemporaryPasswordEmailHtml({
    displayName,
    username,
    temporaryPassword,
    mode,
  });

  try {
    await enviarCorreo(targetEmail, subject, html, {
      id_usuario: id,
      tipo_correo: mode === 'reset' ? 'credenciales_temporales_reset' : 'credenciales_temporales_creacion',
      fromKey: 'ACCESO',
    });
    return { sent: true, skipped: false, to: targetEmail };
  } catch (error) {
    console.error('[usuarios/v2] Error enviando contrasena temporal por correo:', error?.message || error);
    return { sent: false, skipped: false, reason: 'SMTP_SEND_FAILED', to: targetEmail };
  }
};

const v2UsernameExists = async (nombreUsuario, { excludeId = null, queryRunner = pool } = {}) => {
  const safeUsername = v2NormalizeText(nombreUsuario);
  if (!safeUsername) return false;

  if (excludeId) {
    const result = await queryRunner.query(
      'SELECT 1 FROM usuarios WHERE UPPER(nombre_usuario) = UPPER($1) AND id_usuario <> $2 LIMIT 1',
      [safeUsername, excludeId]
    );
    return result.rows.length > 0;
  }

  const result = await queryRunner.query(
    'SELECT 1 FROM usuarios WHERE UPPER(nombre_usuario) = UPPER($1) LIMIT 1',
    [safeUsername]
  );

  return result.rows.length > 0;
};

const v2BuildUniqueUsername = async ({ nombre, apellido, idEmpleado, queryRunner = pool }) => {
  const nombres = v2SplitWords(nombre);
  const apellidos = v2SplitWords(apellido);

  const primerNombre = nombres[0] || '';
  const segundoNombre = nombres[1] || '';
  const primerApellido = apellidos[0] || '';

  const base1 = `${primerNombre.slice(0, 1)}${primerApellido}` || `USR${idEmpleado}`;
  const base2 = segundoNombre ? `${primerNombre.slice(0, 1)}${segundoNombre.slice(0, 1)}${primerApellido}` : base1;

  const candidate1 = v2SanitizeUsernameToken(base1) || `USR${idEmpleado}`;
  const candidate2 = v2SanitizeUsernameToken(base2) || candidate1;

  if (!(await v2UsernameExists(candidate1, { queryRunner }))) {
    return candidate1;
  }

  if (candidate2 !== candidate1 && !(await v2UsernameExists(candidate2, { queryRunner }))) {
    return candidate2;
  }

  const baseForSuffix = candidate2 || candidate1;
  let suffix = 2;
  while (suffix <= 9999) {
    const candidate = `${baseForSuffix}${suffix}`;
    if (!(await v2UsernameExists(candidate, { queryRunner }))) {
      return candidate;
    }
    suffix += 1;
  }

  throw new Error('No se pudo generar un nombre de usuario unico');
};

const v2FindEmployeeForUser = async (idEmpleado, queryRunner = pool) => {
  const query = `
    SELECT
      e.id_empleado,
      p.nombre,
      p.apellido,
      p.dni,
      t.telefono,
      c.direccion_correo AS correo,
      s.nombre_sucursal AS sucursal_nombre
    FROM empleados e
    LEFT JOIN personas p ON p.id_persona = e.id_persona
    LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
    LEFT JOIN correos c ON c.id_correo = p.id_correo
    LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
    WHERE e.id_empleado = $1
    LIMIT 1
  `;

  const result = await queryRunner.query(query, [idEmpleado]);
  return result.rows[0] || null;
};

const v2FindClienteForUser = async (idCliente, queryRunner = pool) => {
  const query = `
    SELECT
      c.id_cliente,
      p.nombre,
      p.apellido,
      p.dni,
      t.telefono,
      co.direccion_correo AS correo
    FROM clientes c
    LEFT JOIN personas p ON p.id_persona = c.id_persona
    LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
    LEFT JOIN correos co ON co.id_correo = p.id_correo
    WHERE c.id_cliente = $1
    LIMIT 1
  `;

  const result = await queryRunner.query(query, [idCliente]);
  return result.rows[0] || null;
};

const v2FindRoleById = async (idRol, queryRunner = pool) => {
  const result = await queryRunner.query(
    'SELECT id_rol, nombre FROM roles WHERE id_rol = $1 LIMIT 1',
    [idRol]
  );
  return result.rows[0] || null;
};

const v2FindClienteRoleId = async (queryRunner = pool) => {
  const result = await queryRunner.query(
    `SELECT id_rol FROM roles WHERE UPPER(TRIM(nombre)) = 'CLIENTE' LIMIT 1`
  );
  return Number.isInteger(result.rows?.[0]?.id_rol) ? result.rows[0].id_rol : null;
};

const v2NormalizeUsuarioTarget = (payload = {}) => {
  const raw = String(
    payload?.tipo_objetivo
    ?? payload?.tipo_usuario_objetivo
    ?? payload?.tipo
    ?? 'EMPLEADO'
  ).trim().toUpperCase();

  if (!raw || raw === 'EMPLEADO') return 'EMPLEADO';
  if (raw === 'CLIENTE') return 'CLIENTE';
  return null;
};

const v2NormalizeRoleIdsInput = (payload = {}) => {
  const hasRolesArray = Object.prototype.hasOwnProperty.call(payload || {}, 'id_roles');
  const hasSingleRole = Object.prototype.hasOwnProperty.call(payload || {}, 'id_rol');

  if (!hasRolesArray && !hasSingleRole) {
    return { hasSelection: false, roleIds: [], invalid: false };
  }

  const rawValues = hasRolesArray
    ? payload.id_roles
    : [payload.id_rol];

  if (!Array.isArray(rawValues)) {
    return { hasSelection: true, roleIds: [], invalid: true };
  }

  const parsedRoleIds = rawValues.map((value) => v2ParsePositiveInt(value));
  if (parsedRoleIds.some((value) => !value)) {
    return { hasSelection: true, roleIds: [], invalid: true };
  }

  return {
    hasSelection: true,
    roleIds: [...new Set(parsedRoleIds)],
    invalid: false,
  };
};

const v2FindRolesByIds = async (roleIds, queryRunner = pool) => {
  const uniqueRoleIds = [...new Set(
    (Array.isArray(roleIds) ? roleIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];

  if (!uniqueRoleIds.length) return [];

  const result = await queryRunner.query(
    'SELECT id_rol, nombre FROM roles WHERE id_rol = ANY($1::int[]) ORDER BY id_rol ASC',
    [uniqueRoleIds]
  );

  return result.rows;
};

const v2ReplaceUserRoles = async (idUsuario, roleIds, queryRunner = pool) => {
  await queryRunner.query('DELETE FROM roles_usuarios WHERE id_usuario = $1', [idUsuario]);

  if (!Array.isArray(roleIds) || roleIds.length === 0) return;

  await queryRunner.query(
    `
      INSERT INTO roles_usuarios (id_usuario, id_rol)
      SELECT $1, selected_roles.id_rol
      FROM UNNEST($2::int[]) AS selected_roles(id_rol)
    `,
    [idUsuario, roleIds]
  );
};

const USUARIOS_V2_SORT_SQL = Object.freeze({
  recientes: 'u.id_usuario DESC',
  nombre_asc: 'LOWER(COALESCE(NULLIF(TRIM(CONCAT(COALESCE(pe.nombre, \'\'), \' \', COALESCE(pe.apellido, \'\'))), \'\'), NULLIF(TRIM(CONCAT(COALESCE(pc.nombre, \'\'), \' \', COALESCE(pc.apellido, \'\'))), \'\'), NULLIF(TRIM(COALESCE(ec.nombre_empresa, \'\')), \'\'), NULLIF(TRIM(COALESCE(u.nombre_usuario, \'\')), \'\'))) ASC, u.id_usuario DESC',
  nombre_desc: 'LOWER(COALESCE(NULLIF(TRIM(CONCAT(COALESCE(pe.nombre, \'\'), \' \', COALESCE(pe.apellido, \'\'))), \'\'), NULLIF(TRIM(CONCAT(COALESCE(pc.nombre, \'\'), \' \', COALESCE(pc.apellido, \'\'))), \'\'), NULLIF(TRIM(COALESCE(ec.nombre_empresa, \'\')), \'\'), NULLIF(TRIM(COALESCE(u.nombre_usuario, \'\')), \'\'))) DESC, u.id_usuario DESC',
});

const v2NormalizeUsuariosSort = (value) => {
  const normalized = v2NormalizeText(value).toLowerCase();
  if (!normalized) return 'recientes';
  return Object.prototype.hasOwnProperty.call(USUARIOS_V2_SORT_SQL, normalized)
    ? normalized
    : 'recientes';
};

const v2BuildCatalogResponse = (rows, { page, limit } = {}) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  const total = Number(safeRows?.[0]?.__total__) || 0;
  const items = safeRows.map(({ __total__, ...row }) => row);
  const safeLimit = Number(limit) || items.length || 1;
  const safePage = Number(page) || 1;
  return {
    error: false,
    items,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
};

const v2FindEmployeeCatalogRows = async ({ q = '', page = 1, limit = 20, queryRunner = pool } = {}) => {
  const params = [];
  const filters = [];
  const normalizedSearch = v2NormalizeText(q);

  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    filters.push(`(
      COALESCE(p.nombre, '') ILIKE $${params.length}
      OR COALESCE(p.apellido, '') ILIKE $${params.length}
      OR COALESCE(p.dni::text, '') ILIKE $${params.length}
      OR COALESCE(t.telefono, '') ILIKE $${params.length}
      OR COALESCE(c.direccion_correo, '') ILIKE $${params.length}
      OR COALESCE(s.nombre_sucursal, '') ILIKE $${params.length}
      OR TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) ILIKE $${params.length}
    )`);
  }

  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  const rows = await queryRunner.query(
    `
      SELECT
        e.id_empleado AS id,
        p.nombre,
        p.apellido,
        TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS nombre_completo,
        p.dni,
        t.telefono,
        c.direccion_correo AS correo,
        s.nombre_sucursal AS sucursal_nombre,
        EXISTS(
          SELECT 1
          FROM usuarios u_link
          WHERE u_link.id_empleado = e.id_empleado
        ) AS has_usuario,
        COUNT(*) OVER()::INT AS __total__
      FROM empleados e
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
      ${whereSql}
      ORDER BY has_usuario ASC, LOWER(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, '')))) ASC, e.id_empleado DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `,
    [...params, limit, offset]
  );

  return rows.rows;
};

const v2FindClienteCatalogRows = async ({ q = '', page = 1, limit = 20, queryRunner = pool } = {}) => {
  const capabilities = await v2GetCapabilities();
  const params = [];
  const filters = [];
  const normalizedSearch = v2NormalizeText(q);
  const empresaJoinExpr = capabilities.hasClienteEmpresaField
    ? 'COALESCE(cl.id_empresa_cliente, cl.id_empresa)'
    : 'cl.id_empresa';

  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    filters.push(`(
      COALESCE(p.nombre, '') ILIKE $${params.length}
      OR COALESCE(p.apellido, '') ILIKE $${params.length}
      OR COALESCE(p.dni::text, '') ILIKE $${params.length}
      OR COALESCE(t.telefono, '') ILIKE $${params.length}
      OR COALESCE(cor.direccion_correo, '') ILIKE $${params.length}
      OR COALESCE(emp.nombre_empresa, '') ILIKE $${params.length}
      OR COALESCE(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '') ILIKE $${params.length}
    )`);
  }

  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  const rows = await queryRunner.query(
    `
      SELECT
        cl.id_cliente AS id,
        p.nombre,
        p.apellido,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''),
          NULLIF(TRIM(COALESCE(emp.nombre_empresa, '')), '')
        ) AS nombre_completo,
        p.dni,
        t.telefono,
        cor.direccion_correo AS correo,
        emp.nombre_empresa,
        EXISTS(
          SELECT 1
          FROM usuarios u_link
          WHERE u_link.id_cliente = cl.id_cliente
        ) AS has_usuario,
        COUNT(*) OVER()::INT AS __total__
      FROM clientes cl
      LEFT JOIN personas p ON p.id_persona = cl.id_persona
      LEFT JOIN empresas emp ON emp.id_empresa = ${empresaJoinExpr}
      LEFT JOIN telefonos t ON t.id_telefono = COALESCE(p.id_telefono, emp.id_telefono)
      LEFT JOIN correos cor ON cor.id_correo = COALESCE(p.id_correo, emp.id_correo)
      ${whereSql}
      ORDER BY has_usuario ASC, LOWER(COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''), NULLIF(TRIM(COALESCE(emp.nombre_empresa, '')), ''))) ASC, cl.id_cliente DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `,
    [...params, limit, offset]
  );

  return rows.rows;
};

router.get('/usuarios/v2/roles', checkPermission(USUARIOS_ROLES_CATALOG_PERMISSIONS), async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id_rol, nombre FROM roles ORDER BY id_rol ASC'
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error en /usuarios/v2/roles:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.get('/usuarios/v2/catalogos/empleados', checkPermission(USUARIOS_MODAL_CATALOG_PERMISSIONS), async (req, res) => {
  try {
    const page = req.query.page === undefined ? 1 : v2ParsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 20 : v2ParsePositiveInt(req.query.limit);
    if (!page || !requestedLimit) {
      return res.status(400).json({ error: true, message: 'page y limit deben ser enteros positivos' });
    }

    const limit = Math.min(requestedLimit, 50);
    const q = v2NormalizeText(req.query.q ?? req.query.search ?? req.query.nombre);
    const rows = await v2FindEmployeeCatalogRows({ q, page, limit });
    return res.status(200).json(v2BuildCatalogResponse(rows, { page, limit }));
  } catch (err) {
    console.error('Error en /usuarios/v2/catalogos/empleados:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.get('/usuarios/v2/catalogos/clientes', checkPermission(USUARIOS_MODAL_CATALOG_PERMISSIONS), async (req, res) => {
  try {
    const page = req.query.page === undefined ? 1 : v2ParsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 20 : v2ParsePositiveInt(req.query.limit);
    if (!page || !requestedLimit) {
      return res.status(400).json({ error: true, message: 'page y limit deben ser enteros positivos' });
    }

    const limit = Math.min(requestedLimit, 50);
    const q = v2NormalizeText(req.query.q ?? req.query.search ?? req.query.nombre);
    const rows = await v2FindClienteCatalogRows({ q, page, limit });
    return res.status(200).json(v2BuildCatalogResponse(rows, { page, limit }));
  } catch (err) {
    console.error('Error en /usuarios/v2/catalogos/clientes:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.get('/usuarios/v2/list', checkPermission(USUARIOS_LIST_PERMISSIONS), async (req, res) => {
  try {
    const page = req.query.page === undefined ? 1 : v2ParsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 10 : v2ParsePositiveInt(req.query.limit);

    if (!page || !requestedLimit) {
      return res.status(400).json({ error: true, message: 'page y limit deben ser enteros positivos' });
    }

    const limit = Math.min(requestedLimit, USUARIOS_V2_MAX_LIMIT);
    const offset = (page - 1) * limit;
    const q = v2NormalizeText(req.query.q ?? req.query.search ?? req.query.nombre);
    const sort = v2NormalizeUsuariosSort(req.query.sort);
    const estado = req.query.estado === undefined ? null : v2ParseBoolean(req.query.estado);
    if (req.query.estado !== undefined && estado === null) {
      return res.status(400).json({ error: true, message: 'estado debe ser booleano' });
    }

    const params = [];
    const whereParts = [];

    if (q) {
      params.push(`%${q}%`);
      whereParts.push(`(
        u.nombre_usuario ILIKE $${params.length}
        OR COALESCE(pe.nombre, '') ILIKE $${params.length}
        OR COALESCE(pe.apellido, '') ILIKE $${params.length}
        OR COALESCE(pe.dni::text, '') ILIKE $${params.length}
        OR COALESCE(te.telefono, '') ILIKE $${params.length}
        OR COALESCE(ce.direccion_correo, '') ILIKE $${params.length}
        OR COALESCE(pc.nombre, '') ILIKE $${params.length}
        OR COALESCE(pc.apellido, '') ILIKE $${params.length}
        OR COALESCE(pc.dni::text, '') ILIKE $${params.length}
        OR COALESCE(tc.telefono, '') ILIKE $${params.length}
        OR COALESCE(cc.direccion_correo, '') ILIKE $${params.length}
        OR COALESCE(ec.nombre_empresa, '') ILIKE $${params.length}
        OR COALESCE(s.nombre_sucursal, '') ILIKE $${params.length}
        OR COALESCE(roles_info.roles_nombres, '') ILIKE $${params.length}
      )`);
    }
    if (estado !== null) {
      params.push(estado);
      whereParts.push(`u.estado = $${params.length}`);
    }

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const orderBySql = USUARIOS_V2_SORT_SQL[sort] || USUARIOS_V2_SORT_SQL.recientes;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas pe ON pe.id_persona = e.id_persona
      LEFT JOIN telefonos te ON te.id_telefono = pe.id_telefono
      LEFT JOIN correos ce ON ce.id_correo = pe.id_correo
      LEFT JOIN clientes cl ON cl.id_cliente = u.id_cliente
      LEFT JOIN personas pc ON pc.id_persona = cl.id_persona
      LEFT JOIN empresas ec ON ec.id_empresa = cl.id_empresa
      LEFT JOIN telefonos tc ON tc.id_telefono = pc.id_telefono
      LEFT JOIN correos cc ON cc.id_correo = pc.id_correo
      LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(r2.nombre, ', ' ORDER BY r2.id_rol ASC) AS roles_nombres
        FROM roles_usuarios ru2
        INNER JOIN roles r2 ON r2.id_rol = ru2.id_rol
        WHERE ru2.id_usuario = u.id_usuario
      ) roles_info ON TRUE
      ${whereSql}
    `;

    const dataQuery = `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        u.estado,
        u.foto_perfil,
        u.fecha_creacion,
        u.tipo_usuario,
        e.id_empleado,
        cl.id_cliente,
        TRIM(CONCAT(COALESCE(pe.nombre, ''), ' ', COALESCE(pe.apellido, ''))) AS nombre_completo_empleado,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(pc.nombre, ''), ' ', COALESCE(pc.apellido, ''))), ''),
          NULLIF(TRIM(COALESCE(ec.nombre_empresa, '')), '')
        ) AS nombre_completo_cliente,
        ec.nombre_empresa AS nombre_empresa_cliente,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(pe.nombre, ''), ' ', COALESCE(pe.apellido, ''))), ''),
          NULLIF(TRIM(CONCAT(COALESCE(pc.nombre, ''), ' ', COALESCE(pc.apellido, ''))), ''),
          NULLIF(TRIM(COALESCE(ec.nombre_empresa, '')), ''),
          NULLIF(TRIM(COALESCE(u.nombre_usuario, '')), '')
        ) AS nombre_completo,
        pe.dni AS dni_empleado,
        pc.dni AS dni_cliente,
        te.telefono AS telefono_empleado,
        tc.telefono AS telefono_cliente,
        ce.direccion_correo AS correo_empleado,
        cc.direccion_correo AS correo_cliente,
        s.nombre_sucursal AS sucursal_nombre,
        roles_info.id_rol,
        roles_info.rol_nombre,
        roles_info.roles
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas pe ON pe.id_persona = e.id_persona
      LEFT JOIN telefonos te ON te.id_telefono = pe.id_telefono
      LEFT JOIN correos ce ON ce.id_correo = pe.id_correo
      LEFT JOIN clientes cl ON cl.id_cliente = u.id_cliente
      LEFT JOIN personas pc ON pc.id_persona = cl.id_persona
      LEFT JOIN empresas ec ON ec.id_empresa = cl.id_empresa
      LEFT JOIN telefonos tc ON tc.id_telefono = pc.id_telefono
      LEFT JOIN correos cc ON cc.id_correo = pc.id_correo
      LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
      LEFT JOIN LATERAL (
        SELECT
          MIN(r2.id_rol) AS id_rol,
          (ARRAY_AGG(r2.nombre ORDER BY r2.id_rol ASC))[1] AS rol_nombre,
          STRING_AGG(r2.nombre, ', ' ORDER BY r2.id_rol ASC) AS roles_nombres,
          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT('id_rol', r2.id_rol, 'nombre', r2.nombre)
              ORDER BY r2.id_rol ASC
            ),
            '[]'::json
          ) AS roles
        FROM roles_usuarios ru2
        INNER JOIN roles r2 ON r2.id_rol = ru2.id_rol
        WHERE ru2.id_usuario = u.id_usuario
      ) roles_info ON TRUE
      ${whereSql}
      ORDER BY u.id_usuario DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const summaryQuery = `
      SELECT
        COUNT(*)::int AS total_usuarios,
        COUNT(*) FILTER (WHERE u.estado = TRUE)::int AS usuarios_activos,
        COUNT(*) FILTER (WHERE u.estado = FALSE)::int AS usuarios_inactivos
      FROM usuarios u
    `;

    const [countResult, dataResult, summaryResult] = await Promise.all([
      pool.query(countQuery, params),
      pool.query(dataQuery.replace('ORDER BY u.id_usuario DESC', `ORDER BY ${orderBySql}`), [...params, limit, offset]),
      pool.query(summaryQuery),
    ]);

    const total = countResult.rows?.[0]?.total || 0;
    const items = dataResult.rows.map(v2MapUsuarioRow);
    const summaryRow = summaryResult.rows?.[0] || {};

    return res.status(200).json({
      error: false,
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        total: Number(summaryRow.total_usuarios) || 0,
        activas: Number(summaryRow.usuarios_activos) || 0,
        inactivas: Number(summaryRow.usuarios_inactivos) || 0,
      },
      appliedFilters: {
        q,
        estado,
        sort,
      },
    });
  } catch (err) {
    console.error('Error en /usuarios/v2/list:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.post('/usuarios/v2/create', checkPermission(USUARIOS_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const targetType = v2NormalizeUsuarioTarget(req.body);
    if (!targetType) {
      return res.status(400).json({ error: true, message: 'tipo_objetivo debe ser CLIENTE o EMPLEADO' });
    }
    const idEmpleado = v2ParsePositiveInt(req.body?.id_empleado);
    const idCliente = v2ParsePositiveInt(req.body?.id_cliente);

    if (targetType === 'EMPLEADO' && !idEmpleado) {
      return res.status(400).json({ error: true, message: 'id_empleado es obligatorio y debe ser positivo' });
    }
    if (targetType === 'CLIENTE' && !idCliente) {
      return res.status(400).json({ error: true, message: 'id_cliente es obligatorio y debe ser positivo' });
    }
    if (targetType === 'CLIENTE' && idEmpleado) {
      return res.status(400).json({ error: true, message: 'No se permite id_empleado cuando tipo_objetivo=CLIENTE' });
    }
    if (targetType === 'EMPLEADO' && idCliente) {
      return res.status(400).json({ error: true, message: 'No se permite id_cliente cuando tipo_objetivo=EMPLEADO' });
    }
    if (targetType === 'CLIENTE' && req.body?.id_sucursal !== undefined && req.body?.id_sucursal !== null && String(req.body.id_sucursal).trim() !== '') {
      return res.status(400).json({ error: true, message: 'id_sucursal no aplica para usuarios cliente' });
    }

    let roleIds = [];
    if (targetType === 'CLIENTE') {
      const clienteRoleId = await v2FindClienteRoleId(client);
      if (!clienteRoleId) {
        return res.status(500).json({ error: true, message: 'No se encontro el rol Cliente en la base de datos' });
      }
      roleIds = [clienteRoleId];
    } else {
      const roleSelection = v2NormalizeRoleIdsInput(req.body);
      if (roleSelection.invalid || !roleSelection.roleIds.length) {
        return res.status(400).json({ error: true, message: 'Debe enviar al menos un rol valido en id_roles o id_rol' });
      }
      const canAssignRoles = await requestHasAnyPermission(req, USUARIOS_ROLE_ASSIGN_PERMISSIONS);
      if (!canAssignRoles) {
        return res.status(403).json({
          error: true,
          message: 'Acceso denegado: permisos insuficientes para asignar roles'
        });
      }
      roleIds = roleSelection.roleIds;
    }

    let estado = true;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'estado')) {
      const parsedEstado = v2ParseBoolean(req.body.estado);
      if (parsedEstado === null) {
        return res.status(400).json({ error: true, message: 'estado debe ser booleano' });
      }
      estado = parsedEstado;
    }

    const plainPassword =
      v2NormalizeText(req.body?.password)
      || v2NormalizeText(req.body?.clave_plana);
    const passwordValidation = v2ValidateCreatePassword(plainPassword);
    if (!passwordValidation.ok) {
      return res.status(400).json({ error: true, message: passwordValidation.message });
    }

    await client.query('BEGIN');

    const roles = await v2FindRolesByIds(roleIds, client);
    if (roles.length !== roleIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'Uno o mas roles no existen' });
    }

    let generatedUsername = '';
    let targetIdField = 'id_empleado';
    let targetIdValue = idEmpleado;

    if (targetType === 'EMPLEADO') {
      const empleado = await v2FindEmployeeForUser(idEmpleado, client);
      if (!empleado) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: true, message: 'Empleado no encontrado' });
      }

      const duplicateEmployee = await client.query(
        'SELECT id_usuario FROM usuarios WHERE id_empleado = $1 LIMIT 1',
        [idEmpleado]
      );

      if (duplicateEmployee.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: true, message: 'Empleado ya tiene usuario' });
      }

      generatedUsername = await v2BuildUniqueUsername({
        nombre: empleado.nombre,
        apellido: empleado.apellido,
        idEmpleado,
        queryRunner: client,
      });
    } else {
      const cliente = await v2FindClienteForUser(idCliente, client);
      if (!cliente) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: true, message: 'Cliente no encontrado' });
      }

      const duplicateCliente = await client.query(
        'SELECT id_usuario FROM usuarios WHERE id_cliente = $1 LIMIT 1',
        [idCliente]
      );

      if (duplicateCliente.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: true, message: 'Cliente ya tiene usuario' });
      }

      generatedUsername = await v2BuildUniqueUsername({
        nombre: cliente.nombre,
        apellido: cliente.apellido,
        idEmpleado: idCliente,
        queryRunner: client,
      });
      targetIdField = 'id_cliente';
      targetIdValue = idCliente;
    }

    const passwordForStorage = await v2BuildPasswordForStorage(plainPassword, client);
    const capabilities = await v2GetCapabilities();

    const insertColumns = ['nombre_usuario', 'clave', 'estado', targetIdField, 'tipo_usuario'];
    const insertValues = [generatedUsername, passwordForStorage, estado, targetIdValue, targetType];
    const insertFragments = insertValues.map((_, idx) => `$${idx + 1}`);

    if (capabilities.hasFechaCreacion) {
      insertColumns.push('fecha_creacion');
      insertFragments.push('NOW()');
    }

    if (capabilities.mustChangePasswordField) {
      insertColumns.push(capabilities.mustChangePasswordField);
      insertValues.push(true);
      insertFragments.push(`$${insertValues.length}`);
    }

    const insertResult = await client.query(
      `
        INSERT INTO usuarios (${insertColumns.join(', ')})
        VALUES (${insertFragments.join(', ')})
        RETURNING id_usuario
      `,
      insertValues
    );

    const idUsuarioCreado = insertResult.rows?.[0]?.id_usuario;
    if (!idUsuarioCreado) {
      throw new Error('No se pudo obtener el id del usuario creado');
    }

    await v2ReplaceUserRoles(idUsuarioCreado, roleIds, client);

    const usuarioCreado = await v2FetchUsuarioById(idUsuarioCreado, client);

    await client.query('COMMIT');

    return res.status(201).json({
      error: false,
      message: 'Usuario creado exitosamente',
      usuario: usuarioCreado,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en /usuarios/v2/create:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.put('/usuarios/v2/update/:id_usuario', checkPermission(USUARIOS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    const current = await v2FetchUsuarioById(idUsuario);
    if (!current) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const updates = [];
    const values = [];
    const roleSelection = v2NormalizeRoleIdsInput(req.body);
    const hasRoleUpdate = roleSelection.hasSelection;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'estado')) {
      const parsedEstado = v2ParseBoolean(req.body.estado);
      if (parsedEstado === null) {
        return res.status(400).json({ error: true, message: 'estado debe ser booleano' });
      }
      values.push(parsedEstado);
      updates.push(`estado = $${values.length}`);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'nombre_usuario')) {
      const nextNombreUsuario = v2SanitizeUsernameToken(req.body.nombre_usuario);
      if (!nextNombreUsuario) {
        return res.status(400).json({ error: true, message: 'nombre_usuario no es valido' });
      }

      const exists = await v2UsernameExists(nextNombreUsuario, { excludeId: idUsuario });
      if (exists) {
        return res.status(409).json({ error: true, message: 'El nombre_usuario ya existe' });
      }

      values.push(nextNombreUsuario);
      updates.push(`nombre_usuario = $${values.length}`);
    }

    if (hasRoleUpdate) {
      const canAssignRoles = await requestHasAnyPermission(req, USUARIOS_ROLE_ASSIGN_PERMISSIONS);
      if (!canAssignRoles) {
        return res.status(403).json({
          error: true,
          message: 'Acceso denegado: permisos insuficientes para asignar roles'
        });
      }
      if (roleSelection.invalid || !roleSelection.roleIds.length) {
        return res.status(400).json({ error: true, message: 'Debe enviar al menos un rol valido en id_roles o id_rol' });
      }

      const roles = await v2FindRolesByIds(roleSelection.roleIds, client);
      if (roles.length !== roleSelection.roleIds.length) {
        return res.status(400).json({ error: true, message: 'Uno o mas roles no existen' });
      }
    }

    if (!updates.length && !hasRoleUpdate) {
      return res.status(200).json({
        error: false,
        message: 'No hay cambios para actualizar',
        usuario: current,
      });
    }

    await client.query('BEGIN');

    if (updates.length) {
      values.push(idUsuario);
      await client.query(
        `UPDATE usuarios SET ${updates.join(', ')} WHERE id_usuario = $${values.length}`,
        values
      );
    }

    if (hasRoleUpdate) {
      await v2ReplaceUserRoles(idUsuario, roleSelection.roleIds, client);
    }

    await client.query('COMMIT');

    const updated = await v2FetchUsuarioById(idUsuario);
    return res.status(200).json({
      error: false,
      message: 'Usuario actualizado correctamente',
      usuario: updated,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Error en /usuarios/v2/update/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.put('/usuarios/v2/photo/:id_usuario', checkPermission(USUARIOS_IMAGE_EDIT_PERMISSIONS), async (req, res) => {
  let uploadedPhotoStoragePath = '';
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'foto_perfil')) {
      return res.status(400).json({ error: true, message: 'foto_perfil es requerida' });
    }

    const fotoPerfil = req.body?.foto_perfil;

    const photoValidation = v2ValidatePhotoPayload(fotoPerfil);
    if (!photoValidation.ok) {
      return res.status(photoValidation.status || 400).json({ error: true, message: photoValidation.message });
    }

    const existingResult = await pool.query(
      'SELECT foto_perfil FROM usuarios WHERE id_usuario = $1 LIMIT 1',
      [idUsuario]
    );
    const existingUsuario = existingResult.rows?.[0] || null;
    if (!existingUsuario) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const previousStoredPhoto = v2NormalizeText(existingUsuario.foto_perfil);
    let valueToPersist = photoValidation.value;

    if (photoValidation.kind === 'data_url') {
      const storedPhoto = await v2StorePhotoDataUrlInSupabase(photoValidation.value);
      if (!storedPhoto.ok) {
        return res.status(storedPhoto.status || 400).json({ error: true, message: storedPhoto.message });
      }

      uploadedPhotoStoragePath = storedPhoto.uploadedStoragePath || '';
      valueToPersist = storedPhoto.storedPath;
    }

    const result = await pool.query(
      'UPDATE usuarios SET foto_perfil = $1 WHERE id_usuario = $2',
      [valueToPersist, idUsuario]
    );

    if (!result.rowCount) {
      if (uploadedPhotoStoragePath) {
        await supabase.storage.from(SUPABASE_ASSETS_BUCKET).remove([uploadedPhotoStoragePath]).catch(() => null);
      }
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    if (previousStoredPhoto && previousStoredPhoto !== valueToPersist) {
      await v2TryDeleteUsuariosStoredFile(previousStoredPhoto);
    }

    const updated = await v2FetchUsuarioById(idUsuario);
    return res.status(200).json({
      error: false,
      message: 'Foto de perfil actualizada correctamente',
      usuario: updated,
    });
  } catch (err) {
    if (uploadedPhotoStoragePath) {
      await supabase.storage.from(SUPABASE_ASSETS_BUCKET).remove([uploadedPhotoStoragePath]).catch(() => null);
    }
    if (err?.code === '22001') {
      return res.status(413).json({ error: true, message: 'URL de imagen demasiado larga. Maximo 500 caracteres.' });
    }
    console.error('Error en /usuarios/v2/photo/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.delete('/usuarios/v2/delete/:id_usuario', checkPermission(USUARIOS_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    const capabilities = await v2GetCapabilities();

    if (capabilities.hasEstado) {
      const result = await pool.query(
        'UPDATE usuarios SET estado = FALSE WHERE id_usuario = $1',
        [idUsuario]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
      }

      return res.status(200).json({
        error: false,
        message: 'Usuario inactivado correctamente',
      });
    }

    const result = await pool.query(
      'DELETE FROM usuarios WHERE id_usuario = $1',
      [idUsuario]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    return res.status(200).json({ error: false, message: 'Usuario eliminado correctamente' });
  } catch (err) {
    console.error('Error en /usuarios/v2/delete/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.post('/usuarios/v2/change-password', checkPermission(USUARIOS_CHANGE_OWN_PASSWORD_PERMISSIONS), passwordChangeLimiter, async (req, res) => {
  let client = null;
  try {
    const idUsuarioBody = v2ParsePositiveInt(req.body?.id_usuario);
    const idUsuarioJwt = v2ParsePositiveInt(req.user?.id_usuario);
    if (idUsuarioBody && idUsuarioJwt && idUsuarioBody !== idUsuarioJwt) {
      return res.status(403).json({
        error: true,
        message: 'No tiene permiso para cambiar la contrasena de otro usuario',
      });
    }

    const idUsuario = idUsuarioBody || idUsuarioJwt;

    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario es requerido' });
    }

    const claveActual =
      v2NormalizeText(req.body?.clave_actual)
      || v2NormalizeText(req.body?.password_actual);
    const claveNueva =
      v2NormalizeText(req.body?.clave_nueva)
      || v2NormalizeText(req.body?.password_nueva);

    if (!claveActual || !claveNueva) {
      return res.status(400).json({
        error: true,
        message: 'clave_actual y clave_nueva son requeridas',
      });
    }

    await ensurePasswordChangedAtColumn();

    client = await pool.connect();
    await client.query('BEGIN');

    const userResult = await client.query(
      'SELECT id_usuario, clave FROM usuarios WHERE id_usuario = $1 LIMIT 1 FOR UPDATE',
      [idUsuario]
    );

    if (!userResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const storedPassword = userResult.rows[0].clave;
    const passwordOk = await v2VerifyPassword(claveActual, storedPassword);

    if (!passwordOk) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'La contrasena actual no es correcta' });
    }

    const samePassword = await v2VerifyPassword(claveNueva, storedPassword);
    if (samePassword) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'La nueva contrasena no puede ser igual a la actual' });
    }

    const reuseResult = await client.query(
      `
        WITH ultimas AS (
          SELECT h.password_hash
          FROM usuarios_password_history h
          WHERE h.id_usuario = $1
          ORDER BY h.fecha_creacion DESC
          LIMIT 5
        )
        SELECT EXISTS (
          SELECT 1
          FROM ultimas u
          WHERE crypt($2::text, u.password_hash) = u.password_hash
        ) AS reused
      `,
      [idUsuario, claveNueva]
    );

    if (Boolean(reuseResult.rows?.[0]?.reused)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: true,
        message: 'La nueva contrasena ya fue utilizada recientemente. Elige una diferente',
      });
    }

    const { validatePasswordPolicy } = await import('../utils/security/passwordPolicy.js');
    const policyCheck = await validatePasswordPolicy(claveNueva);
    if (!policyCheck?.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: true,
        message: policyCheck?.message || 'La contrasena no cumple la politica',
      });
    }

    const capabilities = await v2GetCapabilities();
    const passwordForStorage = await v2BuildPasswordForStorage(claveNueva);

    const setParts = [
      'clave = $1',
      "fecha_cambio_clave = timezone('America/Tegucigalpa', now())",
    ];
    const values = [passwordForStorage];

    if (capabilities.mustChangePasswordField) {
      setParts.push(`${capabilities.mustChangePasswordField} = FALSE`);
    }

    values.push(idUsuario);

    await client.query(
      `
        INSERT INTO usuarios_password_history (id_usuario, password_hash)
        VALUES ($1, $2)
      `,
      [idUsuario, storedPassword]
    );

    await client.query(
      `UPDATE usuarios SET ${setParts.join(', ')} WHERE id_usuario = $${values.length}`,
      values
    );

    await client.query(
      `
        DELETE FROM usuarios_password_history
        WHERE id_usuario = $1
          AND id_historial IN (
            SELECT id_historial
            FROM usuarios_password_history
            WHERE id_usuario = $1
            ORDER BY fecha_creacion DESC, id_historial DESC
            OFFSET 5
          )
      `,
      [idUsuario]
    );

    await client.query('COMMIT');

    await issueUpdatedAccessTokenForOwnPasswordChange(req, res, idUsuario);

    return res.status(200).json({
      error: false,
      message: 'Contrasena actualizada correctamente',
      must_change_password_supported: Boolean(capabilities.mustChangePasswordField),
      todo: capabilities.mustChangePasswordField
        ? null
        : 'TODO: agregar columna must_change_password en usuarios para forzar cambio en primer login',
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('Error en /usuarios/v2/change-password:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    if (client) client.release();
  }
});

router.post('/usuarios/v2/generate', checkPermission(USUARIOS_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let createdUser = null;
  let temporaryPassword = '';

  try {
    const targetType = v2NormalizeUsuarioTarget(req.body);
    if (!targetType) {
      return res.status(400).json({ error: true, message: 'tipo_objetivo debe ser CLIENTE o EMPLEADO' });
    }
    const idEmpleado = v2ParsePositiveInt(req.body?.id_empleado);
    const idCliente = v2ParsePositiveInt(req.body?.id_cliente);

    if (targetType === 'EMPLEADO' && !idEmpleado) {
      return res.status(400).json({ error: true, message: 'id_empleado es obligatorio y debe ser positivo' });
    }
    if (targetType === 'CLIENTE' && !idCliente) {
      return res.status(400).json({ error: true, message: 'id_cliente es obligatorio y debe ser positivo' });
    }
    if (targetType === 'CLIENTE' && idEmpleado) {
      return res.status(400).json({ error: true, message: 'No se permite id_empleado cuando tipo_objetivo=CLIENTE' });
    }
    if (targetType === 'EMPLEADO' && idCliente) {
      return res.status(400).json({ error: true, message: 'No se permite id_cliente cuando tipo_objetivo=EMPLEADO' });
    }
    if (targetType === 'CLIENTE' && req.body?.id_sucursal !== undefined && req.body?.id_sucursal !== null && String(req.body.id_sucursal).trim() !== '') {
      return res.status(400).json({ error: true, message: 'id_sucursal no aplica para usuarios cliente' });
    }

    let roleIds = [];
    if (targetType === 'CLIENTE') {
      const clienteRoleId = await v2FindClienteRoleId(client);
      if (!clienteRoleId) {
        return res.status(500).json({ error: true, message: 'No se encontro el rol Cliente en la base de datos' });
      }
      roleIds = [clienteRoleId];
    } else {
      const roleSelection = v2NormalizeRoleIdsInput(req.body);
      if (roleSelection.invalid || !roleSelection.roleIds.length) {
        return res.status(400).json({ error: true, message: 'Debe enviar al menos un rol valido en id_roles o id_rol' });
      }
      const canAssignRoles = await requestHasAnyPermission(req, USUARIOS_ROLE_ASSIGN_PERMISSIONS);
      if (!canAssignRoles) {
        return res.status(403).json({
          error: true,
          message: 'Acceso denegado: permisos insuficientes para asignar roles'
        });
      }
      roleIds = roleSelection.roleIds;
    }

    await client.query('BEGIN');

    const roles = await v2FindRolesByIds(roleIds, client);
    if (roles.length !== roleIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'Uno o mas roles no existen' });
    }

    let generatedUsername = '';
    let targetIdField = 'id_empleado';
    let targetIdValue = idEmpleado;

    if (targetType === 'EMPLEADO') {
      const empleado = await v2FindEmployeeForUser(idEmpleado, client);
      if (!empleado) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: true, message: 'Empleado no encontrado' });
      }

      const duplicateEmployee = await client.query(
        'SELECT id_usuario FROM usuarios WHERE id_empleado = $1 LIMIT 1',
        [idEmpleado]
      );

      if (duplicateEmployee.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: true, message: 'Empleado ya tiene usuario' });
      }

      generatedUsername = await v2BuildUniqueUsername({
        nombre: empleado.nombre,
        apellido: empleado.apellido,
        idEmpleado,
        queryRunner: client,
      });
    } else {
      const cliente = await v2FindClienteForUser(idCliente, client);
      if (!cliente) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: true, message: 'Cliente no encontrado' });
      }

      const duplicateCliente = await client.query(
        'SELECT id_usuario FROM usuarios WHERE id_cliente = $1 LIMIT 1',
        [idCliente]
      );

      if (duplicateCliente.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: true, message: 'Cliente ya tiene usuario' });
      }

      generatedUsername = await v2BuildUniqueUsername({
        nombre: cliente.nombre,
        apellido: cliente.apellido,
        idEmpleado: idCliente,
        queryRunner: client,
      });
      targetIdField = 'id_cliente';
      targetIdValue = idCliente;
    }

    temporaryPassword = await v2GenerateTemporaryPassword();
    const passwordForStorage = await v2BuildPasswordForStorage(temporaryPassword, client);
    const capabilities = await v2GetCapabilities();

    const insertColumns = ['nombre_usuario', 'clave', 'estado', targetIdField, 'tipo_usuario'];
    const insertValues = [generatedUsername, passwordForStorage, true, targetIdValue, targetType];
    const insertFragments = insertValues.map((_, idx) => `$${idx + 1}`);

    if (capabilities.hasFechaCreacion) {
      insertColumns.push('fecha_creacion');
      insertFragments.push('NOW()');
    }

    if (capabilities.mustChangePasswordField) {
      insertColumns.push(capabilities.mustChangePasswordField);
      insertValues.push(true);
      insertFragments.push(`$${insertValues.length}`);
    }

    const insertResult = await client.query(
      `
        INSERT INTO usuarios (${insertColumns.join(', ')})
        VALUES (${insertFragments.join(', ')})
        RETURNING id_usuario
      `,
      insertValues
    );

    const idUsuarioCreado = insertResult.rows?.[0]?.id_usuario;
    if (!idUsuarioCreado) {
      throw new Error('No se pudo obtener el id del usuario creado');
    }

    await v2ReplaceUserRoles(idUsuarioCreado, roleIds, client);

    createdUser = await v2FetchUsuarioById(idUsuarioCreado, client);
    await client.query('COMMIT');

    const emailNotification = await v2SendTemporaryPasswordEmail({
      idUsuario: createdUser?.id_usuario,
      username: createdUser?.nombre_usuario,
      displayName: createdUser?.nombre_completo,
      temporaryPassword,
      mode: 'create',
    });

    return res.status(201).json({
      ok: true,
      usuario: {
        id_usuario: createdUser?.id_usuario,
        nombre_usuario: createdUser?.nombre_usuario,
        estado: createdUser?.estado,
        fecha_creacion: createdUser?.fecha_creacion,
        foto_perfil: createdUser?.foto_perfil || '',
        id_empleado: createdUser?.id_empleado,
        id_cliente: createdUser?.id_cliente,
        tipo_usuario: createdUser?.tipo_usuario,
      },
      temp_password: temporaryPassword,
      email_notification: emailNotification,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Error en /usuarios/v2/generate:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.post('/usuarios/v2/reset-password/:id_usuario', checkPermission(USUARIOS_RESET_PASSWORD_PERMISSIONS), async (req, res) => {
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    const currentUser = await v2FetchUsuarioById(idUsuario);
    if (!currentUser) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const temporaryPassword = await v2GenerateTemporaryPassword();
    const passwordForStorage = await v2BuildPasswordForStorage(temporaryPassword);
    const capabilities = await v2GetCapabilities();

    const setParts = ['clave = $1'];
    const values = [passwordForStorage];

    if (capabilities.mustChangePasswordField) {
      setParts.push(`${capabilities.mustChangePasswordField} = TRUE`);
    }

    values.push(idUsuario);

    await pool.query(
      `UPDATE usuarios SET ${setParts.join(', ')} WHERE id_usuario = $${values.length}`,
      values
    );

    const emailNotification = await v2SendTemporaryPasswordEmail({
      idUsuario: currentUser?.id_usuario,
      username: currentUser?.nombre_usuario,
      displayName: currentUser?.nombre_completo,
      temporaryPassword,
      mode: 'reset',
    });

    return res.status(200).json({
      ok: true,
      nombre_usuario: currentUser?.nombre_usuario || null,
      temp_password: temporaryPassword,
      email_notification: emailNotification,
    });
  } catch (err) {
    console.error('Error en /usuarios/v2/reset-password/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});
