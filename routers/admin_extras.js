import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const MENU_VIEW_PERMISSIONS = ['MENU_VER'];
const MENU_MUTATION_PERMISSIONS = ['MENU_VER'];

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
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
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

const normalizeRecipeIds = (value) => {
  const rawList = Array.isArray(value) ? value : [];
  return [...new Set(rawList
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
};

const normalizeExtraPayload = (payload = {}) => {
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
      recetas: normalizeRecipeIds(payload.recetas || payload.id_recetas)
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

const replaceExtraRecipes = async (client, idExtra, recipeIds = []) => {
  await client.query('UPDATE menu_extra_receta SET estado = false WHERE id_extra = $1', [idExtra]);

  for (const [index, idReceta] of recipeIds.entries()) {
    await client.query(
      `
        INSERT INTO menu_extra_receta (id_extra, id_receta, orden, estado, fecha_actualizacion)
        VALUES ($1, $2, $3, true, NOW())
        ON CONFLICT (id_extra, id_receta) DO UPDATE
        SET estado = true,
            orden = EXCLUDED.orden,
            fecha_actualizacion = NOW()
      `,
      [idExtra, idReceta, index + 1]
    );
  }
};

router.get('/', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const includeInactive = String(req.query?.incluir_inactivos || '') === '1';
    const result = await pool.query(
      `
        SELECT
          me.id_extra,
          me.codigo,
          me.nombre,
          me.precio_adicional,
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

    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar extras admin:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar los extras.' });
  }
});

router.get('/catalogos/insumos', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
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

router.get('/catalogos/recetas', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
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

router.get('/:id_extra', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idExtra = Number(req.params.id_extra);
    if (!isPositiveInt(idExtra)) {
      return res.status(400).json({ error: true, message: 'id_extra invalido.' });
    }

    const extra = await pool.query(
      `
        SELECT
          me.*,
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
    if (!extra.rowCount) return res.status(404).json({ error: true, message: 'Extra no encontrado.' });

    const recetas = await pool.query(
      `
        SELECT id_receta
        FROM menu_extra_receta
        WHERE id_extra = $1
          AND COALESCE(estado, true) = true
        ORDER BY orden, id_extra_receta
      `,
      [idExtra]
    );

    return res.status(200).json({
      ...extra.rows[0],
      recetas: recetas.rows.map((row) => Number(row.id_receta))
    });
  } catch (err) {
    console.error('Error al obtener extra admin:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo cargar el extra.' });
  }
});

router.post('/', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const normalized = normalizeExtraPayload(req.body);
    if (!normalized.ok) return res.status(400).json({ error: true, message: normalized.message });

    const fkValidation = await validateExtraFks(client, normalized.data);
    if (!fkValidation.ok) return res.status(fkValidation.status).json({ error: true, message: fkValidation.message });

    await client.query('BEGIN');
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
    await client.query('COMMIT');

    return res.status(201).json({ error: false, message: 'Extra creado correctamente.', id_extra: idExtra });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear extra admin:', err.message);
    if (err?.code === '23505') {
      return res.status(409).json({ error: true, message: 'Ya existe un extra con ese codigo.' });
    }
    return res.status(500).json({ error: true, message: 'No se pudo crear el extra.' });
  } finally {
    client.release();
  }
});

router.put('/:id_extra', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idExtra = Number(req.params.id_extra);
    if (!isPositiveInt(idExtra)) {
      return res.status(400).json({ error: true, message: 'id_extra invalido.' });
    }

    const normalized = normalizeExtraPayload(req.body);
    if (!normalized.ok) return res.status(400).json({ error: true, message: normalized.message });

    const fkValidation = await validateExtraFks(client, normalized.data);
    if (!fkValidation.ok) return res.status(fkValidation.status).json({ error: true, message: fkValidation.message });

    await client.query('BEGIN');
    const updated = await client.query(
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
        normalized.data.estado,
        idExtra
      ]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Extra no encontrado.' });
    }
    await replaceExtraRecipes(client, idExtra, normalized.data.recetas);
    await client.query('COMMIT');

    return res.status(200).json({ error: false, message: 'Extra actualizado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar extra admin:', err.message);
    if (err?.code === '23505') {
      return res.status(409).json({ error: true, message: 'Ya existe un extra con ese codigo.' });
    }
    return res.status(500).json({ error: true, message: 'No se pudo actualizar el extra.' });
  } finally {
    client.release();
  }
});

router.patch('/:id_extra/estado', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
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
