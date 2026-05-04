import pool from '../config/db-connection.js';
import { CARRUSEL_UPLOADS_SUBDIR, SUPABASE_ASSETS_BUCKET } from '../utils/uploads.js';

const HERO_CAROUSEL_CONFIG_KEY = 'menu_publico_hero_carrusel_global_v1';
const HERO_CAROUSEL_CONFIG_VALUE_MAX_LENGTH = 200;
const HERO_CAROUSEL_DESCRIPTION = 'Configuracion global del carrusel hero del menu publico.';
const HERO_CAROUSEL_MAX_ITEMS = 6;
const HERO_CAROUSEL_MAX_TITLE_LENGTH = 120;
const HERO_CAROUSEL_ALLOWED_PREFIX = `${SUPABASE_ASSETS_BUCKET}/${CARRUSEL_UPLOADS_SUBDIR}/`;
const SUPABASE_PUBLIC_OBJECT_MARKER = '/storage/v1/object/public/';
const HERO_CONFIG_GLOBAL_BRANCH_KEY = '0';
const HERO_CONFIG_VERSION = 2;

const toBranchKey = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return String(parsed);
};

const toPositiveIntOrNull = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toPositiveUniqueIds = (values = []) => {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const normalized = [];

  for (const value of source) {
    const parsed = toPositiveIntOrNull(value);
    if (!parsed || seen.has(parsed)) continue;
    seen.add(parsed);
    normalized.push(parsed);
    if (normalized.length >= HERO_CAROUSEL_MAX_ITEMS) break;
  }

  return normalized;
};

const sanitizeTitle = (value) => String(value ?? '').trim().slice(0, HERO_CAROUSEL_MAX_TITLE_LENGTH);

const safeParseConfig = (rawValue) => {
  if (!rawValue) return {};
  try {
    return JSON.parse(String(rawValue));
  } catch {
    return {};
  }
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
  if (!normalized.startsWith(HERO_CAROUSEL_ALLOWED_PREFIX)) return '';
  return normalized;
};

const parseArchivoIdFromValue = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const numeric = toPositiveIntOrNull(text);
  if (numeric) return numeric;
  const match = text.match(/^archivo-(\d+)$/i);
  return match ? toPositiveIntOrNull(match[1]) : null;
};

const parseByBranchFromAny = (source = {}) => {
  const output = {};
  Object.entries(source || {}).forEach(([rawBranchKey, ids]) => {
    const branchKey = toBranchKey(rawBranchKey);
    if (!branchKey) return;
    output[branchKey] = toPositiveUniqueIds(ids);
  });
  return output;
};

const parseCustomIdsByBranchFromCompact = (source = {}) => {
  const output = {};
  Object.entries(source || {}).forEach(([rawBranchKey, ids]) => {
    const branchKey = toBranchKey(rawBranchKey);
    if (!branchKey) return;
    output[branchKey] = toPositiveUniqueIds(ids);
  });
  return output;
};

const parseCustomRowsByBranchFromLegacy = (source = {}) => {
  const output = {};
  Object.entries(source || {}).forEach(([rawBranchKey, rows]) => {
    const branchKey = toBranchKey(rawBranchKey);
    if (!branchKey) return;
    output[branchKey] = Array.isArray(rows) ? rows : [];
  });
  return output;
};

const resolveConfigInputShape = (config = {}) => {
  const source = config && typeof config === 'object' ? config : {};

  if (Number(source?.v) === HERO_CONFIG_VERSION) {
    return {
      byBranch: parseByBranchFromAny(source?.b || {}),
      customByBranchIds: parseCustomIdsByBranchFromCompact(source?.c || {}),
      customByBranchRows: {}
    };
  }

  const byBranchRaw = source.byBranch && typeof source.byBranch === 'object' ? source.byBranch : {};
  const customByBranchRaw =
    source.customByBranch && typeof source.customByBranch === 'object'
      ? source.customByBranch
      : {};

  const byBranch = parseByBranchFromAny(byBranchRaw);
  const customByBranchIds = parseCustomIdsByBranchFromCompact(customByBranchRaw);
  const customByBranchRows = parseCustomRowsByBranchFromLegacy(customByBranchRaw);

  return { byBranch, customByBranchIds, customByBranchRows };
};

const resolveLegacyRowsToIds = async ({ executor, customByBranchRows = {}, customByBranchIds = {} }) => {
  const nextCustomIds = { ...(customByBranchIds || {}) };
  const unresolvedPaths = new Set();
  const unresolvedRowsByBranch = {};

  Object.entries(customByBranchRows || {}).forEach(([branchKey, rows]) => {
    const seen = new Set(nextCustomIds[branchKey] || []);
    const ids = [...(nextCustomIds[branchKey] || [])];
    const unresolvedRows = [];

    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (ids.length >= HERO_CAROUSEL_MAX_ITEMS) return;

      const fromRowId =
        parseArchivoIdFromValue(row?.id) ||
        parseArchivoIdFromValue(row?.id_archivo) ||
        parseArchivoIdFromValue(row?.archivo_id);
      if (fromRowId && !seen.has(fromRowId)) {
        seen.add(fromRowId);
        ids.push(fromRowId);
        return;
      }

      const storagePath = extractSupabaseStoragePath(row?.imageUrl);
      if (!storagePath) return;
      unresolvedPaths.add(storagePath);
      unresolvedRows.push(storagePath);
    });

    nextCustomIds[branchKey] = ids.slice(0, HERO_CAROUSEL_MAX_ITEMS);
    if (unresolvedRows.length > 0) unresolvedRowsByBranch[branchKey] = unresolvedRows;
  });

  if (unresolvedPaths.size === 0) return nextCustomIds;

  const rows = await executor.query(
    `
      SELECT id_archivo, url_publica
      FROM archivos
      WHERE url_publica = ANY($1::text[])
    `,
    [[...unresolvedPaths]]
  );

  const idByPath = new Map(
    (rows.rows || []).map((row) => [
      String(row?.url_publica || '').trim(),
      toPositiveIntOrNull(row?.id_archivo)
    ])
  );

  Object.entries(unresolvedRowsByBranch).forEach(([branchKey, paths]) => {
    const seen = new Set(nextCustomIds[branchKey] || []);
    const ids = [...(nextCustomIds[branchKey] || [])];

    (Array.isArray(paths) ? paths : []).forEach((path) => {
      if (ids.length >= HERO_CAROUSEL_MAX_ITEMS) return;
      const idArchivo = idByPath.get(String(path || '').trim());
      if (!idArchivo || seen.has(idArchivo)) return;
      seen.add(idArchivo);
      ids.push(idArchivo);
    });

    nextCustomIds[branchKey] = ids.slice(0, HERO_CAROUSEL_MAX_ITEMS);
  });

  return nextCustomIds;
};

