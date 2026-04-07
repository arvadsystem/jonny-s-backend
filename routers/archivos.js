import crypto from 'crypto';
import express from 'express';
import pool from '../config/db-connection.js';
import { supabase } from '../services/supabaseClient.js';
import {
  ALLOWED_MIME_TYPES_BY_BUCKET,
  MAX_IMAGE_BYTES,
  INVENTARIO_UPLOADS_SUBDIR,
  ADMIN_UPLOADS_SUBDIR,
  SUPABASE_ASSETS_BUCKET,
  SUPABASE_ADMIN_BUCKET,
  buildAbsolutePublicUrl,
  detectFileMimeTypeFromBuffer
} from '../utils/uploads.js';

const router = express.Router();

const BASE64_BODY_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

const getSafeUploadErrorMessage = (fallback = 'No se pudo procesar el archivo.') => fallback;

const normalizeOriginalName = (value, defaultName = 'archivo') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return defaultName;
  // Eliminar caracteres peligrosos y limitar longitud
  return trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').slice(0, 100) || defaultName;
};

const parseUploadPayload = (payload) => {
  const rawDataUrl = payload?.data_url ?? payload?.dataUrl ?? payload?.archivo ?? null;
  const rawBase64 = payload?.base64 ?? payload?.contenido_base64 ?? null;
  const rawMime = payload?.mime_type ?? payload?.mimeType ?? payload?.tipo_archivo ?? null;

  const dataUrl = typeof rawDataUrl === 'string' ? rawDataUrl.trim() : '';
  if (dataUrl) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
    if (!match) {
      return { ok: false, status: 400, message: 'El archivo debe enviarse en formato data URL base64 valido.' };
    }

    return {
      ok: true,
      mimeType: String(match[1] || '').trim().toLowerCase(),
      base64Body: String(match[2] || '').trim()
    };
  }

  const base64Body = typeof rawBase64 === 'string' ? rawBase64.trim() : '';
  if (!base64Body) {
    return { ok: false, status: 400, message: 'El contenido del archivo es obligatorio.' };
  }

  return {
    ok: true,
    mimeType: String(rawMime || '').trim().toLowerCase(),
    base64Body
  };
};

const decodeBase64File = (base64Body) => {
  const normalized = String(base64Body || '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !BASE64_BODY_REGEX.test(normalized)) {
    return { ok: false, status: 400, message: 'El contenido base64 no es valido.' };
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, message: 'El archivo enviado no contiene datos validos.' };
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: 400,
      message: `El archivo supera el limite permitido de ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`
    };
  }

  return { ok: true, buffer };
};

/**
 * POST /archivos
 * Sube un archivo a un bucket de Supabase.
 * Params: { bucket, data_url | base64, nombre_original }
 */
