import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { clearVentasComplementCatalogCache } from './ventas/services/complementosCatalogService.js';

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
    const [salsasTieneEstado, salsasTieneNivelPicante, salsasTieneOrden] = await Promise.all([
      hasColumn('salsas', 'estado'),
      hasColumn('salsas', 'nivel_picante'),
      hasColumn('salsas', 'orden')
    ]);

    const includeInactive = shouldIncludeInactive(req.query);
    const whereClause = salsasTieneEstado && !includeInactive
      ? 'WHERE COALESCE(s.estado, true) = true'
      : '';

    const result = await pool.query(
      `
        SELECT
          s.id_salsa,
          s.nombre,
          ${salsasTieneNivelPicante ? 'COALESCE(s.nivel_picante, 0)' : '0'} AS nivel_picante,
          ${salsasTieneOrden ? 'COALESCE(s.orden, 0)' : '0'} AS orden,
          ${salsasTieneEstado ? 'COALESCE(s.estado, true)' : 'true'} AS estado
        FROM salsas s
        ${whereClause}
        ORDER BY ${salsasTieneOrden ? 'COALESCE(s.orden, 2147483647),' : ''} s.nombre ASC, s.id_salsa ASC;
      `
    );

    return res.status(200).json(result.rows || []);
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

router.get('/recetas/:id_receta/config', checkPermission(MENU_SALSAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idReceta = toPositiveInt(req.params.id_receta);
    if (!idReceta) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const [salsasTieneEstado, salsasTieneNivelPicante, salsasTieneOrden, recetaSalsaTieneEstado, reglasTieneEstado] = await Promise.all([
      hasColumn('salsas', 'estado'),
      hasColumn('salsas', 'nivel_picante'),
      hasColumn('salsas', 'orden'),
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
            ${salsasTieneOrden ? 'COALESCE(s.orden, 2147483647)' : '0'} AS sort_orden
          FROM salsas s
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

    return res.status(200).json({
      receta: {
        id_receta: Number(config.receta.id_receta),
        nombre_receta: config.receta.nombre_receta
      },
      salsas_catalogo: Array.isArray(config.salsas_catalogo) ? config.salsas_catalogo : [],
      salsas_asignadas: (Array.isArray(config.salsas_asignadas) ? config.salsas_asignadas : []).map((idSalsa) => Number(idSalsa)),
      reglas: Array.isArray(config.reglas) ? config.reglas : []
    });
  } catch (err) {
    console.error('Error al obtener configuracion de salsas por receta:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.post('/', checkPermission(MENU_SALSAS_CREATE_PERMISSIONS), async (req, res) => {
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
    if (salsasTieneOrden) insertData.orden = data.orden ?? 0;
    if (salsasTieneEstado) insertData.estado = data.estado === null ? true : data.estado;
    if (idUsuarioMeta.exists && resolvedUserId) insertData.id_usuario = resolvedUserId;

    const rawInsert = {};
    if (salsasTieneFechaCreacion) rawInsert.fecha_creacion = "timezone('America/Tegucigalpa', now())";
    if (salsasTieneFechaModificacion) rawInsert.fecha_modificacion = "timezone('America/Tegucigalpa', now())";

    const insertStatement = buildInsertStatement({
      tableName: 'salsas',
      data: insertData,
      raw: rawInsert,
      returning: 'id_salsa'
    });

    const createdResult = await pool.query(insertStatement.text, insertStatement.params);
    invalidateVentasComplementCatalogCache('crear salsa');
    return res.status(201).json({
      error: false,
      message: 'Salsa creada correctamente.',
      data: {
        id_salsa: Number(createdResult.rows?.[0]?.id_salsa || 0)
      }
    });
  } catch (err) {
    console.error('Error al crear salsa admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
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
          SELECT id_salsa
          FROM salsas
          WHERE id_salsa = ANY($1::int[])
            ${salsasTieneEstado ? 'AND COALESCE(estado, true) = true' : ''}
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




