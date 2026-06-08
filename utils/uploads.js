import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NEW: configuracion central para uploads del modulo Inventario.
// WHY: reutilizar la misma carpeta, limite y normalizacion de URLs entre `app.js` y los routers.
// IMPACT: concentra la logica de imagenes sin alterar otros modulos ni contratos existentes.
export const UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');
export const UPLOADS_PUBLIC_PREFIX = '/uploads';
export const INVENTARIO_UPLOADS_SUBDIR = 'inventario';
export const SUCURSALES_UPLOADS_SUBDIR = 'sucursales';
export const CARRUSEL_UPLOADS_SUBDIR = 'carrusel';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_JSON_LIMIT = '10mb';
export const MAX_FACTURACION_LOGO_BYTES = 512 * 1024;
export const FACTURACION_LOGO_MAX_DIMENSION_PX = 320;
export const FACTURACION_LOGO_RETRY_DIMENSION_PX = 220;

// NEW: configuracion de Supabase Storage.
export const SUPABASE_ASSETS_BUCKET = 'jonnys-assets'; // Publico
export const SUPABASE_ADMIN_BUCKET = 'admin-docs';     // Privado (RLS)
export const MAX_FILE_BYTES_BY_BUCKET = Object.freeze({
  [SUPABASE_ASSETS_BUCKET]: 5 * 1024 * 1024,
  [SUPABASE_ADMIN_BUCKET]: 10 * 1024 * 1024
});

// NEW: subdirectorios para organizacion interna
export const ADMIN_UPLOADS_SUBDIR = 'documentos-admin';

// NEW: MIME types permitidos por balde.
// WHY: restringir el tipo de contenido segun su proposito administrativo o publico.
// IMPACT: se usa en validacion dinamica en archivos.js
export const ALLOWED_MIME_TYPES_BY_BUCKET = Object.freeze({
  [SUPABASE_ASSETS_BUCKET]: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  },
  [SUPABASE_ADMIN_BUCKET]: {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  }
});

// Alias para retrocompatibilidad (usado en modulos anteriores)
export const ALLOWED_IMAGE_MIME_TYPES = ALLOWED_MIME_TYPES_BY_BUCKET[SUPABASE_ASSETS_BUCKET];

export const ensureUploadsDir = async () => {
  await fs.mkdir(path.join(UPLOADS_DIR, INVENTARIO_UPLOADS_SUBDIR), { recursive: true });
};

export const buildStoredPublicPath = (filename) => (
  `${UPLOADS_PUBLIC_PREFIX}/${INVENTARIO_UPLOADS_SUBDIR}/${filename}`
);

export const buildAbsolutePublicUrl = (req, rawUrl) => {
  const normalized = String(rawUrl || '').trim();
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) return normalized;

  // Si la URL empieza con el prefijo de supabase storage publico (ej: jonnys-assets/)
  if (normalized.startsWith(`${SUPABASE_ASSETS_BUCKET}/`)) {
    const supabaseUrl = String(
      process.env.SUPABASE_URL ||
      process.env.PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_PUBLIC_URL ||
      ''
    ).trim().replace(/\/+$/, '');
    if (supabaseUrl) {
      return `${supabaseUrl}/storage/v1/object/public/${normalized}`;
    }
  }

  // SI ES PRIVADO (admin-docs), NO RETORNAMOS URL PUBLICA.
  // El frontend debera llamar al endpoint de firma.
  if (normalized.startsWith(`${SUPABASE_ADMIN_BUCKET}/`)) {
    return null;
  }

  const explicitBase = String(process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');
  const requestBase = req ? `${req.protocol}://${req.get('host')}` : '';
  const base = explicitBase || requestBase;
  if (!base) return normalized;

  return `${base}${normalized.startsWith('/') ? '' : '/'}${normalized}`;
};

export const detectFileMimeTypeFromBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  // FIRMAS BINARIAS (Magic Numbers)
  
  // JPEG: FF D8 FF
  const isJpeg =
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) return 'image/png';

  // WEBP: RIFF .... WEBP
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (isWebp) return 'image/webp';

  // PDF: %PDF- (25 50 44 46 2d)
  const isPdf =
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (isPdf) return 'application/pdf';

  return null;
};

// Alias para retrocompatibilidad
export const detectImageMimeTypeFromBuffer = detectFileMimeTypeFromBuffer;

export const attachImagenPrincipalUrls = async (pool, req, rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const uniqueArchivoIds = [...new Set(
    rows
      .map((row) => Number.parseInt(String(row?.id_archivo_imagen_principal ?? ''), 10))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];

  if (uniqueArchivoIds.length === 0) {
    return rows.map((row) => ({ ...row, imagen_principal_url: null }));
  }

  const archivosResult = await pool.query(
    `
      SELECT id_archivo, url_publica
      FROM archivos
      WHERE id_archivo = ANY($1::int[])
        AND COALESCE(estado, true) = true
    `,
    [uniqueArchivoIds]
  );

  const archivosMap = new Map(
    archivosResult.rows.map((row) => [Number(row.id_archivo), buildAbsolutePublicUrl(req, row.url_publica)])
  );

  return rows.map((row) => {
    const archivoId = Number.parseInt(String(row?.id_archivo_imagen_principal ?? ''), 10);
    return {
      ...row,
      imagen_principal_url: Number.isInteger(archivoId) && archivoId > 0
        ? (archivosMap.get(archivoId) || null)
        : null
    };
  });
};