const buildCompactConfigPayload = ({ byBranch = {}, customByBranchIds = {} }) => {
  const compactByBranch = parseByBranchFromAny(byBranch);
  const compactCustomByBranch = parseCustomIdsByBranchFromCompact(customByBranchIds);

  if (!Object.prototype.hasOwnProperty.call(compactByBranch, HERO_CONFIG_GLOBAL_BRANCH_KEY)) {
    compactByBranch[HERO_CONFIG_GLOBAL_BRANCH_KEY] = [];
  }
  if (!Object.prototype.hasOwnProperty.call(compactCustomByBranch, HERO_CONFIG_GLOBAL_BRANCH_KEY)) {
    compactCustomByBranch[HERO_CONFIG_GLOBAL_BRANCH_KEY] = [];
  }

  return {
    v: HERO_CONFIG_VERSION,
    b: compactByBranch,
    c: compactCustomByBranch
  };
};

const fetchArchivoRowsByIds = async (executor, ids = []) => {
  const safeIds = toPositiveUniqueIds(ids);
  if (!safeIds.length) return new Map();

  const result = await executor.query(
    `
      SELECT id_archivo, url_publica, nombre_original
      FROM archivos
      WHERE id_archivo = ANY($1::int[])
        AND COALESCE(estado, true) = true
    `,
    [safeIds]
  );

  return new Map(
    (result.rows || []).map((row) => [
      Number(row.id_archivo),
      {
        id: `archivo-${Number(row.id_archivo)}`,
        imageUrl: String(row.url_publica || '').trim(),
        title: sanitizeTitle(row.nombre_original || '')
      }
    ])
  );
};

const expandCustomByBranchIdsToRows = async (executor, customByBranchIds = {}) => {
  const branchEntries = Object.entries(customByBranchIds || {});
  const allIds = [];
  branchEntries.forEach(([, ids]) => {
    allIds.push(...toPositiveUniqueIds(ids));
  });

  const mediaById = await fetchArchivoRowsByIds(executor, allIds);
  const output = {};

  branchEntries.forEach(([rawBranchKey, ids]) => {
    const branchKey = toBranchKey(rawBranchKey);
    if (!branchKey) return;

    const rows = toPositiveUniqueIds(ids)
      .map((idArchivo) => mediaById.get(idArchivo))
      .filter(Boolean);

    output[branchKey] = rows.slice(0, HERO_CAROUSEL_MAX_ITEMS);
  });

  if (!Object.prototype.hasOwnProperty.call(output, HERO_CONFIG_GLOBAL_BRANCH_KEY)) {
    output[HERO_CONFIG_GLOBAL_BRANCH_KEY] = [];
  }

  return output;
};

const buildPublicConfigFromRawValue = async ({ executor, rawValue }) => {
  const parsed = safeParseConfig(rawValue);
  const shape = resolveConfigInputShape(parsed);
  const customIds = await resolveLegacyRowsToIds({
    executor,
    customByBranchRows: shape.customByBranchRows,
    customByBranchIds: shape.customByBranchIds
  });

  const byBranch = parseByBranchFromAny(shape.byBranch);
  if (!Object.prototype.hasOwnProperty.call(byBranch, HERO_CONFIG_GLOBAL_BRANCH_KEY)) {
    byBranch[HERO_CONFIG_GLOBAL_BRANCH_KEY] = [];
  }

  const customByBranch = await expandCustomByBranchIdsToRows(executor, customIds);
  return { byBranch, customByBranch };
};

const serializeCompactPayload = (payload) => {
  const serialized = JSON.stringify(payload);
  if (serialized.length > HERO_CAROUSEL_CONFIG_VALUE_MAX_LENGTH) {
    const error = new Error('La configuracion del carrusel excede el limite permitido por base de datos.');
    error.status = 400;
    throw error;
  }
  return serialized;
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
  return buildPublicConfigFromRawValue({ executor: pool, rawValue });
};

export const savePublicMenuHeroCarouselConfig = async ({ client, config }) => {
  const executor = client || pool;
  const inputShape = resolveConfigInputShape(config);
  const customIds = await resolveLegacyRowsToIds({
    executor,
    customByBranchRows: inputShape.customByBranchRows,
    customByBranchIds: inputShape.customByBranchIds
  });

  const compactPayload = buildCompactConfigPayload({
    byBranch: inputShape.byBranch,
    customByBranchIds: customIds
  });
  const serialized = serializeCompactPayload(compactPayload);

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

  return buildPublicConfigFromRawValue({ executor, rawValue: serialized });
};

