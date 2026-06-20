import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { clearVentasComplementCatalogCache } from './ventas/services/complementosCatalogService.js';
import {
  isCatalogoMaestroViewMissingError,
  logCatalogoMaestroViewMissing,
  queryCatalogoMaestroView,
  sendCatalogoMaestroViewMissingResponse
} from '../services/catalogoMaestroReadService.js';
import { buildAdminSalsasInsumosCatalog } from './admin_salsas/services/adminSalsasInsumosCatalogService.js';
import {
  attachSalsaInventoryState,
  getInventoryStateLabel,
  getUnitDisplay,
  isSelectableInsumoRow,
  normalizeAdminStatus,
  normalizeText
} from './admin_salsas/services/salsaInventoryAdminStateService.js';

const router = express.Router();
// AM: transicion segura a permisos granulares sin romper el acceso actual mientras se alinea BD/roles.
const MENU_SALSAS_VIEW_PERMISSIONS = ['MENU_SALSAS_VER', 'MENU_VER'];
const MENU_SALSAS_CREATE_PERMISSIONS = ['MENU_SALSAS_CREAR', 'MENU_VER'];
const MENU_SALSAS_EDIT_PERMISSIONS = ['MENU_SALSAS_EDITAR', 'MENU_VER'];
const MENU_SALSAS_STATE_PERMISSIONS = ['MENU_SALSAS_ESTADO_CAMBIAR', 'MENU_VER'];

const columnMetaCache = new Map();

const getSafeServerErrorMessage = (error, fallback = 'Error interno del servidor.') => {
  return fallback;
};

const getColumnMeta = async (tableName, columnName) => {
  const cacheKey = `${String(tableName || '').trim().toLowerCase()}.${String(columnName || '').trim().toLowerCase()}`;
  if (columnMetaCache.has(cacheKey)) {
    return columnMetaCache.get(cacheKey);
  }

  const result = await pool.query(
    `
      SELECT
        c.column_name,
        c.is_nullable = 'YES' AS is_nullable,
        c.column_default IS NOT NULL AS has_default
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = $1
        AND c.column_name = $2
      LIMIT 1;
    `,
    [tableName, columnName]
  );

  const row = result.rows[0] || null;
  const meta = {
    exists: Boolean(row),
    isNullable: Boolean(row?.is_nullable),
    hasDefault: Boolean(row?.has_default)
  };

  columnMetaCache.set(cacheKey, meta);
  return meta;
};

const hasColumn = async (tableName, columnName) => {
  const meta = await getColumnMeta(tableName, columnName);
  return meta.exists;
};

const toPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Seguridad: el actor se resuelve siempre desde el token autenticado.
const resolveActorUserId = (req) => toPositiveInt(req?.user?.id_usuario);

const toIntOrNull = (value, options = {}) => {
  if (value === undefined || value === null || value === '') {
    return options.allowNull ? null : null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (options.min !== undefined && parsed < options.min) return null;
  if (options.max !== undefined && parsed > options.max) return null;
  return parsed;
};

const toPositiveNumberOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 't', 'si', 'activo', 'activa'].includes(normalized)) return true;
    if (['false', 'f', 'no', 'inactivo', 'inactiva'].includes(normalized)) return false;
  }
  return null;
};

const shouldIncludeInactive = (query) => {
  const value = String(
    query?.include_inactive ??
    query?.incluir_inactivos ??
    query?.all ??
    ''
  ).trim().toLowerCase();

  return ['1', 'true', 'si', 'yes', 'all'].includes(value);
};

const shouldOnlyInactive = (query) => {
  const value = String(query?.only_inactive ?? '').trim().toLowerCase();
  return ['1', 'true', 'si', 'yes'].includes(value);
};

const sanitizeName = (value) => String(value || '').trim();

const toUniquePositiveIntArray = (values) => (
  [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )]
);

const buildInsertStatement = ({ tableName, data = {}, raw = {}, returning = '' }) => {
  const columns = [];
  const placeholders = [];
  const params = [];

  for (const [column, value] of Object.entries(data)) {
    if (value === undefined) continue;
    columns.push(column);
    params.push(value);
    placeholders.push(`$${params.length}`);
  }

  for (const [column, expression] of Object.entries(raw)) {
    if (!expression) continue;
    columns.push(column);
    placeholders.push(expression);
  }

  if (columns.length === 0) {
    throw new Error(`No hay columnas para insertar en ${tableName}.`);
  }

  const returningClause = returning ? ` RETURNING ${returning}` : '';
  return {
    text: `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${returningClause};`,
    params
  };
};

const buildBatchInsertStatement = ({ tableName, rows = [], columns = [], raw = {} }) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalizedColumns = columns.filter((column) => column?.name && typeof column.getValue === 'function');
  const rawColumns = Object.entries(raw).filter(([, expression]) => Boolean(expression));
  if (normalizedColumns.length === 0 && rawColumns.length === 0) {
    throw new Error(`No hay columnas para insertar en ${tableName}.`);
  }

  const params = [];
  const values = rows.map((row) => {
    const placeholders = normalizedColumns.map((column) => {
      params.push(column.getValue(row));
      return `$${params.length}`;
    });
    for (const [, expression] of rawColumns) {
      placeholders.push(expression);
    }
    return `(${placeholders.join(', ')})`;
  });

  const columnNames = [
    ...normalizedColumns.map((column) => column.name),
    ...rawColumns.map(([columnName]) => columnName)
  ];

  return {
    text: `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES ${values.join(', ')};`,
    params
  };
};

const invalidateVentasComplementCatalogCache = (reason) => {
  try {
    clearVentasComplementCatalogCache();
  } catch (error) {
    console.warn(`No se pudo invalidar cache de complementos de ventas (${reason}):`, error?.message || error);
  }
};

const ensureUsuarioExists = async (idUsuario) => {
  const parsed = toPositiveInt(idUsuario);
  if (!parsed) return false;
  const result = await pool.query('SELECT 1 FROM usuarios WHERE id_usuario = $1 LIMIT 1;', [parsed]);
  return result.rowCount > 0;
};

const ensureRecetaExists = async (idReceta) => {
  const parsed = toPositiveInt(idReceta);
  if (!parsed) return null;
  const result = await pool.query(
    `
      SELECT id_receta, nombre_receta
      FROM recetas
      WHERE id_receta = $1
      LIMIT 1;
    `,
    [parsed]
  );
  return result.rows[0] || null;
};

const normalizeSalsaPayload = (payload, { partial = false } = {}) => {
  const nombre = sanitizeName(payload?.nombre);
  const nivelPicante = toIntOrNull(payload?.nivel_picante, { min: 0, max: 10 });
  const orden = toIntOrNull(payload?.orden, { min: 0, max: 9999, allowNull: true });
  const estado = payload?.estado === undefined ? null : parseBoolean(payload.estado);
  const idUsuario = payload?.id_usuario === undefined ? null : toPositiveInt(payload.id_usuario);

  if (!partial || payload?.nombre !== undefined) {
    if (!nombre) {
      return { ok: false, message: 'nombre es obligatorio.' };
    }
    if (nombre.length > 120) {
      return { ok: false, message: 'nombre no puede exceder 120 caracteres.' };
    }
  }

  if ((!partial || payload?.nivel_picante !== undefined) && nivelPicante === null) {
    return { ok: false, message: 'nivel_picante debe ser un entero entre 0 y 10.' };
  }

  if (payload?.orden !== undefined && orden === null) {
    return { ok: false, message: 'orden debe ser un entero positivo o 0.' };
  }

  if (payload?.estado !== undefined && estado === null) {
    return { ok: false, message: 'estado debe ser booleano.' };
  }

  if (payload?.id_usuario !== undefined && !idUsuario) {
    return { ok: false, message: 'id_usuario debe ser un entero mayor a 0.' };
  }

  return {
    ok: true,
    data: {
      nombre,
      nivel_picante: nivelPicante,
      orden,
      estado,
      id_usuario: idUsuario
    }
  };
};

