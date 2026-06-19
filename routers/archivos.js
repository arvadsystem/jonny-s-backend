import crypto from 'crypto';
import express from 'express';
import sharp from 'sharp';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { supabase } from '../services/supabaseClient.js';
import {
  ALLOWED_MIME_TYPES_BY_BUCKET,
  FACTURACION_LOGO_MAX_DIMENSION_PX,
  FACTURACION_LOGO_RETRY_DIMENSION_PX,
  MAX_FILE_BYTES_BY_BUCKET,
  MAX_FACTURACION_LOGO_BYTES,
  MAX_IMAGE_BYTES,
  INVENTARIO_UPLOADS_SUBDIR,
  SUCURSALES_UPLOADS_SUBDIR,
  CARRUSEL_UPLOADS_SUBDIR,
  ADMIN_UPLOADS_SUBDIR,
  SUPABASE_ASSETS_BUCKET,
  SUPABASE_ADMIN_BUCKET,
  buildAbsolutePublicUrl,
  detectFileMimeTypeFromBuffer
} from '../utils/uploads.js';

const router = express.Router();
const ARCHIVOS_VIEW_PERMISSIONS = [
  'INVENTARIO_ARCHIVOS_VER',
  'INVENTARIO_VER',
  'SUCURSALES_FACTURACION_VER',
  'SUCURSALES_FACTURACION_EDITAR',
  'SUCURSALES_FACTURACION_PREVIEW_VER'
];
const ARCHIVOS_UPLOAD_PERMISSIONS = [
  'INVENTARIO_ARCHIVOS_SUBIR',
  'INVENTARIO_PRODUCTOS_IMAGEN_SUBIR',
  'INVENTARIO_OC_RECEPCIONAR',
  'INVENTARIO_OC_SUBIR_FACTURA',
  'INVENTARIO_VER',
  'SUCURSALES_FACTURACION_EDITAR'
];
const ARCHIVOS_DELETE_PERMISSIONS = [
  'INVENTARIO_ARCHIVOS_ELIMINAR',
  'INVENTARIO_PRODUCTOS_IMAGEN_ELIMINAR',
  'INVENTARIO_VER',
  'SUCURSALES_FACTURACION_EDITAR'
];

const BASE64_BODY_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const SQLSTATE_UNDEFINED_TABLE = '42P01';
const SQLSTATE_UNDEFINED_COLUMN = '42703';
const ARCHIVO_INVALID_ID_MESSAGE = 'id_archivo invalido.';
const ARCHIVO_NOT_FOUND_MESSAGE = 'Archivo no encontrado.';
const ARCHIVO_IN_USE_MESSAGE = 'No se pudo limpiar la imagen porque esta siendo utilizada en otros modulos del sistema.';
const ARCHIVO_CLEANUP_SUCCESS_MESSAGE = 'Archivo temporal limpiado correctamente.';
const ARCHIVO_CLEANUP_PENDING_MESSAGE = 'La imagen temporal fue desactivada y quedo pendiente su limpieza fisica.';
const FACTURACION_LOGO_OPTIMIZE_ERROR_MESSAGE = 'No se pudo optimizar el logo. Intenta con una imagen mas liviana.';

const getSafeUploadErrorMessage = (fallback = 'No se pudo procesar el archivo.') => fallback;
const getSafeArchivoCleanupErrorMessage = (fallback = 'No se pudo limpiar la imagen temporal.') => fallback;

const optimizeFacturacionLogoBuffer = async (buffer) => {
  const optimize = (dimension) => sharp(buffer, { failOn: 'warning' })
    .rotate()
    .resize({
      width: dimension,
      height: dimension,
      fit: 'inside',
      withoutEnlargement: true
    })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true
    })
    .toBuffer();

  let optimizedBuffer = await optimize(FACTURACION_LOGO_MAX_DIMENSION_PX);
  if (optimizedBuffer.length <= MAX_FACTURACION_LOGO_BYTES) {
    return {
      buffer: optimizedBuffer,
      width: FACTURACION_LOGO_MAX_DIMENSION_PX
    };
  }

  optimizedBuffer = await optimize(FACTURACION_LOGO_RETRY_DIMENSION_PX);
  if (optimizedBuffer.length <= MAX_FACTURACION_LOGO_BYTES) {
    return {
      buffer: optimizedBuffer,
      width: FACTURACION_LOGO_RETRY_DIMENSION_PX
    };
  }

  return null;
};

