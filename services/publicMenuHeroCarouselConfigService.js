import pool from '../config/db-connection.js';
import { CARRUSEL_UPLOADS_SUBDIR, SUPABASE_ASSETS_BUCKET } from '../utils/uploads.js';

const HERO_CAROUSEL_CONFIG_KEY = 'menu_publico_hero_carrusel_global_v1';
const HERO_CAROUSEL_MAX_ITEMS = 6;
const HERO_CAROUSEL_MAX_TITLE_LENGTH = 120;
const HERO_CAROUSEL_MAX_IMAGE_URL_LENGTH = 1024;
const HERO_CAROUSEL_DESCRIPTION = 'Configuracion global del carrusel hero del menu publico.';
const SUPABASE_PUBLIC_OBJECT_MARKER = '/storage/v1/object/public/';
const HERO_CAROUSEL_ALLOWED_PREFIX = `${SUPABASE_ASSETS_BUCKET}/${CARRUSEL_UPLOADS_SUBDIR}/`;

const toBranchKey = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return String(parsed);
};

const toPositiveUniqueIds = (values = []) => {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const normalized = [];

  for (const value of source) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || seen.has(parsed)) continue;
    seen.add(parsed);
    normalized.push(parsed);
    if (normalized.length >= HERO_CAROUSEL_MAX_ITEMS) break;
  }

  return normalized;
};

const extractSupabaseStoragePath = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('blob:') || raw.startsWith('data:')) return '';

  let candidate = raw;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      const safePath = decodeURIComponent(String(parsed.pathname || ''));
      const markerIndex = safePath.indexOf(SUPABASE_PUBLIC_OBJECT_MARKER);
      if (markerIndex < 0) return '';
      candidate = safePath.slice(markerIndex + SUPABASE_PUBLIC_OBJECT_MARKER.length);
    } catch {
      return '';
    }
  } else if (candidate.startsWith('/')) {
    const safePath = decodeURIComponent(candidate);
    const markerIndex = safePath.indexOf(SUPABASE_PUBLIC_OBJECT_MARKER);
    if (markerIndex >= 0) {
      candidate = safePath.slice(markerIndex + SUPABASE_PUBLIC_OBJECT_MARKER.length);
    }
  }

  const normalized = String(candidate || '').trim().replace(/^\/+/, '');
  if (!normalized.startsWith(`${SUPABASE_ASSETS_BUCKET}/`)) return '';
  if (!normalized.startsWith(HERO_CAROUSEL_ALLOWED_PREFIX)) return '';
  return normalized;
};

const sanitizeImageUrl = (value) => {
  const storagePath = extractSupabaseStoragePath(value);
  if (!storagePath) return '';
  return storagePath.slice(0, HERO_CAROUSEL_MAX_IMAGE_URL_LENGTH);
};

const sanitizeTitle = (value) => String(value ?? '').trim().slice(0, HERO_CAROUSEL_MAX_TITLE_LENGTH);

const normalizeCustomSlides = (rows = []) => {
  const source = Array.isArray(rows) ? rows : [];
  const normalized = [];

  source.forEach((row, index) => {
    if (normalized.length >= HERO_CAROUSEL_MAX_ITEMS) return;
    const imageUrl = sanitizeImageUrl(row?.imageUrl);
    if (!imageUrl) return;

    normalized.push({
      id: String(row?.id || `custom-${index}`),
      imageUrl,
      title: sanitizeTitle(row?.title)
    });
  });

  return normalized;
};

const safeParseConfig = (rawValue) => {
  if (!rawValue) return {};
  try {
    return JSON.parse(String(rawValue));
  } catch {
    return {};
  }
};

export const normalizePublicMenuHeroCarouselConfig = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const byBranchSource = source.byBranch && typeof source.byBranch === 'object' ? source.byBranch : {};
  const customByBranchSource =
    source.customByBranch && typeof source.customByBranch === 'object'
      ? source.customByBranch
      : {};

  const byBranch = {};
  Object.entries(byBranchSource).forEach(([rawBranchKey, ids]) => {
    const branchKey = toBranchKey(rawBranchKey);
    if (!branchKey) return;
    byBranch[branchKey] = toPositiveUniqueIds(ids);
  });

  const customByBranch = {};
  Object.entries(customByBranchSource).forEach(([rawBranchKey, rows]) => {
    const branchKey = toBranchKey(rawBranchKey);
    if (!branchKey) return;
    customByBranch[branchKey] = normalizeCustomSlides(rows);
  });

  return { byBranch, customByBranch };
};

export const getPublicMenuHeroCarouselConfig = async () => {
  const result = await pool.query(
    `
      SELECT valor
      FROM configuracion_sistema
      WHERE clave = $1
      LIMIT 1;
    `,
    [HERO_CAROUSEL_CONFIG_KEY]
  );

  const rawValue = result.rows?.[0]?.valor || '';
  return normalizePublicMenuHeroCarouselConfig(safeParseConfig(rawValue));
};

export const savePublicMenuHeroCarouselConfig = async ({ client, config }) => {
  const normalized = normalizePublicMenuHeroCarouselConfig(config);
  const serialized = JSON.stringify(normalized);
  const executor = client || pool;

  const updateResult = await executor.query(
    `
      UPDATE configuracion_sistema
      SET valor = $1,
          actualizado_en = CURRENT_TIMESTAMP
      WHERE clave = $2;
    `,
    [serialized, HERO_CAROUSEL_CONFIG_KEY]
  );

  if (updateResult.rowCount === 0) {
    await executor.query(
      `
        INSERT INTO configuracion_sistema (clave, valor, descripcion, actualizado_en)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP);
      `,
      [HERO_CAROUSEL_CONFIG_KEY, serialized, HERO_CAROUSEL_DESCRIPTION]
    );
  }

  return normalized;
};