const normalizeSalsaInventoryPayload = (payload = {}) => {
  const hasInsumoField = Object.prototype.hasOwnProperty.call(payload, 'id_insumo');
  const hasUnidadField = Object.prototype.hasOwnProperty.call(payload, 'id_unidad_consumo');
  const removeConfig = (payload.id_insumo === null || payload.id_insumo === '') && (payload.id_unidad_consumo === null || payload.id_unidad_consumo === '');

  if (removeConfig) {
    return {
      ok: true,
      data: {
        id_insumo: null,
        cantidad_porcion: 2,
        id_unidad_consumo: null
      }
    };
  }

  const idInsumo = toPositiveInt(payload.id_insumo);
  const cantidadPorcion = payload.cantidad_porcion === undefined || payload.cantidad_porcion === null || payload.cantidad_porcion === ''
    ? null
    : toPositiveNumberOrNull(payload.cantidad_porcion);
  const idUnidadConsumo = toPositiveInt(payload.id_unidad_consumo);

  if (!hasInsumoField || !idInsumo) {
    return { ok: false, message: 'Selecciona un insumo valido para la salsa.' };
  }
  if (!cantidadPorcion) {
    return { ok: false, message: 'cantidad_porcion debe ser mayor a 0.' };
  }
  if (!hasUnidadField || !idUnidadConsumo) {
    return { ok: false, message: 'Selecciona una unidad de consumo valida.' };
  }

  return {
    ok: true,
    data: {
      id_insumo: idInsumo,
      cantidad_porcion: cantidadPorcion,
      id_unidad_consumo: idUnidadConsumo
    }
  };
};

const validateSalsaInventoryConfig = async (data) => {
  if (!data.id_insumo && !data.id_unidad_consumo) return { ok: true };

  const insumoResult = await pool.query(
    `
      SELECT
        i.id_insumo,
        i.nombre_insumo,
        COALESCE(i.estado, true) AS estado,
        i.id_unidad_medida,
        map.mapping_count,
        map.id_insumo_maestro,
        map.estado_mapeo_maestro,
        i_master.nombre_insumo AS insumo_maestro_nombre,
        COALESCE(i_master.estado, true) AS insumo_maestro_estado,
        i_master.id_unidad_medida AS id_unidad_base_maestro
      FROM public.insumos i
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS mapping_count,
          MIN(imm.id_insumo_maestro)::int AS id_insumo_maestro,
          MIN(imm.estado_migracion) AS estado_mapeo_maestro
        FROM public.insumos_mapeo_maestro imm
        WHERE imm.id_insumo_legacy = i.id_insumo
      ) map ON true
      LEFT JOIN public.insumos i_master
        ON i_master.id_insumo = CASE
          WHEN map.mapping_count = 1 AND UPPER(TRIM(COALESCE(map.estado_mapeo_maestro, ''))) = 'VALIDADO'
            THEN map.id_insumo_maestro
          ELSE NULL
        END
      WHERE i.id_insumo = $1
      LIMIT 1
    `,
    [data.id_insumo]
  );
  if (!insumoResult.rowCount) {
    return { ok: false, status: 400, message: 'El insumo seleccionado no existe.' };
  }
  const insumo = insumoResult.rows[0];
  if (insumo.estado !== true) {
    return { ok: false, status: 409, message: 'El insumo seleccionado esta inactivo.' };
  }
  const selectable = isSelectableInsumoRow(insumo);
  if (!selectable.selectable) {
    return { ok: false, status: 409, message: selectable.reason || 'El insumo seleccionado no puede usarse en salsas.' };
  }
  const idInsumoEfectivo = toPositiveInt(insumo.id_insumo_maestro) || toPositiveInt(insumo.id_insumo);
  const idUnidadBaseEfectiva = toPositiveInt(insumo.id_unidad_base_maestro) || toPositiveInt(insumo.id_unidad_medida);
  if (toPositiveInt(insumo.id_insumo_maestro) && insumo.insumo_maestro_estado !== true) {
    return { ok: false, status: 409, message: 'El insumo maestro resuelto no existe o esta inactivo.' };
  }
  if (!idUnidadBaseEfectiva) {
    return { ok: false, status: 409, message: 'El insumo seleccionado no tiene unidad base configurada.' };
  }
  if (idInsumoEfectivo !== toPositiveInt(data.id_insumo)) {
    return {
      ok: false,
      status: 409,
      message: `Selecciona el insumo maestro #${idInsumoEfectivo}; los IDs legacy no se pueden guardar en salsas.`
    };
  }

  const duplicateMasterResult = await pool.query(
    `
      SELECT other.id_insumo
      FROM public.insumos current
      INNER JOIN public.insumos other
        ON other.id_insumo <> current.id_insumo
       AND other.estado IS TRUE
       AND UPPER(REGEXP_REPLACE(BTRIM(other.nombre_insumo), '\\s+', ' ', 'g'))
         = UPPER(REGEXP_REPLACE(BTRIM(current.nombre_insumo), '\\s+', ' ', 'g'))
      INNER JOIN public.insumos_mapeo_maestro other_map
        ON other_map.id_insumo_legacy = other.id_insumo
       AND other_map.id_insumo_maestro = other.id_insumo
       AND UPPER(TRIM(other_map.estado_migracion)) = 'VALIDADO'
      WHERE current.id_insumo = $1
      ORDER BY other.id_insumo
    `,
    [idInsumoEfectivo]
  );
  if (duplicateMasterResult.rowCount > 0) {
    const conflictIds = [idInsumoEfectivo, ...duplicateMasterResult.rows.map((row) => Number(row.id_insumo))]
      .sort((left, right) => left - right)
      .map((id) => `#${id}`)
      .join(', ');
    return {
      ok: false,
      status: 409,
      message: `Conflicto de datos: existen maestros VALIDADO con el mismo nombre (${conflictIds}).`
    };
  }

  const assignmentResult = await pool.query(
    `
      SELECT ia.id_almacen
      FROM public.insumos_almacenes ia
      INNER JOIN public.almacenes a
        ON a.id_almacen = ia.id_almacen
       AND COALESCE(a.estado, true) IS TRUE
      WHERE ia.id_insumo = $1
        AND COALESCE(ia.estado, true) IS TRUE
      LIMIT 1
    `,
    [idInsumoEfectivo]
  );
  if (!assignmentResult.rowCount) {
    return { ok: false, status: 409, message: 'El insumo maestro no tiene almacenes activos.' };
  }

  const unidadResult = await pool.query(
    'SELECT id_unidad_medida FROM public.unidades_medida WHERE id_unidad_medida = $1 LIMIT 1;',
    [data.id_unidad_consumo]
  );
  if (!unidadResult.rowCount) {
    return { ok: false, status: 400, message: 'La unidad de consumo no existe.' };
  }

  const idUnidadBase = idUnidadBaseEfectiva;
  const idUnidadConsumo = toPositiveInt(data.id_unidad_consumo);
  if (idUnidadBase === idUnidadConsumo) {
    return { ok: true };
  }

  const conversionResult = await pool.query(
    `
      SELECT id_presentacion
      FROM public.insumo_presentaciones
      WHERE id_insumo = $1
        AND id_unidad_presentacion = $2
        AND id_unidad_base = $3
        AND estado IS TRUE
        AND uso_receta IS TRUE
        AND cantidad_presentacion > 0
        AND cantidad_base > 0
      ORDER BY id_presentacion
    `,
    [idInsumoEfectivo, idUnidadConsumo, idUnidadBase]
  );
  if (conversionResult.rowCount === 0) {
    return {
      ok: false,
      status: 409,
      message: 'No existe una conversion activa de receta para la unidad de consumo seleccionada.'
    };
  }
  if (conversionResult.rowCount > 1) {
    return {
      ok: false,
      status: 409,
      message: 'Hay mas de una conversion activa de receta para esa unidad. Revisa presentaciones del insumo.'
    };
  }

  return { ok: true };
};