const ensureSupabaseBucket = async (bucketName) => {
  const bucket = String(bucketName || '').trim();
  if (!bucket) throw new Error('Bucket invalido.');

  const { data: existingBucket, error: getBucketError } = await supabase.storage.getBucket(bucket);
  if (existingBucket && !getBucketError) return;

  const notFound =
    getBucketError &&
    (
      Number(getBucketError?.statusCode || getBucketError?.status || 0) === 404 ||
      /not\s*found|does\s*not\s*exist/i.test(String(getBucketError?.message || ''))
    );

  if (getBucketError && !notFound) {
    console.error(`Error verificando bucket ${bucket}:`, getBucketError);
    throw new Error('No se pudo verificar el bucket de almacenamiento.');
  }

  const { error: createBucketError } = await supabase.storage.createBucket(bucket, {
    public: bucket === SUPABASE_ASSETS_BUCKET,
    fileSizeLimit: MAX_FILE_BYTES_BY_BUCKET[bucket],
    allowedMimeTypes: Object.keys(ALLOWED_MIME_TYPES_BY_BUCKET[bucket] || {})
  });

  if (
    createBucketError &&
    !/already\s*exists|duplicate/i.test(String(createBucketError?.message || ''))
  ) {
    console.error(`Error creando bucket ${bucket}:`, createBucketError);
    throw new Error('No se pudo crear el bucket de almacenamiento.');
  }
};

const normalizeOriginalName = (value, defaultName = 'archivo') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return defaultName;

  const withoutExtension = trimmed.replace(/\.[a-z0-9]{1,8}$/i, '');
  const safe = withoutExtension
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return safe || defaultName;
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

const decodeBase64File = (base64Body, maxBytes = MAX_IMAGE_BYTES) => {
  const normalized = String(base64Body || '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !BASE64_BODY_REGEX.test(normalized)) {
    return { ok: false, status: 400, message: 'El contenido base64 no es valido.' };
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, message: 'El archivo enviado no contiene datos validos.' };
  }

  if (buffer.length > maxBytes) {
    return {
      ok: false,
      status: 400,
      message: `El archivo supera el limite permitido de ${Math.floor(maxBytes / (1024 * 1024))} MB.`
    };
  }

  return { ok: true, buffer };
};

const isSkippableSchemaError = (error) =>
  error?.code === SQLSTATE_UNDEFINED_TABLE || error?.code === SQLSTATE_UNDEFINED_COLUMN;

const safeReferenceCount = async ({ label, query, params }, db = pool) => {
  try {
    const result = await db.query(query, Array.isArray(params) ? params : []);
    const total = Number.parseInt(String(result.rows?.[0]?.total ?? '0'), 10);
    return {
      modulo: label,
      checked: true,
      total: Number.isNaN(total) ? 0 : total
    };
  } catch (error) {
    if (isSkippableSchemaError(error)) {
      console.warn(`[archivos] referencia omitida (${label}):`, error.message);
      return { modulo: label, checked: false, total: 0 };
    }
    throw error;
  }
};

const getArchivoReferenceSummary = async (idArchivo, db = pool) => {
  const checks = await Promise.all([
    safeReferenceCount(
      {
        label: 'productos',
        params: [idArchivo],
        query: 'SELECT COUNT(*)::int AS total FROM public.productos WHERE id_archivo_imagen_principal = $1'
      },
      db
    ),
    safeReferenceCount(
      {
        label: 'insumos',
        params: [idArchivo],
        query: 'SELECT COUNT(*)::int AS total FROM public.insumos WHERE id_archivo_imagen_principal = $1'
      },
      db
    ),
    safeReferenceCount(
      {
        label: 'recetas',
        params: [idArchivo],
        query: 'SELECT COUNT(*)::int AS total FROM public.recetas WHERE id_archivo = $1'
      },
      db
    ),
    safeReferenceCount(
      {
        label: 'combos',
        params: [idArchivo],
        query: 'SELECT COUNT(*)::int AS total FROM public.combos WHERE id_archivo = $1'
      },
      db
    ),
    safeReferenceCount(
      {
        label: 'ordenes_compra',
        params: [idArchivo],
        query: 'SELECT COUNT(*)::int AS total FROM public.orden_compras WHERE id_archivo_factura_recepcion = $1'
      },
      db
    ),
    safeReferenceCount(
      {
        label: 'compras',
        params: [idArchivo],
        query: 'SELECT COUNT(*)::int AS total FROM public.compras WHERE id_archivo_transferencia = $1'
      },
      db
    ),
    safeReferenceCount(
      {
        label: 'facturacion_config_sucursal',
        params: [idArchivo],
        query: 'SELECT COUNT(*)::int AS total FROM public.facturacion_config_sucursal WHERE id_archivo_logo = $1'
      },
      db
    )
  ]);

  const blockingModules = checks
    .filter((entry) => entry.checked && entry.total > 0)
    .map((entry) => ({ modulo: entry.modulo, total: entry.total }));

  return {
    hasReferences: blockingModules.length > 0,
    summary: {
      blocking_modules: blockingModules,
      checks
    }
  };
};