router.post('/archivos', async (req, res) => {
  let supabaseFilePath = '';
  // Bucket destino (default: assets publicos)
  const targetBucket = req.body.bucket || SUPABASE_ASSETS_BUCKET;
  
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, message: 'Payload invalido.' });
    }

    // 1. Validar si el bucket es conocido
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TYPES_BY_BUCKET, targetBucket)) {
      return res.status(400).json({ ok: false, message: `Bucket '${targetBucket}' no reconocido.` });
    }

    // 2. Parsear y decodificar
    const parsedPayload = parseUploadPayload(payload);
    if (!parsedPayload.ok) {
      return res.status(parsedPayload.status).json({ ok: false, message: parsedPayload.message });
    }

    const decoded = decodeBase64File(parsedPayload.base64Body);
    if (!decoded.ok) {
      return res.status(decoded.status).json({ ok: false, message: decoded.message });
    }

    // 3. Validacion de MIME Type Dinamica por Bucket
    const detectedMimeType = detectFileMimeTypeFromBuffer(decoded.buffer);
    const declaredMimeType = parsedPayload.mimeType;
    const effectiveMimeType = detectedMimeType || declaredMimeType;
    const allowedMimesForBucket = ALLOWED_MIME_TYPES_BY_BUCKET[targetBucket];

    if (!effectiveMimeType || !Object.prototype.hasOwnProperty.call(allowedMimesForBucket, effectiveMimeType)) {
      return res.status(400).json({ 
        ok: false, 
        message: `Tipo de archivo '${effectiveMimeType}' no permitido en el bucket '${targetBucket}'.` 
      });
    }

    // 4. Generar nombre unico (UUID + Timestamp)
    const extension = allowedMimesForBucket[effectiveMimeType];
    const prefix = targetBucket === SUPABASE_ADMIN_BUCKET ? 'admin' : 'asset';
    const safeOriginalName = normalizeOriginalName(payload?.nombre_original ?? payload?.nombreOriginal, prefix);
    const uniqueFileName = `${safeOriginalName}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${extension}`;
    
    const subDir = targetBucket === SUPABASE_ADMIN_BUCKET ? ADMIN_UPLOADS_SUBDIR : INVENTARIO_UPLOADS_SUBDIR;
    supabaseFilePath = `${subDir}/${uniqueFileName}`;

    // 5. Subir a Supabase Storage (usando service_role para bypass RLS en subida)
    const { error: uploadError } = await supabase.storage
      .from(targetBucket)
      .upload(supabaseFilePath, decoded.buffer, {
        contentType: effectiveMimeType,
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      console.error(`Error subiendo a bucket ${targetBucket}:`, uploadError);
      throw new Error('No se pudo subir el archivo a la nube.');
    }

    // Path registrado en base de datos: "nombre-bucket/ruta/al/archivo.ext"
    const pathForDb = `${targetBucket}/${supabaseFilePath}`;

    const rawUserId = Number.parseInt(String(req.user?.id_usuario ?? ''), 10);
    const safeUserId = Number.isInteger(rawUserId) && rawUserId > 0 ? rawUserId : null;

    // 6. Registrar en Base de Datos
    const insertResult = await pool.query(
      `INSERT INTO archivos (
        nombre_original,
        url_publica,
        tipo_archivo,
        tamano_bytes,
        id_usuario
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id_archivo, url_publica`,
      [safeOriginalName, pathForDb, effectiveMimeType, decoded.buffer.length, safeUserId]
    );

    const inserted = insertResult.rows?.[0] || {};
    
    // Si es assets, retornamos la URL publica formateada. Si es admin, buildAbsolutePublicUrl retornara null (correcto).
    const resolvedUrl = buildAbsolutePublicUrl(req, inserted.url_publica || pathForDb);

    return res.status(201).json({
      ok: true,
      id_archivo: inserted.id_archivo ?? null,
      url_publica: resolvedUrl,
      requires_signed_url: targetBucket === SUPABASE_ADMIN_BUCKET
    });

  } catch (err) {
    if (supabaseFilePath) {
      await supabase.storage.from(targetBucket).remove([supabaseFilePath]).catch(() => null);
    }
    console.error('Error en carga de archivo:', err);
    return res.status(500).json({ ok: false, message: getSafeUploadErrorMessage() });
  }
});

/**
 * GET /archivos/:id/ver
 * Resuelve la URL de un archivo. Si es privado (admin-docs), genera una URL firmada.
 */
router.get('/archivos/:id/ver', async (req, res) => {
  const idArchivo = req.params.id;

  try {
    const result = await pool.query(
      'SELECT url_publica FROM archivos WHERE id_archivo = $1',
      [idArchivo]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'Archivo no encontrado.' });
    }

    const dbPath = result.rows[0].url_publica;
    const [bucket, ...pathParts] = dbPath.split('/');
    const filePath = pathParts.join('/');

    if (bucket === SUPABASE_ADMIN_BUCKET) {
      // Generar URL firmada con expiracion de 15 minutos (900 seg)
      const { data, error } = await supabase.storage
        .from(SUPABASE_ADMIN_BUCKET)
        .createSignedUrl(filePath, 900);

      if (error || !data) {
        console.error('Error generando URL firmada:', error);
        return res.status(500).json({ ok: false, message: 'No se pudo generar el acceso al documento.' });
      }

      return res.json({ ok: true, url: data.signedUrl, expires_in: 900 });
    } else {
      // Es un asset publico
      const publicUrl = buildAbsolutePublicUrl(req, dbPath);
      return res.json({ ok: true, url: publicUrl });
    }
  } catch (err) {
    console.error('Error visualizando archivo:', err);
    return res.status(500).json({ ok: false, message: 'Error interno al procesar el archivo.' });
  }
});

export default router;