const fetchSalsaInventoryStateById = async (idSalsa) => {
  const result = await pool.query(
    `
      SELECT
        s.id_salsa,
        s.nombre,
        COALESCE(s.estado, true) AS estado,
        s.id_insumo,
        COALESCE(s.cantidad_porcion, 2)::numeric AS cantidad_porcion,
        s.id_unidad_consumo,
        i.nombre_insumo AS insumo_nombre,
        COALESCE(i.estado, true) AS insumo_estado,
        i.id_unidad_medida AS id_unidad_base,
        um_base.nombre AS unidad_base_nombre,
        um_base.simbolo AS unidad_base_simbolo,
        um_consumo.nombre AS unidad_consumo_nombre,
        um_consumo.simbolo AS unidad_consumo_simbolo,
        map.mapping_count,
        map.id_insumo_maestro,
        map.estado_mapeo_maestro,
        i_master.nombre_insumo AS insumo_maestro_nombre,
        COALESCE(i_master.estado, true) AS insumo_maestro_estado,
        i_master.id_unidad_medida AS id_unidad_base_maestro,
        COALESCE(conv.conversiones_aplicables, 0)::int AS conversiones_aplicables
      FROM public.salsas s
      LEFT JOIN public.insumos i ON i.id_insumo = s.id_insumo
      LEFT JOIN public.unidades_medida um_base ON um_base.id_unidad_medida = i.id_unidad_medida
      LEFT JOIN public.unidades_medida um_consumo ON um_consumo.id_unidad_medida = s.id_unidad_consumo
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS mapping_count,
          MIN(imm.id_insumo_maestro)::int AS id_insumo_maestro,
          MIN(imm.estado_migracion) AS estado_mapeo_maestro
        FROM public.insumos_mapeo_maestro imm
        WHERE imm.id_insumo_legacy = i.id_insumo
      ) map ON true
      LEFT JOIN public.insumos i_master
        ON i_master.id_insumo = CASE
          WHEN map.mapping_count = 1 AND UPPER(TRIM(COALESCE(map.estado_mapeo_maestro, ''))) = 'VALIDADO'
            THEN map.id_insumo_maestro
          ELSE NULL
        END
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS conversiones_aplicables
        FROM public.insumo_presentaciones ip
        WHERE ip.id_insumo = COALESCE(i_master.id_insumo, i.id_insumo)
          AND ip.id_unidad_presentacion = s.id_unidad_consumo
          AND ip.id_unidad_base = COALESCE(i_master.id_unidad_medida, i.id_unidad_medida)
          AND ip.estado IS TRUE
          AND ip.uso_receta IS TRUE
          AND ip.cantidad_presentacion > 0
          AND ip.cantidad_base > 0
      ) conv ON true
      WHERE s.id_salsa = $1
      LIMIT 1
    `,
    [idSalsa]
  );
  return result.rowCount ? attachSalsaInventoryState(result.rows[0]) : null;
};

const normalizeRulesPayload = (rows) => {
  if (!Array.isArray(rows)) return { ok: false, message: 'reglas debe ser un arreglo.' };

  const normalized = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const min = toIntOrNull(row.min_unidades, { min: 1, max: 9999 });
    const maxRaw = row.max_unidades;
    const max = (maxRaw === null || maxRaw === undefined || maxRaw === '')
      ? null
      : toIntOrNull(maxRaw, { min: 1, max: 9999 });
    const required = toIntOrNull(row.salsas_requeridas, { min: 0, max: 99 });

    if (min === null) {
      return { ok: false, message: `Regla #${index + 1}: min_unidades debe ser entero >= 1.` };
    }
    if (maxRaw !== null && maxRaw !== undefined && maxRaw !== '' && max === null) {
      return { ok: false, message: `Regla #${index + 1}: max_unidades debe ser entero >= 1 o vacio.` };
    }
    if (max !== null && max < min) {
      return { ok: false, message: `Regla #${index + 1}: max_unidades no puede ser menor que min_unidades.` };
    }
    if (required === null) {
      return { ok: false, message: `Regla #${index + 1}: salsas_requeridas debe ser entero >= 0.` };
    }

    normalized.push({
      min_unidades: min,
      max_unidades: max,
      salsas_requeridas: required
    });
  }

  return { ok: true, data: normalized };
};

const validateRulesConsistency = (rules, allowedSauceCount) => {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { ok: true };
  }

  if (!Number.isInteger(allowedSauceCount) || allowedSauceCount <= 0) {
    return {
      ok: false,
      message: 'Debes seleccionar al menos una salsa permitida antes de guardar reglas por unidades.'
    };
  }

  const sortedRules = [...rules]
    .map((rule) => ({
      min_unidades: Number(rule.min_unidades),
      max_unidades: rule.max_unidades === null ? null : Number(rule.max_unidades),
      salsas_requeridas: Number(rule.salsas_requeridas)
    }))
    .sort((left, right) => left.min_unidades - right.min_unidades);

  for (let index = 0; index < sortedRules.length; index += 1) {
    const currentRule = sortedRules[index];
    if (currentRule.salsas_requeridas > allowedSauceCount) {
      return {
        ok: false,
        message: `Regla #${index + 1}: salsas_requeridas no puede exceder las ${allowedSauceCount} salsas permitidas.`
      };
    }

    if (index === 0) continue;

    const previousRule = sortedRules[index - 1];
    const previousMax = previousRule.max_unidades === null ? Number.POSITIVE_INFINITY : previousRule.max_unidades;
    if (currentRule.min_unidades <= previousMax) {
      return {
        ok: false,
        message: 'No se permiten rangos traslapados en las reglas de salsas por receta.'
      };
    }
  }

  return { ok: true };
};

