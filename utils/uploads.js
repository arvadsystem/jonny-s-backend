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
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGE_JSON_LIMIT = '10mb';

// NEW: MIME types permitidos para imagenes del modulo Inventario.
// WHY: cumplir la regla de solo aceptar jpeg/png/webp sin dependencias externas.
// IMPACT: se usa en validacion backend y en la generacion de extension segura del archivo.
export const ALLOWED_IMAGE_MIME_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
});

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

  const explicitBase = String(process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');
  const requestBase = req ? `${req.protocol}://${req.get('host')}` : '';
  const base = explicitBase || requestBase;
  if (!base) return normalized;

  return `${base}${normalized.startsWith('/') ? '' : '/'}${normalized}`;
};

export const detectImageMimeTypeFromBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  // NEW: firmas binarias minimas para evitar confiar solo en el MIME declarado por el cliente.
  // WHY: el upload usa JSON/base64 y no hay libreria externa para inspeccion profunda.
  // IMPACT: rechaza archivos renombrados/falsos sin modificar el flujo de imagenes validas.
  const isJpeg =
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

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

  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (isWebp) return 'image/webp';

  return null;
};

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
    'SELECT id_archivo, url_publica FROM archivos WHERE id_archivo = ANY($1::int[])',
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
