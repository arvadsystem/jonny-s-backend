import crypto from 'crypto';
import pool from '../config/db-connection.js';
import { supabase } from '../services/supabaseClient.js';
import {
  ALLOWED_MIME_TYPES_BY_BUCKET,
  MAX_FILE_BYTES_BY_BUCKET,
  SUPABASE_ASSETS_BUCKET,
  detectFileMimeTypeFromBuffer
} from '../utils/uploads.js';

const MENU_RECETAS_SUBDIR = 'menu/recetas';
const MENU_COMBOS_SUBDIR = 'menu/combos';

const isDriveLikeUrl = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  return raw.includes('drive.google.com') || raw.includes('drive.usercontent.google.com') || raw.includes('lh3.googleusercontent.com');
};

const toSafeBase = (value, fallback) => {
  const safe = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe || fallback;
};

const ensureAssetsBucket = async () => {
  const { data, error } = await supabase.storage.getBucket(SUPABASE_ASSETS_BUCKET);
  if (data && !error) return;
  const { error: createError } = await supabase.storage.createBucket(SUPABASE_ASSETS_BUCKET, {
    public: true,
    fileSizeLimit: MAX_FILE_BYTES_BY_BUCKET[SUPABASE_ASSETS_BUCKET],
    allowedMimeTypes: Object.keys(ALLOWED_MIME_TYPES_BY_BUCKET[SUPABASE_ASSETS_BUCKET] || {})
  });
  if (createError && !/already\s*exists|duplicate/i.test(String(createError?.message || ''))) {
    throw new Error('No se pudo asegurar el bucket de assets.');
  }
};

const fetchImageBuffer = async (url) => {
  const response = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}` };
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) return { ok: false, error: 'archivo vacio' };
  return { ok: true, buffer };
};

const pickSubdir = (row) => {
  if (Number(row?.id_receta_ref || 0) > 0) return MENU_RECETAS_SUBDIR;
  if (Number(row?.id_combo_ref || 0) > 0) return MENU_COMBOS_SUBDIR;
  return 'menu/migradas';
};

const run = async () => {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1] || 0)) : null;

  console.log(`[migrate-menu-images] mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  await ensureAssetsBucket();

  const result = await pool.query(
    `
      SELECT
        a.id_archivo,
        a.url_publica,
        a.nombre_original,
        a.tipo_archivo,
        r.id_receta AS id_receta_ref,
        c.id_combo AS id_combo_ref
      FROM public.archivos a
      LEFT JOIN public.recetas r
        ON r.id_archivo = a.id_archivo
      LEFT JOIN public.combos c
        ON c.id_archivo = a.id_archivo
      WHERE COALESCE(a.estado, true) = true
        AND (
          a.url_publica ILIKE '%drive.google.com%'
          OR a.url_publica ILIKE '%drive.usercontent.google.com%'
          OR a.url_publica ILIKE '%lh3.googleusercontent.com%'
        )
        AND (r.id_receta IS NOT NULL OR c.id_combo IS NOT NULL)
      ORDER BY a.id_archivo ASC
    `
  );

  const rows = Array.isArray(result.rows) ? result.rows : [];
  const targetRows = limit ? rows.slice(0, limit) : rows;
  console.log(`[migrate-menu-images] candidatos=${rows.length} procesando=${targetRows.length}`);

  const stats = { total: targetRows.length, migrated: 0, skipped: 0, failed: 0 };
  const allowedMimes = ALLOWED_MIME_TYPES_BY_BUCKET[SUPABASE_ASSETS_BUCKET] || {};
  const maxBytes = MAX_FILE_BYTES_BY_BUCKET[SUPABASE_ASSETS_BUCKET];

  for (const row of targetRows) {
    const idArchivo = Number(row.id_archivo);
    const url = String(row.url_publica || '').trim();
    if (!idArchivo || !isDriveLikeUrl(url)) {
      stats.skipped += 1;
      continue;
    }

    try {
      const downloaded = await fetchImageBuffer(url);
      if (!downloaded.ok) {
        stats.failed += 1;
        console.log(`[fail] id_archivo=${idArchivo} descarga: ${downloaded.error}`);
        continue;
      }
      if (downloaded.buffer.length > maxBytes) {
        stats.failed += 1;
        console.log(`[fail] id_archivo=${idArchivo} supera limite ${maxBytes} bytes`);
        continue;
      }

      const mimeType = detectFileMimeTypeFromBuffer(downloaded.buffer);
      const ext = allowedMimes[mimeType];
      if (!ext) {
        stats.failed += 1;
        console.log(`[fail] id_archivo=${idArchivo} mime no permitido: ${mimeType || 'desconocido'}`);
        continue;
      }

      const subdir = pickSubdir(row);
      const baseName = toSafeBase(row.nombre_original || `menu-${idArchivo}`, `menu-${idArchivo}`);
      const fileName = `${baseName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const storagePath = `${subdir}/${fileName}`;
      const dbPath = `${SUPABASE_ASSETS_BUCKET}/${storagePath}`;

      if (!apply) {
        stats.migrated += 1;
        console.log(`[dry] id_archivo=${idArchivo} -> ${dbPath}`);
        continue;
      }

      const { error: uploadError } = await supabase.storage
        .from(SUPABASE_ASSETS_BUCKET)
        .upload(storagePath, downloaded.buffer, {
          contentType: mimeType,
          cacheControl: '3600',
          upsert: false
        });
      if (uploadError) {
        stats.failed += 1;
        console.log(`[fail] id_archivo=${idArchivo} upload: ${uploadError.message || 'error'}`);
        continue;
      }

      await pool.query(
        `
          UPDATE public.archivos
             SET url_publica = $1,
                 tipo_archivo = $2,
                 tamano_bytes = $3
           WHERE id_archivo = $4
        `,
        [dbPath, mimeType, downloaded.buffer.length, idArchivo]
      );

      stats.migrated += 1;
      console.log(`[ok] id_archivo=${idArchivo} -> ${dbPath}`);
    } catch (error) {
      stats.failed += 1;
      console.log(`[fail] id_archivo=${idArchivo} error inesperado: ${error?.message || 'desconocido'}`);
    }
  }

  console.log('[migrate-menu-images] resumen:', stats);
};

run()
  .catch((error) => {
    console.error('[migrate-menu-images] fatal:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => null);
  });