router.get('/', checkPermission(MENU_SALSAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const [salsasTieneEstado, salsasTieneNivelPicante, salsasTieneOrden, salsasTieneInsumo, salsasTieneCantidadPorcion, salsasTieneUnidadConsumo] = await Promise.all([
      hasColumn('salsas', 'estado'),
      hasColumn('salsas', 'nivel_picante'),
      hasColumn('salsas', 'orden'),
      hasColumn('salsas', 'id_insumo'),
      hasColumn('salsas', 'cantidad_porcion'),
      hasColumn('salsas', 'id_unidad_consumo')
    ]);

    const includeInactive = shouldIncludeInactive(req.query);
    const onlyInactive = shouldOnlyInactive(req.query);
    const page = Math.max(1, toPositiveInt(req.query?.page) || 1);
    const rawLimit = toPositiveInt(req.query?.limit) || 10;
    const limit = Math.min(Math.max(rawLimit, 1), 100);
    const offset = (page - 1) * limit;
    const search = normalizeText(req.query?.search);
    const nivelPicante = req.query?.nivel_picante === undefined || req.query?.nivel_picante === ''
      ? null
      : toIntOrNull(req.query.nivel_picante, { min: 0, max: 5 });
    const sortDir = normalizeAdminStatus(req.query?.sort_dir) === 'DESC' ? 'DESC' : 'ASC';
    const sortBy = normalizeText(req.query?.sort_by || 'orden').toLowerCase();
    const sortColumns = {
      id_salsa: 's.id_salsa',
      nombre: 's.nombre',
      nivel_picante: salsasTieneNivelPicante ? 'COALESCE(s.nivel_picante, 0)' : '0',
      orden: salsasTieneOrden ? 'COALESCE(s.orden, 2147483647)' : 's.nombre'
    };
    const sortColumn = sortColumns[sortBy] || sortColumns.orden;
    const params = [];
    const whereParts = [];
    const addParam = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (salsasTieneEstado) {
      if (onlyInactive) {
        whereParts.push('COALESCE(s.estado, true) = false');
      } else if (!includeInactive) {
        whereParts.push('COALESCE(s.estado, true) = true');
      }
    }
    if (search) {
      const searchParam = addParam(`%${search}%`);
      whereParts.push(`(
        s.nombre ILIKE ${searchParam}
        OR s.id_salsa::text ILIKE ${searchParam}
        OR i.nombre_insumo ILIKE ${searchParam}
      )`);
    }
    if (nivelPicante !== null) {
      if (salsasTieneNivelPicante) {
        whereParts.push(`COALESCE(s.nivel_picante, 0) = ${addParam(nivelPicante)}`);
      } else if (nivelPicante !== 0) {
        whereParts.push('false');
      }
    }
    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const countParams = [...params];
    const limitParam = addParam(limit);
    const offsetParam = addParam(offset);

    const baseJoins = `
      LEFT JOIN public.insumos i
        ON i.id_insumo = ${salsasTieneInsumo ? 's.id_insumo' : 'NULL'}
      LEFT JOIN public.unidades_medida um_base
        ON um_base.id_unidad_medida = i.id_unidad_medida
      LEFT JOIN public.unidades_medida um_consumo
        ON um_consumo.id_unidad_medida = ${salsasTieneUnidadConsumo ? 's.id_unidad_consumo' : 'NULL'}
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS mapping_count,
          MIN(imm.id_insumo_maestro)::int AS id_insumo_maestro,
          MIN(imm.estado_migracion) AS estado_mapeo_maestro
        FROM public.insumos_mapeo_maestro imm
        WHERE imm.id_insumo_legacy = i.id_insumo
      ) map ON true
      LEFT JOIN public.insumos i_master
        ON i_master.id_insumo = CASE
          WHEN map.mapping_count = 1 AND UPPER(TRIM(COALESCE(map.estado_mapeo_maestro, ''))) = 'VALIDADO'
            THEN map.id_insumo_maestro
          ELSE NULL
        END
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS conversiones_aplicables
        FROM public.insumo_presentaciones ip
        WHERE ip.id_insumo = COALESCE(i_master.id_insumo, i.id_insumo)
          AND ip.id_unidad_presentacion = ${salsasTieneUnidadConsumo ? 's.id_unidad_consumo' : 'NULL'}
          AND ip.id_unidad_base = COALESCE(i_master.id_unidad_medida, i.id_unidad_medida)
          AND ip.estado IS TRUE
          AND ip.uso_receta IS TRUE
          AND ip.cantidad_presentacion > 0
          AND ip.cantidad_base > 0
      ) conv ON true
    `;

    const selectSalsaInventoryFields = `
      SELECT
        s.id_salsa,
        s.nombre,
        ${salsasTieneNivelPicante ? 'COALESCE(s.nivel_picante, 0)' : '0'} AS nivel_picante,
        ${salsasTieneOrden ? 'COALESCE(s.orden, 0)' : '0'} AS orden,
        ${salsasTieneEstado ? 'COALESCE(s.estado, true)' : 'true'} AS estado,
        ${salsasTieneInsumo ? 's.id_insumo' : 'NULL::int'} AS id_insumo,
        ${salsasTieneCantidadPorcion ? 'COALESCE(s.cantidad_porcion, 2)::numeric' : '2::numeric'} AS cantidad_porcion,
        ${salsasTieneUnidadConsumo ? 's.id_unidad_consumo' : 'NULL::int'} AS id_unidad_consumo,
        i.nombre_insumo AS insumo_nombre,
        COALESCE(i.estado, true) AS insumo_estado,
        i.id_unidad_medida AS id_unidad_base,
        um_base.nombre AS unidad_base_nombre,
        um_base.simbolo AS unidad_base_simbolo,
        um_consumo.nombre AS unidad_consumo_nombre,
        um_consumo.simbolo AS unidad_consumo_simbolo,
        map.mapping_count,
        map.id_insumo_maestro,
        map.estado_mapeo_maestro,
        i_master.nombre_insumo AS insumo_maestro_nombre,
        COALESCE(i_master.estado, true) AS insumo_maestro_estado,
        i_master.id_unidad_medida AS id_unidad_base_maestro,
        COALESCE(conv.conversiones_aplicables, 0)::int AS conversiones_aplicables
    `;

    const [countResult, result, summaryResult, nextOrderResult] = await Promise.all([
      pool.query(
        `
          SELECT COUNT(*)::int AS total
          FROM salsas s
          ${baseJoins}
          ${whereClause};
        `,
        countParams
      ),
      pool.query(
      `
        ${selectSalsaInventoryFields}
        FROM salsas s
        ${baseJoins}
        ${whereClause}
        ORDER BY ${sortColumn} ${sortDir}, s.nombre ASC, s.id_salsa ASC
        LIMIT ${limitParam}
        OFFSET ${offsetParam};
      `,
        params
      ),
      pool.query(
        `
          ${selectSalsaInventoryFields}
          FROM salsas s
          ${baseJoins}
          ${whereClause};
        `,
        countParams
      ),
      pool.query(
        `
          SELECT ${salsasTieneOrden ? 'COALESCE(MAX(s.orden), 0) + 1' : '1'} AS next_order
          FROM salsas s;
        `
      )
    ]);

    const total = Number(countResult.rows?.[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const summaryRows = (summaryResult.rows || []).map(attachSalsaInventoryState);
    const activeSummaryRows = summaryRows.filter((row) => row.estado === undefined || row.estado === true);
    const listas = activeSummaryRows.filter((row) => row.inventario_estado === 'LISTA').length;
    const pendientes = activeSummaryRows.filter((row) => row.inventario_estado === 'PENDIENTE' || !row.inventario_estado).length;
    const summary = {
      activas: activeSummaryRows.length,
      listas,
      pendientes,
      errores: Math.max(0, activeSummaryRows.length - listas - pendientes)
    };
    return res.status(200).json({
      items: (result.rows || []).map(attachSalsaInventoryState),
      pagination: {
        page,
        limit,
        total,
        totalPages
      },
      summary,
      next_order: Math.max(1, Number(nextOrderResult.rows?.[0]?.next_order || 1))
    });
  } catch (err) {
    console.error('Error al listar salsas admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.get('/catalogos/recetas', checkPermission(MENU_SALSAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const recetasTieneEstado = await hasColumn('recetas', 'estado');
    const result = await pool.query(
      `
        SELECT
          r.id_receta,
          r.nombre_receta,
          r.id_tipo_departamento,
          ${recetasTieneEstado ? 'COALESCE(r.estado, true)' : 'true'} AS estado
        FROM recetas r
        ${recetasTieneEstado ? 'WHERE COALESCE(r.estado, true) = true' : ''}
        ORDER BY r.nombre_receta ASC, r.id_receta ASC;
      `
    );
    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar catalogo de recetas para salsas:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.get('/catalogos/insumos', checkPermission(MENU_SALSAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await queryCatalogoMaestroView(
      pool,
      'public.vw_insumos_maestros_almacen',
      `
        WITH mapping_summary AS (
          SELECT
            imm.id_insumo_maestro,
            COUNT(*)::int AS mapping_count,
            COALESCE(
              ARRAY_AGG(DISTINCT imm.id_insumo_legacy ORDER BY imm.id_insumo_legacy),
              ARRAY[]::integer[]
            ) AS ids_insumo_legacy,
            COALESCE(
              ARRAY_AGG(
                DISTINCT UPPER(TRIM(COALESCE(imm.estado_migracion, 'PENDIENTE')))
                ORDER BY UPPER(TRIM(COALESCE(imm.estado_migracion, 'PENDIENTE')))
              ),
              ARRAY[]::text[]
            ) AS estados_mapeo_maestro
          FROM public.insumos_mapeo_maestro imm
          GROUP BY imm.id_insumo_maestro
        )
        SELECT
          v.id_insumo_maestro AS id_insumo,
          v.id_insumo_maestro,
          v.nombre_insumo AS nombre,
          v.id_almacen,
          v.id_unidad_medida,
          um.nombre AS unidad_nombre,
          um.simbolo AS unidad_simbolo,
          COALESCE(NULLIF(TRIM(um.simbolo), ''), NULLIF(TRIM(um.nombre), ''), 'unidad') AS unidad_etiqueta,
          v.id_categoria_insumo,
          ci.nombre_categoria AS categoria_nombre,
          (v.estado_global IS TRUE AND v.estado_local IS TRUE) AS estado,
          COALESCE(ms.mapping_count, 0)::int AS mapping_count,
          COALESCE(ms.ids_insumo_legacy, ARRAY[]::integer[]) AS ids_insumo_legacy,
          COALESCE(ms.estados_mapeo_maestro, ARRAY[]::text[]) AS estados_mapeo_maestro,
          COALESCE(conv.conversiones, '[]'::jsonb) AS conversiones_disponibles,
          COALESCE(warehouses.almacenes, '[]'::jsonb) AS almacenes_disponibles
        FROM public.vw_insumos_maestros_almacen v
        LEFT JOIN public.unidades_medida um
          ON um.id_unidad_medida = v.id_unidad_medida
        LEFT JOIN public.categorias_insumos ci
          ON ci.id_categoria_insumo = v.id_categoria_insumo
        LEFT JOIN mapping_summary ms
          ON ms.id_insumo_maestro = v.id_insumo_maestro
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_presentacion', ip.id_presentacion,
              'id_unidad_consumo', ip.id_unidad_presentacion,
              'unidad_nombre', umc.nombre,
              'unidad_simbolo', umc.simbolo,
              'cantidad_presentacion', ip.cantidad_presentacion,
              'cantidad_base', ip.cantidad_base,
              'id_unidad_base', ip.id_unidad_base
            )
            ORDER BY umc.nombre ASC, ip.id_presentacion ASC
          ) AS conversiones
          FROM public.insumo_presentaciones ip
          LEFT JOIN public.unidades_medida umc
            ON umc.id_unidad_medida = ip.id_unidad_presentacion
          WHERE ip.id_insumo = v.id_insumo_maestro
            AND ip.estado IS TRUE
            AND ip.uso_receta IS TRUE
            AND ip.cantidad_presentacion > 0
            AND ip.cantidad_base > 0
        ) conv ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_almacen', ia.id_almacen,
              'id_sucursal', a.id_sucursal,
              'cantidad', ia.cantidad,
              'stock_minimo', ia.stock_minimo
            )
            ORDER BY ia.id_almacen
          ) AS almacenes
          FROM public.insumos_almacenes ia
          INNER JOIN public.almacenes a
            ON a.id_almacen = ia.id_almacen
           AND COALESCE(a.estado, true) IS TRUE
          WHERE ia.id_insumo = v.id_insumo_maestro
            AND COALESCE(ia.estado, true) IS TRUE
        ) warehouses ON true
        WHERE v.estado_global IS TRUE
          AND v.estado_local IS TRUE
        ORDER BY
          CASE WHEN UPPER(TRIM(COALESCE(ci.nombre_categoria, ''))) = 'SALSAS Y ADEREZOS' THEN 0 ELSE 1 END,
          ci.nombre_categoria ASC NULLS LAST,
          v.nombre_insumo ASC,
          v.id_insumo_maestro ASC,
          v.id_almacen ASC;
      `
    );
    const grouped = {
      recomendados: [],
      otros_disponibles: [],
      bloqueados: []
    };

    for (const item of buildAdminSalsasInsumosCatalog(result.rows || [])) {
      if (!item.seleccionable) {
        grouped.bloqueados.push(item);
      } else if (normalizeAdminStatus(item.categoria) === 'SALSAS Y ADEREZOS') {
        grouped.recomendados.push(item);
      } else {
        grouped.otros_disponibles.push(item);
      }
    }

    return res.status(200).json(grouped);
  } catch (err) {
    if (isCatalogoMaestroViewMissingError(err)) {
      logCatalogoMaestroViewMissing('Catalogo de insumos para salsas', err);
      return sendCatalogoMaestroViewMissingResponse(res);
    }
    console.error('Error al listar catalogo de insumos para salsas:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.get('/recetas/:id_receta/config', checkPermission(MENU_SALSAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idReceta = toPositiveInt(req.params.id_receta);
    if (!idReceta) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const [salsasTieneEstado, salsasTieneNivelPicante, salsasTieneOrden, salsasTieneInsumo, salsasTieneCantidadPorcion, salsasTieneUnidadConsumo, recetaSalsaTieneEstado, reglasTieneEstado] = await Promise.all([
      hasColumn('salsas', 'estado'),
      hasColumn('salsas', 'nivel_picante'),
      hasColumn('salsas', 'orden'),
      hasColumn('salsas', 'id_insumo'),
      hasColumn('salsas', 'cantidad_porcion'),
      hasColumn('salsas', 'id_unidad_consumo'),
      hasColumn('receta_salsa', 'estado'),
      hasColumn('reglas_salsas_receta', 'estado')
    ]);

    const configResult = await pool.query(
      `
        WITH receta_row AS (
          SELECT r.id_receta, r.nombre_receta
          FROM recetas r
          WHERE r.id_receta = $1
          LIMIT 1
        ),
        catalogo AS (
          SELECT
            s.id_salsa,
            s.nombre,
            ${salsasTieneNivelPicante ? 'COALESCE(s.nivel_picante, 0)' : '0'} AS nivel_picante,
            ${salsasTieneOrden ? 'COALESCE(s.orden, 0)' : '0'} AS orden,
            ${salsasTieneEstado ? 'COALESCE(s.estado, true)' : 'true'} AS estado,
            ${salsasTieneInsumo ? 's.id_insumo' : 'NULL::int'} AS id_insumo,
            ${salsasTieneCantidadPorcion ? 'COALESCE(s.cantidad_porcion, 2)::numeric' : '2::numeric'} AS cantidad_porcion,
            ${salsasTieneUnidadConsumo ? 's.id_unidad_consumo' : 'NULL::int'} AS id_unidad_consumo,
            i.nombre_insumo AS insumo_nombre,
            COALESCE(i.estado, true) AS insumo_estado,
            i.id_unidad_medida AS id_unidad_base,
            um_base.nombre AS unidad_base_nombre,
            um_base.simbolo AS unidad_base_simbolo,
            um_consumo.nombre AS unidad_consumo_nombre,
            um_consumo.simbolo AS unidad_consumo_simbolo,
            map.mapping_count,
            map.id_insumo_maestro,
            map.estado_mapeo_maestro,
            i_master.nombre_insumo AS insumo_maestro_nombre,
            COALESCE(i_master.estado, true) AS insumo_maestro_estado,
            i_master.id_unidad_medida AS id_unidad_base_maestro,
            COALESCE(conv.conversiones_aplicables, 0)::int AS conversiones_aplicables,
            ${salsasTieneOrden ? 'COALESCE(s.orden, 2147483647)' : '0'} AS sort_orden
          FROM salsas s
          LEFT JOIN public.insumos i
            ON i.id_insumo = ${salsasTieneInsumo ? 's.id_insumo' : 'NULL'}
          LEFT JOIN public.unidades_medida um_base
            ON um_base.id_unidad_medida = i.id_unidad_medida
          LEFT JOIN public.unidades_medida um_consumo
            ON um_consumo.id_unidad_medida = ${salsasTieneUnidadConsumo ? 's.id_unidad_consumo' : 'NULL'}
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS mapping_count,
              MIN(imm.id_insumo_maestro)::int AS id_insumo_maestro,
              MIN(imm.estado_migracion) AS estado_mapeo_maestro
            FROM public.insumos_mapeo_maestro imm
            WHERE imm.id_insumo_legacy = i.id_insumo
          ) map ON true
          LEFT JOIN public.insumos i_master
            ON i_master.id_insumo = CASE
              WHEN map.mapping_count = 1 AND UPPER(TRIM(COALESCE(map.estado_mapeo_maestro, ''))) = 'VALIDADO'
                THEN map.id_insumo_maestro
              ELSE NULL
            END
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS conversiones_aplicables
            FROM public.insumo_presentaciones ip
            WHERE ip.id_insumo = COALESCE(i_master.id_insumo, i.id_insumo)
              AND ip.id_unidad_presentacion = ${salsasTieneUnidadConsumo ? 's.id_unidad_consumo' : 'NULL'}
              AND ip.id_unidad_base = COALESCE(i_master.id_unidad_medida, i.id_unidad_medida)
              AND ip.estado IS TRUE
              AND ip.uso_receta IS TRUE
              AND ip.cantidad_presentacion > 0
              AND ip.cantidad_base > 0
          ) conv ON true
          ${salsasTieneEstado ? 'WHERE COALESCE(s.estado, true) = true' : ''}
        ),
        selected AS (
          SELECT rs.id_salsa
          FROM receta_salsa rs
          INNER JOIN salsas s
            ON s.id_salsa = rs.id_salsa
          WHERE rs.id_receta = $1
            ${recetaSalsaTieneEstado ? 'AND COALESCE(rs.estado, true) = true' : ''}
            ${salsasTieneEstado ? 'AND COALESCE(s.estado, true) = true' : ''}
        ),
        rules AS (
          SELECT
            r.id_regla,
            r.id_receta,
            r.min_unidades,
            r.max_unidades,
            r.salsas_requeridas,
            ${reglasTieneEstado ? 'COALESCE(r.estado, true)' : 'true'} AS estado
          FROM reglas_salsas_receta r
          WHERE r.id_receta = $1
            ${reglasTieneEstado ? 'AND COALESCE(r.estado, true) = true' : ''}
        )
        SELECT
          (
            SELECT jsonb_build_object(
              'id_receta', rr.id_receta,
              'nombre_receta', rr.nombre_receta
            )
            FROM receta_row rr
          ) AS receta,
          COALESCE((
            SELECT jsonb_agg(to_jsonb(c) - 'sort_orden' ORDER BY ${salsasTieneOrden ? 'c.sort_orden,' : ''} c.nombre ASC, c.id_salsa ASC)
            FROM catalogo c
          ), '[]'::jsonb) AS salsas_catalogo,
          COALESCE((
            SELECT jsonb_agg(s.id_salsa ORDER BY s.id_salsa ASC)
            FROM selected s
          ), '[]'::jsonb) AS salsas_asignadas,
          COALESCE((
            SELECT jsonb_agg(to_jsonb(r) ORDER BY r.min_unidades ASC, r.max_unidades ASC NULLS LAST, r.id_regla ASC)
            FROM rules r
          ), '[]'::jsonb) AS reglas;
      `,
      [idReceta]
    );

    const config = configResult.rows?.[0] || {};
    if (!config.receta) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    const salsasCatalogo = (Array.isArray(config.salsas_catalogo) ? config.salsas_catalogo : [])
      .map(attachSalsaInventoryState);

    return res.status(200).json({
      receta: {
        id_receta: Number(config.receta.id_receta),
        nombre_receta: config.receta.nombre_receta
      },
      salsas_catalogo: salsasCatalogo,
      salsas_asignadas: (Array.isArray(config.salsas_asignadas) ? config.salsas_asignadas : []).map((idSalsa) => Number(idSalsa)),
      reglas: Array.isArray(config.reglas) ? config.reglas : []
    });
  } catch (err) {
    console.error('Error al obtener configuracion de salsas por receta:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.post('/', checkPermission(MENU_SALSAS_CREATE_PERMISSIONS), async (req, res) => {
  let client = null;
  let transactionStarted = false;
  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    // Transicion segura: id_usuario del cliente se ignora silenciosamente.
    const payloadSinUsuario = { ...(req.body || {}) };
    delete payloadSinUsuario.id_usuario;
    const normalizacion = normalizeSalsaPayload(payloadSinUsuario, { partial: false });
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const data = normalizacion.data;
    const [salsasTieneEstado, salsasTieneNivelPicante, salsasTieneOrden, idUsuarioMeta, salsasTieneFechaCreacion, salsasTieneFechaModificacion] = await Promise.all([
      hasColumn('salsas', 'estado'),
      hasColumn('salsas', 'nivel_picante'),
      hasColumn('salsas', 'orden'),
      getColumnMeta('salsas', 'id_usuario'),
      hasColumn('salsas', 'fecha_creacion'),
      hasColumn('salsas', 'fecha_modificacion')
    ]);

    const duplicateResult = await pool.query(
      `
        SELECT id_salsa
        FROM salsas
        WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))
          ${salsasTieneEstado ? 'AND COALESCE(estado, true) = true' : ''}
        LIMIT 1;
      `,
      [data.nombre]
    );
    if (duplicateResult.rowCount > 0) {
      return res.status(409).json({ error: true, message: 'Ya existe una salsa activa con ese nombre.' });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    let resolvedUserId = actorUserId;
    if (resolvedUserId) {
      const userExists = await ensureUsuarioExists(resolvedUserId);
      if (!userExists) {
        return res.status(400).json({ error: true, message: 'id_usuario no existe en usuarios.' });
      }
    }

    const insertData = {
      nombre: data.nombre
    };

    if (salsasTieneNivelPicante) insertData.nivel_picante = data.nivel_picante ?? 0;
    if (salsasTieneOrden && data.orden !== null) insertData.orden = data.orden;
    if (salsasTieneEstado) insertData.estado = data.estado === null ? true : data.estado;
    if (idUsuarioMeta.exists && resolvedUserId) insertData.id_usuario = resolvedUserId;

    const rawInsert = {};
    if (salsasTieneFechaCreacion) rawInsert.fecha_creacion = "timezone('America/Tegucigalpa', now())";
    if (salsasTieneFechaModificacion) rawInsert.fecha_modificacion = "timezone('America/Tegucigalpa', now())";

    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    if (salsasTieneOrden && data.orden === null) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('admin_salsas_orden'))");
      const nextOrderResult = await client.query('SELECT COALESCE(MAX(orden), 0) + 1 AS next_order FROM salsas;');
      insertData.orden = Math.max(1, Number(nextOrderResult.rows?.[0]?.next_order || 1));
    }

    const insertStatement = buildInsertStatement({
      tableName: 'salsas',
      data: insertData,
      raw: rawInsert,
      returning: 'id_salsa'
    });

    const createdResult = await client.query(insertStatement.text, insertStatement.params);
    await client.query('COMMIT');
    transactionStarted = false;
    invalidateVentasComplementCatalogCache('crear salsa');
    return res.status(201).json({
      error: false,
      message: 'Salsa creada correctamente.',
      data: {
        id_salsa: Number(createdResult.rows?.[0]?.id_salsa || 0)
      }
    });
  } catch (err) {
    if (transactionStarted && client) {
      await client.query('ROLLBACK');
    }
    console.error('Error al crear salsa admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    if (client) client.release();
  }
});

router.put('/:id_salsa', checkPermission(MENU_SALSAS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const idSalsa = toPositiveInt(req.params.id_salsa);
    if (!idSalsa) {
      return res.status(400).json({ error: true, message: 'id_salsa invalido.' });
    }

    const salsaExiste = await pool.query('SELECT id_salsa FROM salsas WHERE id_salsa = $1 LIMIT 1;', [idSalsa]);
    if (salsaExiste.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Salsa no encontrada.' });
    }

    // Transicion segura: id_usuario del cliente se ignora silenciosamente.
    const payloadSinUsuario = { ...(req.body || {}) };
    delete payloadSinUsuario.id_usuario;
    const normalizacion = normalizeSalsaPayload(payloadSinUsuario, { partial: false });
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const data = normalizacion.data;
    const [salsasTieneEstado, salsasTieneNivelPicante, salsasTieneOrden, idUsuarioMeta, salsasTieneFechaModificacion] = await Promise.all([
      hasColumn('salsas', 'estado'),
      hasColumn('salsas', 'nivel_picante'),
      hasColumn('salsas', 'orden'),
      getColumnMeta('salsas', 'id_usuario'),
      hasColumn('salsas', 'fecha_modificacion')
    ]);

    const duplicateResult = await pool.query(
      `
        SELECT id_salsa
        FROM salsas
        WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1))
          AND id_salsa <> $2
          ${salsasTieneEstado ? 'AND COALESCE(estado, true) = true' : ''}
        LIMIT 1;
      `,
      [data.nombre, idSalsa]
    );
    if (duplicateResult.rowCount > 0) {
      return res.status(409).json({ error: true, message: 'Ya existe otra salsa activa con ese nombre.' });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    let resolvedUserId = actorUserId;
    if (idUsuarioMeta.exists && resolvedUserId) {
      const userExists = await ensureUsuarioExists(resolvedUserId);
      if (!userExists) {
        return res.status(400).json({ error: true, message: 'id_usuario no existe en usuarios.' });
      }
    }

    const updates = [];
    const params = [];
    const addUpdate = (statement, value) => {
      params.push(value);
      updates.push(`${statement} = $${params.length}`);
    };

    addUpdate('nombre', data.nombre);
    if (salsasTieneNivelPicante) addUpdate('nivel_picante', data.nivel_picante ?? 0);
    if (salsasTieneOrden) addUpdate('orden', data.orden ?? 0);
    if (salsasTieneEstado && data.estado !== null) addUpdate('estado', data.estado);
    if (idUsuarioMeta.exists && resolvedUserId) addUpdate('id_usuario', resolvedUserId);
    if (salsasTieneFechaModificacion) {
      updates.push("fecha_modificacion = timezone('America/Tegucigalpa', now())");
    }

    params.push(idSalsa);
    await pool.query(
      `
        UPDATE salsas
        SET ${updates.join(', ')}
        WHERE id_salsa = $${params.length};
      `,
      params
    );

    invalidateVentasComplementCatalogCache('actualizar salsa');
    return res.status(200).json({ error: false, message: 'Salsa actualizada correctamente.' });
  } catch (err) {
    console.error('Error al actualizar salsa admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.put('/:id_salsa/inventario', checkPermission(MENU_SALSAS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const idSalsa = toPositiveInt(req.params.id_salsa);
    if (!idSalsa) {
      return res.status(400).json({ error: true, message: 'id_salsa invalido.' });
    }

    const salsaExiste = await pool.query('SELECT id_salsa FROM salsas WHERE id_salsa = $1 LIMIT 1;', [idSalsa]);
    if (salsaExiste.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Salsa no encontrada.' });
    }

    const [salsasTieneInsumo, salsasTieneCantidadPorcion, salsasTieneUnidadConsumo, salsasTieneFechaModificacion] = await Promise.all([
      hasColumn('salsas', 'id_insumo'),
      hasColumn('salsas', 'cantidad_porcion'),
      hasColumn('salsas', 'id_unidad_consumo'),
      hasColumn('salsas', 'fecha_modificacion')
    ]);

    if (!salsasTieneInsumo || !salsasTieneUnidadConsumo || !salsasTieneCantidadPorcion) {
      return res.status(400).json({ error: true, message: 'Tu esquema no soporta inventario de salsas. Aplica la migracion versionada.' });
    }

    const normalizacion = normalizeSalsaInventoryPayload(req.body || {});
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const data = normalizacion.data;
    if (data.id_insumo) {
      const inventoryValidation = await validateSalsaInventoryConfig(data);
      if (!inventoryValidation.ok) {
        return res.status(inventoryValidation.status || 400).json({ error: true, message: inventoryValidation.message });
      }
    }

    const updates = [
      'id_insumo = $1',
      'cantidad_porcion = $2',
      'id_unidad_consumo = $3'
    ];
    const params = [data.id_insumo, data.cantidad_porcion, data.id_unidad_consumo];
    if (salsasTieneFechaModificacion) {
      updates.push("fecha_modificacion = timezone('America/Tegucigalpa', now())");
    }
    params.push(idSalsa);

    await pool.query(
      `
        UPDATE salsas
        SET ${updates.join(', ')}
        WHERE id_salsa = $${params.length};
      `,
      params
    );

    invalidateVentasComplementCatalogCache('configurar inventario de salsa');
    const inventoryState = await fetchSalsaInventoryStateById(idSalsa);
    return res.status(200).json({
      error: false,
      message: data.id_insumo ? 'Consumo de salsa configurado correctamente.' : 'Configuracion de consumo retirada correctamente.',
      data: inventoryState
    });
  } catch (err) {
    console.error('Error al configurar inventario de salsa admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.patch('/:id_salsa/estado', checkPermission(MENU_SALSAS_STATE_PERMISSIONS), async (req, res) => {
  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const idSalsa = toPositiveInt(req.params.id_salsa);
    if (!idSalsa) {
      return res.status(400).json({ error: true, message: 'id_salsa invalido.' });
    }

    const estado = parseBoolean(req.body?.estado);
    if (estado === null) {
      return res.status(400).json({ error: true, message: 'estado debe ser booleano.' });
    }

    const [salsasTieneEstado, idUsuarioMeta, salsasTieneFechaModificacion] = await Promise.all([
      hasColumn('salsas', 'estado'),
      getColumnMeta('salsas', 'id_usuario'),
      hasColumn('salsas', 'fecha_modificacion')
    ]);

    if (!salsasTieneEstado) {
      return res.status(400).json({ error: true, message: 'Tu esquema no soporta cambiar estado en salsas.' });
    }

    const salsaExiste = await pool.query('SELECT id_salsa FROM salsas WHERE id_salsa = $1 LIMIT 1;', [idSalsa]);
    if (salsaExiste.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Salsa no encontrada.' });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    let resolvedUserId = actorUserId;
    if (idUsuarioMeta.exists && resolvedUserId) {
      const userExists = await ensureUsuarioExists(resolvedUserId);
      if (!userExists) {
        return res.status(400).json({ error: true, message: 'id_usuario no existe en usuarios.' });
      }
    }

    const updates = ['estado = $1'];
    const params = [estado];

    if (idUsuarioMeta.exists && resolvedUserId) {
      params.push(resolvedUserId);
      updates.push(`id_usuario = $${params.length}`);
    }
    if (salsasTieneFechaModificacion) {
      updates.push("fecha_modificacion = timezone('America/Tegucigalpa', now())");
    }

    params.push(idSalsa);
    await pool.query(
      `
        UPDATE salsas
        SET ${updates.join(', ')}
        WHERE id_salsa = $${params.length};
      `,
      params
    );

    invalidateVentasComplementCatalogCache('cambiar estado de salsa');
    return res.status(200).json({ error: false, message: 'Estado de salsa actualizado correctamente.' });
  } catch (err) {
    console.error('Error al cambiar estado de salsa admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.put('/recetas/:id_receta/config', checkPermission(MENU_SALSAS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const idReceta = toPositiveInt(req.params.id_receta);
    if (!idReceta) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const receta = await ensureRecetaExists(idReceta);
    if (!receta) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    const salsasAsignadas = toUniquePositiveIntArray(
      req.body?.salsas_asignadas ?? req.body?.salsas ?? []
    );

    const reglasNormalizadas = normalizeRulesPayload(req.body?.reglas ?? []);
    if (!reglasNormalizadas.ok) {
      return res.status(400).json({ error: true, message: reglasNormalizadas.message });
    }

    const reglas = reglasNormalizadas.data;
    const reglasConsistency = validateRulesConsistency(reglas, salsasAsignadas.length);
    if (!reglasConsistency.ok) {
      return res.status(400).json({ error: true, message: reglasConsistency.message });
    }

    const [salsasTieneEstado, recetaSalsaTieneEstado, recetaSalsaTieneUsuario, recetaSalsaTieneFechaCreacion, recetaSalsaTieneFechaModificacion, reglasTieneEstado, reglasTieneUsuario, reglasTieneFechaCreacion, reglasTieneFechaModificacion] = await Promise.all([
      hasColumn('salsas', 'estado'),
      hasColumn('receta_salsa', 'estado'),
      hasColumn('receta_salsa', 'id_usuario'),
      hasColumn('receta_salsa', 'fecha_creacion'),
      hasColumn('receta_salsa', 'fecha_modificacion'),
      hasColumn('reglas_salsas_receta', 'estado'),
      hasColumn('reglas_salsas_receta', 'id_usuario'),
      hasColumn('reglas_salsas_receta', 'fecha_creacion'),
      hasColumn('reglas_salsas_receta', 'fecha_modificacion')
    ]);

    if (salsasAsignadas.length > 0) {
      const validSaucesResult = await pool.query(
        `
          SELECT
            s.id_salsa,
            s.nombre,
            ${salsasTieneEstado ? 'COALESCE(s.estado, true)' : 'true'} AS estado,
            s.id_insumo,
            COALESCE(s.cantidad_porcion, 2)::numeric AS cantidad_porcion,
            s.id_unidad_consumo,
            i.nombre_insumo AS insumo_nombre,
            COALESCE(i.estado, true) AS insumo_estado,
            i.id_unidad_medida AS id_unidad_base,
            um_consumo.nombre AS unidad_consumo_nombre,
            um_consumo.simbolo AS unidad_consumo_simbolo,
            map.mapping_count,
            map.id_insumo_maestro,
            map.estado_mapeo_maestro,
            i_master.nombre_insumo AS insumo_maestro_nombre,
            COALESCE(i_master.estado, true) AS insumo_maestro_estado,
            i_master.id_unidad_medida AS id_unidad_base_maestro,
            COALESCE(conv.conversiones_aplicables, 0)::int AS conversiones_aplicables
          FROM salsas s
          LEFT JOIN public.insumos i
            ON i.id_insumo = s.id_insumo
          LEFT JOIN public.unidades_medida um_consumo
            ON um_consumo.id_unidad_medida = s.id_unidad_consumo
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS mapping_count,
              MIN(imm.id_insumo_maestro)::int AS id_insumo_maestro,
              MIN(imm.estado_migracion) AS estado_mapeo_maestro
            FROM public.insumos_mapeo_maestro imm
            WHERE imm.id_insumo_legacy = i.id_insumo
          ) map ON true
          LEFT JOIN public.insumos i_master
            ON i_master.id_insumo = CASE
              WHEN map.mapping_count = 1 AND UPPER(TRIM(COALESCE(map.estado_mapeo_maestro, ''))) = 'VALIDADO'
                THEN map.id_insumo_maestro
              ELSE NULL
            END
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS conversiones_aplicables
            FROM public.insumo_presentaciones ip
            WHERE ip.id_insumo = COALESCE(i_master.id_insumo, i.id_insumo)
              AND ip.id_unidad_presentacion = s.id_unidad_consumo
              AND ip.id_unidad_base = COALESCE(i_master.id_unidad_medida, i.id_unidad_medida)
              AND ip.estado IS TRUE
              AND ip.uso_receta IS TRUE
              AND ip.cantidad_presentacion > 0
              AND ip.cantidad_base > 0
          ) conv ON true
          WHERE s.id_salsa = ANY($1::int[])
            ${salsasTieneEstado ? 'AND COALESCE(s.estado, true) = true' : ''}
          ORDER BY id_salsa;
        `,
        [salsasAsignadas]
      );

      const validSauceIds = new Set((validSaucesResult.rows || []).map((row) => Number(row.id_salsa)));
      const invalidSauceId = salsasAsignadas.find((idSalsa) => !validSauceIds.has(idSalsa));
      if (invalidSauceId) {
        return res.status(400).json({
          error: true,
          message: `La salsa ${invalidSauceId} no existe o esta inactiva.`
        });
      }
      const invalidInventorySauce = (validSaucesResult.rows || [])
        .map(attachSalsaInventoryState)
        .find((row) => row.puede_asignarse_receta !== true);
      if (invalidInventorySauce) {
        return res.status(409).json({
          error: true,
          message: `La salsa ${invalidInventorySauce.nombre || invalidInventorySauce.id_salsa} no puede asignarse hasta completar inventario: ${invalidInventorySauce.inventario_mensaje || getInventoryStateLabel(invalidInventorySauce.inventario_estado)}.`
        });
      }
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    let resolvedUserId = actorUserId;
    if ((recetaSalsaTieneUsuario || reglasTieneUsuario) && resolvedUserId) {
      const userExists = await ensureUsuarioExists(resolvedUserId);
      if (!userExists) {
        return res.status(400).json({ error: true, message: 'id_usuario no existe en usuarios.' });
      }
    }

    await client.query('BEGIN');

    // Sincroniza receta_salsa desde UI: se reemplaza por el set actual.
    await client.query('DELETE FROM receta_salsa WHERE id_receta = $1;', [idReceta]);
    if (salsasAsignadas.length > 0) {
      const recetaSalsaColumns = [
        { name: 'id_receta', getValue: () => idReceta },
        { name: 'id_salsa', getValue: (idSalsa) => idSalsa }
      ];
      if (recetaSalsaTieneEstado) {
        recetaSalsaColumns.push({ name: 'estado', getValue: () => true });
      }
      if (recetaSalsaTieneUsuario && resolvedUserId) {
        recetaSalsaColumns.push({ name: 'id_usuario', getValue: () => resolvedUserId });
      }
      const recetaSalsaRaw = {};
      if (recetaSalsaTieneFechaCreacion) {
        recetaSalsaRaw.fecha_creacion = "timezone('America/Tegucigalpa', now())";
      }
      if (recetaSalsaTieneFechaModificacion) {
        recetaSalsaRaw.fecha_modificacion = "timezone('America/Tegucigalpa', now())";
      }
      const insertRecetaSalsaStatement = buildBatchInsertStatement({
        tableName: 'receta_salsa',
        rows: salsasAsignadas,
        columns: recetaSalsaColumns,
        raw: recetaSalsaRaw
      });
      if (insertRecetaSalsaStatement) {
        await client.query(insertRecetaSalsaStatement.text, insertRecetaSalsaStatement.params);
      }
    }

    // Sincroniza reglas por receta desde UI: se reemplazan por el set actual.
    await client.query('DELETE FROM reglas_salsas_receta WHERE id_receta = $1;', [idReceta]);
    if (reglas.length > 0) {
      const reglasColumns = [
        { name: 'id_receta', getValue: () => idReceta },
        { name: 'min_unidades', getValue: (rule) => rule.min_unidades },
        { name: 'max_unidades', getValue: (rule) => rule.max_unidades },
        { name: 'salsas_requeridas', getValue: (rule) => rule.salsas_requeridas }
      ];
      if (reglasTieneEstado) {
        reglasColumns.push({ name: 'estado', getValue: () => true });
      }
      if (reglasTieneUsuario && resolvedUserId) {
        reglasColumns.push({ name: 'id_usuario', getValue: () => resolvedUserId });
      }
      const reglasRaw = {};
      if (reglasTieneFechaCreacion) {
        reglasRaw.fecha_creacion = "timezone('America/Tegucigalpa', now())";
      }
      if (reglasTieneFechaModificacion) {
        reglasRaw.fecha_modificacion = "timezone('America/Tegucigalpa', now())";
      }
      const insertReglasStatement = buildBatchInsertStatement({
        tableName: 'reglas_salsas_receta',
        rows: reglas,
        columns: reglasColumns,
        raw: reglasRaw
      });
      if (insertReglasStatement) {
        await client.query(insertReglasStatement.text, insertReglasStatement.params);
      }
    }

    await client.query('COMMIT');
    invalidateVentasComplementCatalogCache('guardar configuracion de salsas por receta');
    return res.status(200).json({
      error: false,
      message: 'Configuracion de salsas por receta guardada correctamente.',
      data: {
        id_receta: idReceta,
        salsas_asignadas: salsasAsignadas.length,
        reglas: reglas.length
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al guardar configuracion de salsas por receta:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

export default router;




