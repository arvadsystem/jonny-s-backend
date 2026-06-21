import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const MENU_EXTRAS_VIEW_PERMISSIONS = ['MENU_EXTRAS_VER', 'MENU_VER'];
const MENU_EXTRAS_CREATE_PERMISSIONS = ['MENU_EXTRAS_CREAR', 'MENU_VER'];
const MENU_EXTRAS_EDIT_PERMISSIONS = ['MENU_EXTRAS_EDITAR', 'MENU_VER'];
const MENU_EXTRAS_STATE_PERMISSIONS = ['MENU_EXTRAS_ESTADO_CAMBIAR', 'MENU_VER'];
const MENU_EXTRAS_DELETE_PERMISSIONS = ['MENU_EXTRAS_ELIMINAR', 'MENU_VER'];
const SQLSTATE_UNDEFINED_TABLE = '42P01';
const schemaCache = new Map();

const isPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
};

const parseOptionalPositiveInt = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return isPositiveInt(parsed) ? parsed : NaN;
};

const parseOptionalPositiveNumber = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
};

const parseMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return NaN;
  return Number((Math.round((parsed + Number.EPSILON) * 100) / 100).toFixed(2));
};

const toSlugCode = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);

const normalizePositiveIdList = (value) => {
  const rawList = Array.isArray(value) ? value : [];
  return [...new Set(rawList
    .map((item) => Number.parseInt(String(item ?? '').trim(), 10))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
};

const hasTable = async (client, tableName) => {
  const key = `table:${String(tableName || '').trim().toLowerCase()}`;
  if (schemaCache.has(key)) return schemaCache.get(key);
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  const exists = result.rowCount > 0;
  schemaCache.set(key, exists);
  return exists;
};

const normalizeExtraPayload = (payload = {}) => {
  const productos = normalizePositiveIdList(payload.productos || payload.id_productos);
  if (productos.length) {
    return { ok: false, message: 'Los extras no se asignan a productos.' };
  }

  const nombre = String(payload.nombre || '').trim();
  if (!nombre) return { ok: false, message: 'El nombre del extra es obligatorio.' };

  const codigo = toSlugCode(payload.codigo || nombre);
  if (!codigo) return { ok: false, message: 'El codigo del extra es obligatorio.' };

  const precioAdicional = parseMoney(payload.precio_adicional);
  if (Number.isNaN(precioAdicional)) {
    return { ok: false, message: 'El precio adicional debe ser mayor o igual a 0.' };
  }

  const idInsumo = parseOptionalPositiveInt(payload.id_insumo);
  if (Number.isNaN(idInsumo)) return { ok: false, message: 'id_insumo invalido.' };

  const cant = parseOptionalPositiveNumber(payload.cant);
  if (Number.isNaN(cant)) return { ok: false, message: 'La cantidad del insumo debe ser mayor a 0.' };

  const idUnidadMedida = parseOptionalPositiveInt(payload.id_unidad_medida);
  if (Number.isNaN(idUnidadMedida)) return { ok: false, message: 'id_unidad_medida invalido.' };

  if ((idInsumo || cant || idUnidadMedida) && (!idInsumo || !cant || !idUnidadMedida)) {
    return {
      ok: false,
      message: 'Para enlazar inventario debes indicar insumo, cantidad y unidad de medida.'
    };
  }

  const idAlmacenes = normalizePositiveIdList(payload.id_almacenes);
  if (idAlmacenes.length === 0) {
    return { ok: false, message: 'Selecciona al menos una sucursal donde estara disponible este extra.' };
  }

  return {
    ok: true,
    data: {
      codigo,
      nombre,
      precio_adicional: precioAdicional,
      id_insumo: idInsumo,
      cant,
      id_unidad_medida: idUnidadMedida,
      orden: Number.isFinite(Number(payload.orden)) ? Number(payload.orden) : 0,
      estado: payload.estado === undefined ? true : Boolean(payload.estado),
      recetas: normalizePositiveIdList(payload.recetas || payload.id_recetas),
      id_almacenes: idAlmacenes
    }
  };
};

const validateExtraFks = async (client, data) => {
  if (data.id_insumo) {
    const insumo = await client.query(
      'SELECT COALESCE(estado, true) AS estado FROM insumos WHERE id_insumo = $1 LIMIT 1',
      [data.id_insumo]
    );
    if (!insumo.rowCount) return { ok: false, status: 400, message: 'El insumo seleccionado no existe.' };
    if (!insumo.rows[0].estado) return { ok: false, status: 409, message: 'El insumo seleccionado esta inactivo.' };
  }

  if (data.id_unidad_medida) {
    const unidad = await client.query(
      'SELECT 1 FROM unidades_medida WHERE id_unidad_medida = $1 LIMIT 1',
      [data.id_unidad_medida]
    );
    if (!unidad.rowCount) return { ok: false, status: 400, message: 'La unidad de medida no existe.' };
  }

  if (data.recetas.length) {
    const recetas = await client.query(
      `
        SELECT id_receta
        FROM recetas
        WHERE id_receta = ANY($1::int[])
          AND COALESCE(estado, true) = true
      `,
      [data.recetas]
    );
    const found = new Set(recetas.rows.map((row) => Number(row.id_receta)));
    const missing = data.recetas.filter((id) => !found.has(id));
    if (missing.length) {
      return { ok: false, status: 400, message: `Recetas invalidas o inactivas: ${missing.join(', ')}` };
    }
  }

  return { ok: true };
};

const validateExtraAlmacenes = async (client, idAlmacenes = []) => {
  const normalized = normalizePositiveIdList(idAlmacenes);
  if (normalized.length === 0) {
    return { ok: false, status: 400, message: 'Selecciona al menos un almacen para el extra.' };
  }

  const tableExists = await hasTable(client, 'menu_extra_almacenes');
  if (!tableExists) {
    return { ok: false, status: 500, message: 'La tabla de asignaciones de extras no esta disponible en la base de datos.' };
  }

  const result = await client.query(
    `
      SELECT
        a.id_almacen,
        COALESCE(a.estado, true) AS estado,
        COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) AS nombre_almacen,
        s.id_sucursal,
        s.nombre_sucursal,
        COALESCE(s.estado, true) AS sucursal_estado
      FROM almacenes a
      INNER JOIN sucursales s
        ON s.id_sucursal = a.id_sucursal
      WHERE a.id_almacen = ANY($1::int[])
    `,
    [normalized]
  );

  const rows = result.rows || [];
  const found = new Set(rows.map((row) => Number(row.id_almacen)));
  const missing = normalized.filter((id) => !found.has(id));
  if (missing.length) {
    return { ok: false, status: 400, message: `Almacenes invalidos: ${missing.join(', ')}` };
  }

  const branchMap = new Map();
  for (const row of rows) {
    if (row.estado !== true || row.sucursal_estado !== true) {
      return { ok: false, status: 409, message: 'Todos los almacenes seleccionados deben estar activos.' };
    }
    const idSucursal = Number(row.id_sucursal);
    if (branchMap.has(idSucursal)) {
      return { ok: false, status: 409, code: 'EXTRA_MULTIPLE_WAREHOUSES_SAME_BRANCH', message: 'Selecciona como maximo un almacen por sucursal.' };
    }
    branchMap.set(idSucursal, Number(row.id_almacen));
  }

  return { ok: true, rows };
};

const replaceExtraRecipes = async (client, idExtra, recipeIds = []) => {
  await client.query('UPDATE menu_extra_receta SET estado = false WHERE id_extra = $1', [idExtra]);
  const normalized = normalizePositiveIdList(recipeIds);
  if (normalized.length === 0) return;

  await client.query(
    `
      INSERT INTO menu_extra_receta (id_extra, id_receta, orden, estado, fecha_actualizacion)
      SELECT
        $1,
        item.id_receta,
        item.orden,
        true,
        NOW()
      FROM jsonb_to_recordset($2::jsonb) AS item(
        id_receta int,
        orden int
      )
      ON CONFLICT (id_extra, id_receta) DO UPDATE
      SET estado = true,
          orden = EXCLUDED.orden,
          fecha_actualizacion = NOW()
    `,
    [
      idExtra,
      JSON.stringify(normalized.map((idReceta, index) => ({ id_receta: idReceta, orden: index + 1 })))
    ]
  );
};

const replaceExtraAlmacenes = async (client, idExtra, idAlmacenes = []) => {
  const normalized = normalizePositiveIdList(idAlmacenes);
  await client.query(
    `
      UPDATE menu_extra_almacenes
      SET estado = false,
          fecha_actualizacion = NOW()
      WHERE id_extra = $1
        AND NOT (id_almacen = ANY($2::int[]))
    `,
    [idExtra, normalized]
  );

  if (normalized.length === 0) return;

  await client.query(
    `
      INSERT INTO menu_extra_almacenes (id_extra, id_almacen, estado, fecha_actualizacion)
      SELECT $1, UNNEST($2::int[]), true, NOW()
      ON CONFLICT (id_extra, id_almacen)
      DO UPDATE SET
        estado = true,
        fecha_actualizacion = NOW()
    `,
    [idExtra, normalized]
  );
};

const syncExtraAlmacenes = async (client, idExtra, idAlmacenes = []) => {
  const validation = await validateExtraAlmacenes(client, idAlmacenes);
  if (!validation.ok) return validation;
  await replaceExtraAlmacenes(client, idExtra, idAlmacenes);
  return { ok: true, rows: validation.rows };
};

const listExtraAssignments = async (client, idExtra) => {
  try {
    const result = await client.query(
      `
        SELECT
          mea.id_extra,
          mea.id_almacen,
          COALESCE(mea.estado, true) AS estado,
          COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) AS nombre_almacen,
          a.id_sucursal,
          s.nombre_sucursal
        FROM menu_extra_almacenes mea
        INNER JOIN almacenes a
          ON a.id_almacen = mea.id_almacen
        INNER JOIN sucursales s
          ON s.id_sucursal = a.id_sucursal
        WHERE mea.id_extra = $1
        ORDER BY s.nombre_sucursal ASC, COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) ASC, a.id_almacen ASC
      `,
      [idExtra]
    );
    return result.rows || [];
  } catch (error) {
    if (error?.code === SQLSTATE_UNDEFINED_TABLE) return [];
    throw error;
  }
};

const attachExtraAlmacenes = async (client, rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;
  const ids = normalizePositiveIdList(list.map((row) => row?.id_extra));
  if (ids.length === 0) return list.map((row) => ({ ...row, id_almacenes: [], total_almacenes: 0, total_sucursales: 0, nombres_sucursales: [] }));

  try {
    const assignments = await client.query(
      `
        SELECT
          mea.id_extra,
          ARRAY_AGG(mea.id_almacen ORDER BY mea.id_almacen) FILTER (WHERE COALESCE(mea.estado, true) = true) AS id_almacenes,
          COUNT(*) FILTER (WHERE COALESCE(mea.estado, true) = true)::int AS total_almacenes,
          COUNT(DISTINCT a.id_sucursal) FILTER (WHERE COALESCE(mea.estado, true) = true)::int AS total_sucursales,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.nombre_sucursal) FILTER (WHERE COALESCE(mea.estado, true) = true), NULL) AS nombres_sucursales
        FROM menu_extra_almacenes mea
        INNER JOIN almacenes a
          ON a.id_almacen = mea.id_almacen
        INNER JOIN sucursales s
          ON s.id_sucursal = a.id_sucursal
        WHERE mea.id_extra = ANY($1::int[])
        GROUP BY mea.id_extra
      `,
      [ids]
    );

    const map = new Map((assignments.rows || []).map((row) => [
      Number(row.id_extra),
      {
        id_almacenes: normalizePositiveIdList(row.id_almacenes),
        total_almacenes: Number(row.total_almacenes || 0),
        total_sucursales: Number(row.total_sucursales || 0),
        nombres_sucursales: Array.isArray(row.nombres_sucursales) ? row.nombres_sucursales : []
      }
    ]));

    return list.map((row) => {
      const assignment = map.get(Number(row.id_extra));
      return {
        ...row,
        id_almacenes: assignment?.id_almacenes || [],
        total_almacenes: assignment?.total_almacenes || 0,
        total_sucursales: assignment?.total_sucursales || 0,
        nombres_sucursales: assignment?.nombres_sucursales || []
      };
    });
  } catch (error) {
    if (error?.code === SQLSTATE_UNDEFINED_TABLE) {
      return list.map((row) => ({ ...row, id_almacenes: [], total_almacenes: 0, total_sucursales: 0, nombres_sucursales: [] }));
    }
    throw error;
  }
};

const getHydratedExtraById = async (client, idExtra) => {
  const extraResult = await client.query(
    `
      SELECT
        me.id_extra,
        me.codigo,
        me.nombre,
        ROUND(CAST(me.precio_adicional AS numeric), 2) AS precio_adicional,
        me.id_insumo,
        me.cant,
        me.id_unidad_medida,
        me.orden,
        me.estado,
        me.fecha_creacion,
        me.fecha_actualizacion,
        i.nombre_insumo,
        um.nombre AS unidad_nombre,
        um.simbolo AS unidad_simbolo
      FROM menu_extras me
      LEFT JOIN insumos i ON i.id_insumo = me.id_insumo
      LEFT JOIN unidades_medida um ON um.id_unidad_medida = me.id_unidad_medida
      WHERE me.id_extra = $1
      LIMIT 1
    `,
    [idExtra]
  );

  if (!extraResult.rowCount) return null;

  const [recetas, assignments] = await Promise.all([
    client.query(
      `
        SELECT id_receta
        FROM menu_extra_receta
        WHERE id_extra = $1
          AND COALESCE(estado, true) = true
        ORDER BY orden, id_extra_receta
      `,
      [idExtra]
    ),
    listExtraAssignments(client, idExtra)
  ]);

  const [hydrated] = await attachExtraAlmacenes(client, [extraResult.rows[0]]);
  return {
    ...hydrated,
    recetas: recetas.rows.map((row) => Number(row.id_receta)),
    asignaciones: assignments
  };
};

const assertExtraExists = async (client, idExtra) => {
  const result = await client.query(
    'SELECT id_extra, COALESCE(estado, true) AS estado FROM menu_extras WHERE id_extra = $1 LIMIT 1',
    [idExtra]
  );
  if (!result.rowCount) {
    return { ok: false, status: 404, message: 'Extra no encontrado.' };
  }
  return { ok: true, row: result.rows[0] };
};

router.get('/', checkPermission(MENU_EXTRAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const includeInactive = String(req.query?.incluir_inactivos || '') === '1';
    const result = await pool.query(
      `
        SELECT
          me.id_extra,
          me.codigo,
          me.nombre,
          ROUND(CAST(me.precio_adicional AS numeric), 2) AS precio_adicional,
          me.id_insumo,
          i.nombre_insumo,
          me.cant,
          me.id_unidad_medida,
          um.nombre AS unidad_nombre,
          um.simbolo AS unidad_simbolo,
          me.orden,
          me.estado,
          COALESCE(recipe_count.total_recetas, 0)::int AS total_recetas
        FROM menu_extras me
        LEFT JOIN insumos i ON i.id_insumo = me.id_insumo
        LEFT JOIN unidades_medida um ON um.id_unidad_medida = me.id_unidad_medida
        LEFT JOIN (
          SELECT id_extra, COUNT(*)::int AS total_recetas
          FROM menu_extra_receta
          WHERE COALESCE(estado, true) = true
          GROUP BY id_extra
        ) recipe_count ON recipe_count.id_extra = me.id_extra
        WHERE ($1::boolean = true OR COALESCE(me.estado, true) = true)
        ORDER BY COALESCE(me.orden, 0), me.nombre
      `,
      [includeInactive]
    );

    const hydrated = await attachExtraAlmacenes(pool, result.rows || []);
    return res.status(200).json(hydrated);
  } catch (err) {
    console.error('Error al listar extras admin:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar los extras.' });
  }
});