const parseStoredStoragePath = (rawValue) => {
  const input = String(rawValue || '').trim();
  if (!input) return null;

  let candidate = input;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(String(parsed.pathname || '').replace(/^\/+/, ''));
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

/**
 * POST /archivos
 * Sube un archivo a un bucket de Supabase.
 * Params: { bucket, data_url | base64, nombre_original }
 */
router.post('/archivos', checkPermission(ARCHIVOS_UPLOAD_PERMISSIONS), async (req, res) => {
  let supabaseFilePath = '';
  const targetBucket = String(req.body?.bucket || SUPABASE_ASSETS_BUCKET).trim() || SUPABASE_ASSETS_BUCKET;
  
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

    const bucketMaxBytes =
      MAX_FILE_BYTES_BY_BUCKET[targetBucket] || MAX_FILE_BYTES_BY_BUCKET[SUPABASE_ASSETS_BUCKET] || MAX_IMAGE_BYTES;

    const decoded = decodeBase64File(parsedPayload.base64Body, bucketMaxBytes);
    if (!decoded.ok) {
      return res.status(decoded.status).json({ ok: false, message: decoded.message });
    }

    // 3. Validacion de MIME Type Dinamica por Bucket
    const detectedMimeType = detectFileMimeTypeFromBuffer(decoded.buffer);
    const declaredMimeType = parsedPayload.mimeType;
    let effectiveMimeType = detectedMimeType || declaredMimeType;
    const allowedMimesForBucket = ALLOWED_MIME_TYPES_BY_BUCKET[targetBucket];
    let uploadBuffer = decoded.buffer;

    if (!effectiveMimeType || !Object.prototype.hasOwnProperty.call(allowedMimesForBucket, effectiveMimeType)) {
      return res.status(400).json({ 
        ok: false, 
        message: `Tipo de archivo '${effectiveMimeType}' no permitido en el bucket '${targetBucket}'.` 
      });
    }

    const contextoRaw = String(payload?.contexto || payload?.modulo || '').trim().toLowerCase();
    if (contextoRaw === 'facturacion-logo') {
      if (targetBucket !== SUPABASE_ADMIN_BUCKET) {
        return res.status(400).json({
          ok: false,
          message: `Los logos de facturacion deben subirse al bucket '${SUPABASE_ADMIN_BUCKET}'.`
        });
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(detectedMimeType)) {
        return res.status(400).json({
          ok: false,
          message: 'Solo se permiten imagenes JPG, PNG o WEBP para logos de facturacion.'
        });
      }

      let optimizedLogo = null;
      try {
        optimizedLogo = await optimizeFacturacionLogoBuffer(decoded.buffer);
      } catch (optimizeError) {
        console.error('[archivos] error optimizando logo de facturacion:', optimizeError);
        return res.status(400).json({
          ok: false,
          message: FACTURACION_LOGO_OPTIMIZE_ERROR_MESSAGE
        });
      }

      if (!optimizedLogo?.buffer?.length) {
        return res.status(400).json({
          ok: false,
          message: FACTURACION_LOGO_OPTIMIZE_ERROR_MESSAGE
        });
      }

      uploadBuffer = optimizedLogo.buffer;
      effectiveMimeType = 'image/png';
    }
    if (contextoRaw === 'sucursales' && !['image/jpeg', 'image/png'].includes(effectiveMimeType)) {
      return res.status(400).json({
        ok: false,
        message: 'Solo se permiten imagenes JPG o PNG para sucursales.'
      });
    }

    // 4. Generar nombre unico (UUID + Timestamp)
    const extension = allowedMimesForBucket[effectiveMimeType];
    const prefix = targetBucket === SUPABASE_ADMIN_BUCKET ? 'admin' : 'asset';
    const safeOriginalName = normalizeOriginalName(payload?.nombre_original ?? payload?.nombreOriginal, prefix);
    const uniqueFileName = `${safeOriginalName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;

    const subDir = targetBucket === SUPABASE_ADMIN_BUCKET
      ? (contextoRaw === 'facturacion-logo' ? 'facturacion' : ADMIN_UPLOADS_SUBDIR)
      : contextoRaw === 'sucursales'
        ? SUCURSALES_UPLOADS_SUBDIR
        : contextoRaw === 'carrusel'
          ? CARRUSEL_UPLOADS_SUBDIR
          : INVENTARIO_UPLOADS_SUBDIR;
    supabaseFilePath = `${subDir}/${uniqueFileName}`;

    // 5. Subir a Supabase Storage (usando service_role para bypass RLS en subida)
    await ensureSupabaseBucket(targetBucket);
    const { error: uploadError } = await supabase.storage
      .from(targetBucket)
      .upload(supabaseFilePath, uploadBuffer, {
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
      [safeOriginalName, pathForDb, effectiveMimeType, uploadBuffer.length, safeUserId]
    );

    const inserted = insertResult.rows?.[0] || {};
    
    // Si es assets, retornamos la URL publica formateada. Si es admin, buildAbsolutePublicUrl retornara null (correcto).
    const resolvedUrl = buildAbsolutePublicUrl(req, inserted.url_publica || pathForDb);

    return res.status(201).json({
      ok: true,
      id_archivo: inserted.id_archivo ?? null,
      storage_path: inserted.url_publica || pathForDb,
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
router.get('/archivos/:id/ver', checkPermission(ARCHIVOS_VIEW_PERMISSIONS), async (req, res) => {
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

/**
 * DELETE /archivos/:id
 * Cleanup compensatorio para uploads que no llegaron a vincularse.
 * - Bloquea si el archivo esta referenciado en otros modulos.
 * - Desactiva en BD (estado=false) y luego intenta limpiar storage.
 */
router.delete('/archivos/:id', checkPermission(ARCHIVOS_DELETE_PERMISSIONS), async (req, res) => {
  const idArchivo = Number.parseInt(String(req.params?.id ?? ''), 10);
  if (!Number.isInteger(idArchivo) || idArchivo <= 0) {
    return res.status(400).json({ ok: false, error: true, code: 'INVALID_ARCHIVO_ID', message: ARCHIVO_INVALID_ID_MESSAGE });
  }

  const client = await pool.connect();
  let txStarted = false;
  try {
    await client.query('BEGIN');
    txStarted = true;

    const archivoResult = await client.query(
      `
        SELECT id_archivo, url_publica, COALESCE(estado, true) AS estado
        FROM public.archivos
        WHERE id_archivo = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idArchivo]
    );

    if (archivoResult.rowCount === 0) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(404).json({ ok: false, error: true, code: 'ARCHIVO_NOT_FOUND', message: ARCHIVO_NOT_FOUND_MESSAGE });
    }

    const dependencySummary = await getArchivoReferenceSummary(idArchivo, client);
    if (dependencySummary.hasReferences) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(409).json({
        ok: false,
        error: true,
        code: 'ARCHIVO_IN_USE',
        message: ARCHIVO_IN_USE_MESSAGE,
        dependency_summary: dependencySummary.summary
      });
    }

    const archivo = archivoResult.rows[0];
    let softDeleteApplied = true;
    try {
      await client.query(
        'UPDATE public.archivos SET estado = false WHERE id_archivo = $1',
        [idArchivo]
      );
    } catch (updateError) {
      if (updateError?.code !== SQLSTATE_UNDEFINED_COLUMN) throw updateError;
      softDeleteApplied = false;
      await client.query(
        'DELETE FROM public.archivos WHERE id_archivo = $1',
        [idArchivo]
      );
    }

    await client.query('COMMIT');
    txStarted = false;

    let cleanupPending = false;
    const storagePath = parseStoredStoragePath(archivo?.url_publica);
    const canRemoveFromStorage =
      storagePath &&
      (storagePath.bucket === SUPABASE_ASSETS_BUCKET || storagePath.bucket === SUPABASE_ADMIN_BUCKET);

    if (canRemoveFromStorage) {
      const { error: removeError } = await supabase.storage
        .from(storagePath.bucket)
        .remove([storagePath.filePath]);

      if (removeError) {
        cleanupPending = true;
        console.error('Error limpiando archivo en storage:', removeError);
      }
    }

    return res.status(200).json({
      ok: true,
      error: false,
      id_archivo: idArchivo,
      soft_deleted: softDeleteApplied,
      cleanup_pending: cleanupPending,
      message: cleanupPending
        ? ARCHIVO_CLEANUP_PENDING_MESSAGE
        : ARCHIVO_CLEANUP_SUCCESS_MESSAGE
    });
  } catch (error) {
    if (txStarted) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('Error limpiando archivo:', error);
    return res.status(500).json({
      ok: false,
      error: true,
      code: 'ARCHIVO_CLEANUP_FAILED',
      message: getSafeArchivoCleanupErrorMessage()
    });
  } finally {
    client.release();
  }
});

export default router;
