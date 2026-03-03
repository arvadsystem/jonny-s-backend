import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import pool from '../config/db-connection.js';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  UPLOADS_DIR,
  INVENTARIO_UPLOADS_SUBDIR,
  buildAbsolutePublicUrl,
  buildStoredPublicPath,
  detectImageMimeTypeFromBuffer,
  ensureUploadsDir
} from '../utils/uploads.js';

const router = express.Router();

const BASE64_BODY_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

const getSafeUploadErrorMessage = (fallback = 'No se pudo procesar la imagen.') => fallback;

const normalizeOriginalName = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'imagen-inventario';
  return trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').slice(0, 120) || 'imagen-inventario';
};

const parseUploadPayload = (payload) => {
  const rawDataUrl = payload?.data_url ?? payload?.dataUrl ?? payload?.archivo ?? null;
  const rawBase64 = payload?.base64 ?? payload?.contenido_base64 ?? null;
  const rawMime = payload?.mime_type ?? payload?.mimeType ?? payload?.tipo_archivo ?? null;

  const dataUrl = typeof rawDataUrl === 'string' ? rawDataUrl.trim() : '';
  if (dataUrl) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
    if (!match) {
      return { ok: false, status: 400, message: 'La imagen debe enviarse en formato data URL base64 valido.' };
    }

    return {
      ok: true,
      mimeType: String(match[1] || '').trim().toLowerCase(),
      base64Body: String(match[2] || '').trim()
    };
  }

  const base64Body = typeof rawBase64 === 'string' ? rawBase64.trim() : '';
  if (!base64Body) {
    return { ok: false, status: 400, message: 'La imagen es obligatoria.' };
  }

  return {
    ok: true,
    mimeType: String(rawMime || '').trim().toLowerCase(),
    base64Body
  };
};

const decodeBase64Image = (base64Body) => {
  const normalized = String(base64Body || '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !BASE64_BODY_REGEX.test(normalized)) {
    return { ok: false, status: 400, message: 'El contenido base64 de la imagen no es valido.' };
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, message: 'La imagen enviada no contiene datos validos.' };
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: 400,
      message: `La imagen supera el limite permitido de ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`
    };
  }

  return { ok: true, buffer };
};

router.post('/archivos', async (req, res) => {
  let writtenFileAbsolutePath = '';
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, message: 'Payload invalido para archivo.' });
    }

    const parsedPayload = parseUploadPayload(payload);
    if (!parsedPayload.ok) {
      return res.status(parsedPayload.status).json({ ok: false, message: parsedPayload.message });
    }

    const decoded = decodeBase64Image(parsedPayload.base64Body);
    if (!decoded.ok) {
      return res.status(decoded.status).json({ ok: false, message: decoded.message });
    }

    const detectedMimeType = detectImageMimeTypeFromBuffer(decoded.buffer);
    const declaredMimeType = parsedPayload.mimeType;
    const effectiveMimeType = detectedMimeType || declaredMimeType;

    // NEW: solo se aceptan imagenes jpeg/png/webp y se valida contra firma binaria minima.
    // WHY: el flujo usa JSON/base64 y necesitamos una validacion defensiva sin librerias nuevas.
    // IMPACT: rechaza archivos no soportados con 400 y evita guardar basura en disco/BD.
    if (!effectiveMimeType || !Object.prototype.hasOwnProperty.call(ALLOWED_IMAGE_MIME_TYPES, effectiveMimeType)) {
      return res.status(400).json({ ok: false, message: 'Solo se permiten imagenes JPG, PNG o WEBP.' });
    }

    if (declaredMimeType && detectedMimeType && declaredMimeType !== detectedMimeType) {
      return res.status(400).json({ ok: false, message: 'El tipo de archivo de la imagen no coincide con su contenido.' });
    }

    const extension = ALLOWED_IMAGE_MIME_TYPES[effectiveMimeType];
    const safeOriginalName = normalizeOriginalName(payload?.nombre_original ?? payload?.nombreOriginal);
    const fileName = `inventario-${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const fileRelativePath = buildStoredPublicPath(fileName);
    const fileAbsolutePath = path.join(UPLOADS_DIR, INVENTARIO_UPLOADS_SUBDIR, fileName);

    await ensureUploadsDir();
    await fs.writeFile(fileAbsolutePath, decoded.buffer, { flag: 'wx' });
    writtenFileAbsolutePath = fileAbsolutePath;

    const rawUserId = Number.parseInt(String(req.user?.id_usuario ?? ''), 10);
    const safeUserId = Number.isInteger(rawUserId) && rawUserId > 0 ? rawUserId : null;

    const insertResult = await pool.query(
      `INSERT INTO archivos (
        nombre_original,
        url_publica,
        tipo_archivo,
        tamano_bytes,
        id_usuario
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id_archivo, url_publica`,
      [safeOriginalName, fileRelativePath, effectiveMimeType, decoded.buffer.length, safeUserId]
    );

    const inserted = insertResult.rows?.[0] || {};
    return res.status(201).json({
      ok: true,
      id_archivo: inserted.id_archivo ?? null,
      url_publica: buildAbsolutePublicUrl(req, inserted.url_publica || fileRelativePath)
    });
  } catch (err) {
    if (writtenFileAbsolutePath) {
      await fs.unlink(writtenFileAbsolutePath).catch(() => null);
    }
    console.error('Error al crear archivo de imagen:', err);
    return res.status(500).json({
      ok: false,
      message: getSafeUploadErrorMessage()
    });
  }
});

export default router;