router.get('/catalogos/insumos', checkPermission(MENU_EXTRAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          i.id_insumo,
          i.nombre_insumo,
          i.id_unidad_medida,
          um.nombre AS unidad_nombre,
          um.simbolo AS unidad_simbolo
        FROM insumos i
        LEFT JOIN unidades_medida um ON um.id_unidad_medida = i.id_unidad_medida
        WHERE COALESCE(i.estado, true) = true
        ORDER BY i.nombre_insumo ASC
      `
    );
    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar insumos para extras:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar los insumos.' });
  }
});

router.get('/catalogos/recetas', checkPermission(MENU_EXTRAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT id_receta, nombre_receta, precio
        FROM recetas
        WHERE COALESCE(estado, true) = true
        ORDER BY nombre_receta ASC
      `
    );
    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar recetas para extras:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar las recetas.' });
  }
});

router.get('/catalogos/almacenes', checkPermission(MENU_EXTRAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          a.id_almacen,
          COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) AS nombre_almacen,
          a.id_sucursal,
          s.nombre_sucursal,
          COALESCE(a.estado, true) AS estado
        FROM almacenes a
        INNER JOIN sucursales s
          ON s.id_sucursal = a.id_sucursal
        WHERE COALESCE(a.estado, true) = true
          AND COALESCE(s.estado, true) = true
        ORDER BY s.nombre_sucursal ASC, COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) ASC, a.id_almacen ASC
      `
    );
    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar almacenes para extras:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar los almacenes.' });
  }
});

router.get('/:id_extra/asignaciones', checkPermission(MENU_EXTRAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idExtra = Number(req.params.id_extra);
    if (!isPositiveInt(idExtra)) {
      return res.status(400).json({ error: true, message: 'id_extra invalido.' });
    }
    const exists = await assertExtraExists(pool, idExtra);
    if (!exists.ok) return res.status(exists.status).json({ error: true, message: exists.message });
    const asignaciones = await listExtraAssignments(pool, idExtra);
    return res.status(200).json({ id_extra: idExtra, asignaciones });
  } catch (err) {
    console.error('Error al obtener asignaciones de extra:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar las asignaciones del extra.' });
  }
});

router.put('/:id_extra/asignaciones', checkPermission(MENU_EXTRAS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txStarted = false;
  try {
    const idExtra = Number(req.params.id_extra);
    if (!isPositiveInt(idExtra)) {
      return res.status(400).json({ error: true, message: 'id_extra invalido.' });
    }

    const exists = await assertExtraExists(client, idExtra);
    if (!exists.ok) return res.status(exists.status).json({ error: true, message: exists.message });

    const idAlmacenes = normalizePositiveIdList(req.body?.id_almacenes);
    const validation = await validateExtraAlmacenes(client, idAlmacenes);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: true, code: validation.code, message: validation.message });
    }

    await client.query('BEGIN');
    txStarted = true;
    await replaceExtraAlmacenes(client, idExtra, idAlmacenes);
    await client.query('COMMIT');
    txStarted = false;

    const extra = await getHydratedExtraById(pool, idExtra);

    return res.status(200).json({
      error: false,
      message: 'Sucursales del extra actualizadas correctamente.',
      id_extra: idExtra,
      id_almacenes: idAlmacenes,
      extra
    });
  } catch (err) {
    if (txStarted) {
      try { await client.query('ROLLBACK'); } catch {}
      txStarted = false;
    }
    console.error('Error al reemplazar asignaciones de extra:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron actualizar las sucursales del extra.' });
  } finally {
    client.release();
  }
});

router.post('/:id_extra/asignaciones', checkPermission(MENU_EXTRAS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txStarted = false;
  try {
    const idExtra = Number(req.params.id_extra);
    const idAlmacen = Number(req.body?.id_almacen);
    if (!isPositiveInt(idExtra) || !isPositiveInt(idAlmacen)) {
      return res.status(400).json({ error: true, message: 'id_extra o id_almacen invalido.' });
    }

    const exists = await assertExtraExists(client, idExtra);
    if (!exists.ok) return res.status(exists.status).json({ error: true, message: exists.message });

    const validation = await validateExtraAlmacenes(client, [idAlmacen]);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: true, code: validation.code, message: validation.message });
    }

    const currentAssignments = (await listExtraAssignments(client, idExtra)).filter((row) => row.estado === true);
    const newBranchId = Number(validation.rows[0]?.id_sucursal || 0);
    const sameBranchActive = currentAssignments.find((row) => Number(row.id_sucursal) === newBranchId && Number(row.id_almacen) !== idAlmacen);
    if (sameBranchActive) {
      return res.status(409).json({
        error: true,
        code: 'EXTRA_BRANCH_ASSIGNMENT_CONFLICT',
        message: 'Ya existe otro almacen activo para esa sucursal en este extra.'
      });
    }
    const sameAssignment = currentAssignments.find((row) => Number(row.id_almacen) === idAlmacen);
    if (sameAssignment) {
      return res.status(409).json({
        error: true,
        code: 'EXTRA_ASSIGNMENT_ALREADY_ACTIVE',
        message: 'El extra ya esta asignado a ese almacen.'
      });
    }

    await client.query('BEGIN');
    txStarted = true;
    await client.query(
      `
        INSERT INTO menu_extra_almacenes (id_extra, id_almacen, estado, fecha_actualizacion)
        VALUES ($1, $2, true, NOW())
        ON CONFLICT (id_extra, id_almacen)
        DO UPDATE SET estado = true, fecha_actualizacion = NOW()
      `,
      [idExtra, idAlmacen]
    );
    await client.query('COMMIT');
    txStarted = false;

    return res.status(201).json({
      error: false,
      message: 'Asignacion del extra creada correctamente.',
      id_extra: idExtra,
      id_almacen: idAlmacen
    });
  } catch (err) {
    if (txStarted) {
      try { await client.query('ROLLBACK'); } catch {}
      txStarted = false;
    }
    console.error('Error al crear asignacion de extra:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo crear la asignacion del extra.' });
  } finally {
    client.release();
  }
});

router.patch('/:id_extra/asignaciones/:id_almacen/inactivar', checkPermission(MENU_EXTRAS_DELETE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txStarted = false;
  try {
    const idExtra = Number(req.params.id_extra);
    const idAlmacen = Number(req.params.id_almacen);
    if (!isPositiveInt(idExtra) || !isPositiveInt(idAlmacen)) {
      return res.status(400).json({ error: true, message: 'id_extra o id_almacen invalido.' });
    }

    const exists = await assertExtraExists(client, idExtra);
    if (!exists.ok) return res.status(exists.status).json({ error: true, message: exists.message });

    const assignmentResult = await client.query(
      `
        SELECT id_extra, id_almacen, COALESCE(estado, true) AS estado
        FROM menu_extra_almacenes
        WHERE id_extra = $1
          AND id_almacen = $2
        LIMIT 1
      `,
      [idExtra, idAlmacen]
    );
    if (!assignmentResult.rowCount) {
      return res.status(404).json({ error: true, message: 'La asignacion del extra no existe para ese almacen.' });
    }

    await client.query('BEGIN');
    txStarted = true;
    await client.query(
      `
        UPDATE menu_extra_almacenes
        SET estado = false,
            fecha_actualizacion = NOW()
        WHERE id_extra = $1
          AND id_almacen = $2
      `,
      [idExtra, idAlmacen]
    );
    await client.query('COMMIT');
    txStarted = false;

    return res.status(200).json({
      error: false,
      message: assignmentResult.rows[0].estado === true
        ? 'Asignacion del extra inactivada correctamente.'
        : 'La asignacion del extra ya estaba inactiva.',
      id_extra: idExtra,
      id_almacen: idAlmacen
    });
  } catch (err) {
    if (txStarted) {
      try { await client.query('ROLLBACK'); } catch {}
      txStarted = false;
    }
    console.error('Error al inactivar asignacion de extra:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo inactivar la asignacion del extra.' });
  } finally {
    client.release();
  }
});

router.get('/:id_extra', checkPermission(MENU_EXTRAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idExtra = Number(req.params.id_extra);
    if (!isPositiveInt(idExtra)) {
      return res.status(400).json({ error: true, message: 'id_extra invalido.' });
    }
    const extra = await getHydratedExtraById(pool, idExtra);
    if (!extra) return res.status(404).json({ error: true, message: 'Extra no encontrado.' });
    return res.status(200).json(extra);
  } catch (err) {
    console.error('Error al obtener extra admin:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo cargar el extra.' });
  }
});

router.post('/', checkPermission(MENU_EXTRAS_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txStarted = false;
  try {
    const normalized = normalizeExtraPayload(req.body);
    if (!normalized.ok) return res.status(400).json({ error: true, message: normalized.message });

    const [fkValidation, almacenesValidation] = await Promise.all([
      validateExtraFks(client, normalized.data),
      validateExtraAlmacenes(client, normalized.data.id_almacenes)
    ]);
    if (!fkValidation.ok) return res.status(fkValidation.status).json({ error: true, message: fkValidation.message });
    if (!almacenesValidation.ok) {
      return res.status(almacenesValidation.status).json({ error: true, code: almacenesValidation.code, message: almacenesValidation.message });
    }

    await client.query('BEGIN');
    txStarted = true;
    const created = await client.query(
      `
        INSERT INTO menu_extras (
          codigo, nombre, precio_adicional, id_insumo, cant, id_unidad_medida, orden, estado, fecha_actualizacion
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING id_extra
      `,
      [
        normalized.data.codigo,
        normalized.data.nombre,
        normalized.data.precio_adicional,
        normalized.data.id_insumo,
        normalized.data.cant,
        normalized.data.id_unidad_medida,
        normalized.data.orden,
        normalized.data.estado
      ]
    );
    const idExtra = Number(created.rows[0].id_extra);
    await replaceExtraRecipes(client, idExtra, normalized.data.recetas);
    await replaceExtraAlmacenes(client, idExtra, normalized.data.id_almacenes);
    await client.query('COMMIT');
    txStarted = false;

    const extra = await getHydratedExtraById(pool, idExtra);

    return res.status(201).json({ error: false, message: 'Extra creado correctamente.', id_extra: idExtra, extra });
  } catch (err) {
    if (txStarted) {
      try { await client.query('ROLLBACK'); } catch {}
      txStarted = false;
    }
    console.error('Error al crear extra admin:', err.message);
    if (err?.code === '23505') {
      return res.status(409).json({ error: true, message: 'Ya existe un extra con ese codigo.' });
    }
    return res.status(500).json({ error: true, message: 'No se pudo crear el extra.' });
  } finally {
    client.release();
  }
});

router.put('/:id_extra', checkPermission(MENU_EXTRAS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txStarted = false;
  try {
    const idExtra = Number(req.params.id_extra);
    if (!isPositiveInt(idExtra)) {
      return res.status(400).json({ error: true, message: 'id_extra invalido.' });
    }

    const normalized = normalizeExtraPayload(req.body);
    if (!normalized.ok) return res.status(400).json({ error: true, message: normalized.message });

    const [exists, fkValidation, almacenesValidation] = await Promise.all([
      assertExtraExists(client, idExtra),
      validateExtraFks(client, normalized.data),
      validateExtraAlmacenes(client, normalized.data.id_almacenes)
    ]);
    if (!exists.ok) return res.status(exists.status).json({ error: true, message: exists.message });
    if (!fkValidation.ok) return res.status(fkValidation.status).json({ error: true, message: fkValidation.message });
    if (!almacenesValidation.ok) {
      return res.status(almacenesValidation.status).json({ error: true, code: almacenesValidation.code, message: almacenesValidation.message });
    }

    await client.query('BEGIN');
    txStarted = true;
    await client.query(
      `
        UPDATE menu_extras
        SET codigo = $1,
            nombre = $2,
            precio_adicional = $3,
            id_insumo = $4,
            cant = $5,
            id_unidad_medida = $6,
            orden = $7,
            estado = $8,
            fecha_actualizacion = NOW()
        WHERE id_extra = $9
      `,
      [
        normalized.data.codigo,
        normalized.data.nombre,
        normalized.data.precio_adicional,
        normalized.data.id_insumo,
        normalized.data.cant,
        normalized.data.id_unidad_medida,
        normalized.data.orden,
        normalized.data.estado,
        idExtra
      ]
    );
    await replaceExtraRecipes(client, idExtra, normalized.data.recetas);
    await replaceExtraAlmacenes(client, idExtra, normalized.data.id_almacenes);
    await client.query('COMMIT');
    txStarted = false;

    const extra = await getHydratedExtraById(pool, idExtra);

    return res.status(200).json({ error: false, message: 'Extra actualizado correctamente.', extra });
  } catch (err) {
    if (txStarted) {
      try { await client.query('ROLLBACK'); } catch {}
      txStarted = false;
    }
    console.error('Error al actualizar extra admin:', err.message);
    if (err?.code === '23505') {
      return res.status(409).json({ error: true, message: 'Ya existe un extra con ese codigo.' });
    }
    return res.status(500).json({ error: true, message: 'No se pudo actualizar el extra.' });
  } finally {
    client.release();
  }
});

router.patch('/:id_extra/estado', checkPermission(MENU_EXTRAS_STATE_PERMISSIONS), async (req, res) => {
  try {
    const idExtra = Number(req.params.id_extra);
    if (!isPositiveInt(idExtra)) {
      return res.status(400).json({ error: true, message: 'id_extra invalido.' });
    }
    const estado = Boolean(req.body?.estado);
    const result = await pool.query(
      `
        UPDATE menu_extras
        SET estado = $1,
            fecha_actualizacion = NOW()
        WHERE id_extra = $2
        RETURNING id_extra
      `,
      [estado, idExtra]
    );
    if (!result.rowCount) return res.status(404).json({ error: true, message: 'Extra no encontrado.' });
    return res.status(200).json({ error: false, message: 'Estado del extra actualizado correctamente.' });
  } catch (err) {
    console.error('Error al cambiar estado de extra admin:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo cambiar el estado del extra.' });
  }
});

export default router;
