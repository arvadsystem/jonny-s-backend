import express from 'express';
import pool from '../config/db-connection.js';
import { resolveMenuDepartmentIds } from './menu_departamentos.js';

const router = express.Router();

const hasColumn = async (tableName, columnName) => {
  const query = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1;
  `;
  const result = await pool.query(query, [tableName, columnName]);
  return result.rowCount > 0;
};

const toPositiveIntArray = (values) => (
  [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )]
);

const findMatchingSalsaRule = (rules, unidades) => {
  const units = Number(unidades);
  if (!Number.isFinite(units) || units <= 0) return null;

  const orderedRules = [...(Array.isArray(rules) ? rules : [])].sort((a, b) => (
    Number(a?.min_unidades || 0) - Number(b?.min_unidades || 0)
  ));

  return orderedRules.find((rule) => {
    const min = Number(rule?.min_unidades || 0);
    const max = rule?.max_unidades === null || rule?.max_unidades === undefined
      ? null
      : Number(rule.max_unidades);

    if (!Number.isFinite(min) || units < min) return false;
    if (max !== null && Number.isFinite(max) && units > max) return false;
    return true;
  }) || null;
};

const calculateRequiredSaucesForQuantity = (components, quantity = 1) => (
  (Array.isArray(components) ? components : []).reduce((total, component) => {
    const multiplier = Math.max(1, Number(component?.multiplicador || 1));
    const units = Math.max(1, Number(quantity || 1)) * multiplier;
    const rule = findMatchingSalsaRule(component?.reglas, units);
    return total + Number(rule?.salsas_requeridas || 0);
  }, 0)
);

const sortSauceOptions = (items) => (
  [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const orderA = Number(a?.orden || 0);
    const orderB = Number(b?.orden || 0);
    if (orderA !== orderB) return orderA - orderB;
    return String(a?.nombre || '').localeCompare(String(b?.nombre || ''), 'es', {
      sensitivity: 'base'
    });
  })
);

const enrichCatalogItemsWithSauceConfig = async (items) => {
  const directRecipeIds = toPositiveIntArray(items.map((item) => item?.id_receta));
  const comboIds = toPositiveIntArray(items.map((item) => item?.id_combo));

  let comboRecipeRows = [];
  if (comboIds.length > 0) {
    const comboRecipesResult = await pool.query(
      `
        SELECT
          dc.id_combo,
          dc.id_receta,
          dc.cantidad AS multiplicador,
          r.nombre_receta
        FROM detalle_combo dc
        INNER JOIN recetas r
          ON r.id_receta = dc.id_receta
        WHERE dc.id_combo = ANY($1::int[])
          AND dc.id_receta IS NOT NULL
          AND COALESCE(dc.estado, true) = true
          AND COALESCE(r.estado, true) = true
        ORDER BY dc.id_combo, COALESCE(dc.orden, dc.id_detalle_combo);
      `,
      [comboIds]
    );
    comboRecipeRows = comboRecipesResult.rows;
  }

  const allRecipeIds = toPositiveIntArray([
    ...directRecipeIds,
    ...comboRecipeRows.map((row) => row?.id_receta)
  ]);

  let allowedSauceRows = [];
  let ruleRows = [];

  if (allRecipeIds.length > 0) {
    const [allowedSaucesResult, rulesResult] = await Promise.all([
      pool.query(
        `
          SELECT
            rs.id_receta,
            s.id_salsa,
            s.nombre,
            s.nivel_picante,
            s.orden
          FROM receta_salsa rs
          INNER JOIN salsas s
            ON s.id_salsa = rs.id_salsa
          WHERE rs.id_receta = ANY($1::int[])
            AND COALESCE(rs.estado, true) = true
            AND COALESCE(s.estado, true) = true
          ORDER BY rs.id_receta, s.orden, s.nombre;
        `,
        [allRecipeIds]
      ),
      pool.query(
        `
          SELECT
            id_regla,
            id_receta,
            min_unidades,
            max_unidades,
            salsas_requeridas
          FROM reglas_salsas_receta
          WHERE id_receta = ANY($1::int[])
            AND COALESCE(estado, true) = true
          ORDER BY id_receta, min_unidades, max_unidades NULLS LAST, id_regla;
        `,
        [allRecipeIds]
      )
    ]);

    allowedSauceRows = allowedSaucesResult.rows;
    ruleRows = rulesResult.rows;
  }

  const allowedSaucesByRecipe = new Map();
  for (const row of allowedSauceRows) {
    const recipeId = Number(row?.id_receta || 0);
    if (!allowedSaucesByRecipe.has(recipeId)) {
      allowedSaucesByRecipe.set(recipeId, []);
    }
    allowedSaucesByRecipe.get(recipeId).push({
      id_salsa: row.id_salsa,
      nombre: row.nombre,
      nivel_picante: Number(row.nivel_picante || 0),
      orden: Number(row.orden || 0)
    });
  }

  const rulesByRecipe = new Map();
  for (const row of ruleRows) {
    const recipeId = Number(row?.id_receta || 0);
    if (!rulesByRecipe.has(recipeId)) {
      rulesByRecipe.set(recipeId, []);
    }
    rulesByRecipe.get(recipeId).push({
      id_regla: row.id_regla,
      min_unidades: Number(row.min_unidades || 0),
      max_unidades: row.max_unidades === null || row.max_unidades === undefined
        ? null
        : Number(row.max_unidades),
      salsas_requeridas: Number(row.salsas_requeridas || 0)
    });
  }

  const comboComponentsById = new Map();
  for (const row of comboRecipeRows) {
    const comboId = Number(row?.id_combo || 0);
    const recipeId = Number(row?.id_receta || 0);
    if (!comboComponentsById.has(comboId)) {
      comboComponentsById.set(comboId, []);
    }

    comboComponentsById.get(comboId).push({
      id_receta: recipeId,
      nombre_receta: row.nombre_receta,
      multiplicador: Math.max(1, Number(row?.multiplicador || 1)),
      salsas_permitidas: sortSauceOptions(allowedSaucesByRecipe.get(recipeId) || []),
      reglas: rulesByRecipe.get(recipeId) || []
    });
  }

  return items.map((item) => {
    let salsasComponentes = [];

    if (Number(item?.id_receta || 0) > 0) {
      const recipeId = Number(item.id_receta);
      salsasComponentes = [{
        id_receta: recipeId,
        nombre_receta: item.nombre_producto,
        multiplicador: 1,
        salsas_permitidas: sortSauceOptions(allowedSaucesByRecipe.get(recipeId) || []),
        reglas: rulesByRecipe.get(recipeId) || []
      }];
    } else if (Number(item?.id_combo || 0) > 0) {
      salsasComponentes = comboComponentsById.get(Number(item.id_combo)) || [];
    }

    const unionSauces = new Map();
    for (const component of salsasComponentes) {
      for (const sauce of component.salsas_permitidas || []) {
        unionSauces.set(Number(sauce.id_salsa), sauce);
      }
    }

    const salsasPermitidas = sortSauceOptions(Array.from(unionSauces.values()));
    const salsasRequiereSeleccion = salsasComponentes.some((component) => (
      (component.reglas || []).some((rule) => Number(rule?.salsas_requeridas || 0) > 0)
    ));

    return {
      ...item,
      salsas_componentes: salsasComponentes,
      salsas_permitidas: salsasPermitidas,
      salsas_requiere_seleccion: salsasRequiereSeleccion,
      salsas_requeridas_base: calculateRequiredSaucesForQuantity(salsasComponentes, 1)
    };
  });
};

// =====================================================
// HU-36
// GET: Productos + combos del POS con URL de imagen
// URL: /menu-pos/catalogo-imagenes?id_tipo_departamento=?
// =====================================================
router.get('/menu-pos/catalogo-imagenes', async (req, res) => {
  try {
    const rawIdTipoDepartamento = req.query.id_tipo_departamento;
    const idTipoDepartamento =
      rawIdTipoDepartamento === undefined || rawIdTipoDepartamento === null || rawIdTipoDepartamento === ''
        ? null
        : Number(rawIdTipoDepartamento);

    if (rawIdTipoDepartamento !== undefined && rawIdTipoDepartamento !== null && rawIdTipoDepartamento !== '' && Number.isNaN(idTipoDepartamento)) {
      return res.status(400).json({
        ok: false,
        message: 'id_tipo_departamento inválido'
      });
    }

    const productosTieneArchivo = await hasColumn('productos', 'id_archivo_imagen_principal');
    const departmentIds = await resolveMenuDepartmentIds();
    const recipeExcludedDepartmentIds = Array.isArray(departmentIds?.recipeExcludedDepartmentIds)
      ? departmentIds.recipeExcludedDepartmentIds
      : [];
    const comboDepartmentId = Number.isInteger(departmentIds?.comboDepartmentId)
      ? departmentIds.comboDepartmentId
      : null;
    const productDepartmentIds = Array.isArray(departmentIds?.productDepartmentIds)
      ? departmentIds.productDepartmentIds
      : [];

    const queryCatalogo = `
      SELECT
        NULL::INTEGER AS id_producto,
        r.id_receta,
        NULL::INTEGER AS id_combo,
        r.nombre_receta AS nombre_producto,
        COALESCE(r.descripcion, '') AS descripcion_producto,
        r.precio,
        NULL::INTEGER AS cantidad,
        NULL::INTEGER AS stock_minimo,
        NULL::INTEGER AS id_categoria_producto,
        NULL::INTEGER AS id_almacen,
        r.id_tipo_departamento,
        COALESCE(r.estado, true) AS estado,
        r.id_archivo AS id_archivo,
        a_receta.url_publica AS url_imagen,
        false AS es_combo
      FROM recetas r
      LEFT JOIN archivos a_receta
        ON a_receta.id_archivo = r.id_archivo
       AND (a_receta.estado = true OR a_receta.estado IS NULL)
      WHERE COALESCE(r.estado, true) = true
        AND r.id_tipo_departamento IS NOT NULL
        AND r.id_tipo_departamento <> ALL($2::INTEGER[])
        AND ($1::INTEGER IS NULL OR r.id_tipo_departamento = $1)

      UNION ALL

      SELECT
        NULL::INTEGER AS id_producto,
        NULL::INTEGER AS id_receta,
        c.id_combo,
        COALESCE(NULLIF(c.nombre_combo, ''), NULLIF(c.descripcion, ''), CONCAT('Combo #', c.id_combo::text)) AS nombre_producto,
        COALESCE(c.descripcion, c.nombre_combo, '') AS descripcion_producto,
        c.precio,
        c.cant_personas AS cantidad,
        NULL::INTEGER AS stock_minimo,
        NULL::INTEGER AS id_categoria_producto,
        NULL::INTEGER AS id_almacen,
        c.id_tipo_departamento,
        COALESCE(c.estado, true) AS estado,
        c.id_archivo,
        a_combo.url_publica AS url_imagen,
        true AS es_combo
      FROM combos c
      LEFT JOIN archivos a_combo
        ON a_combo.id_archivo = c.id_archivo
       AND (a_combo.estado = true OR a_combo.estado IS NULL)
      WHERE COALESCE(c.estado, true) = true
        AND ($3::INTEGER IS NOT NULL AND c.id_tipo_departamento = $3)
        AND ($1::INTEGER IS NULL OR c.id_tipo_departamento = $1)

      UNION ALL

      SELECT
        p.id_producto,
        NULL::INTEGER AS id_receta,
        NULL::INTEGER AS id_combo,
        p.nombre_producto,
        COALESCE(p.descripcion_producto, '') AS descripcion_producto,
        p.precio,
        p.cantidad,
        p.stock_minimo,
        p.id_categoria_producto,
        p.id_almacen,
        p.id_tipo_departamento,
        COALESCE(p.estado, true) AS estado,
        ${productosTieneArchivo ? 'p.id_archivo_imagen_principal' : 'NULL::INTEGER'} AS id_archivo,
        ${productosTieneArchivo ? 'a_producto.url_publica' : 'NULL::VARCHAR'} AS url_imagen,
        false AS es_combo
      FROM productos p
      ${productosTieneArchivo
        ? `LEFT JOIN archivos a_producto
        ON a_producto.id_archivo = p.id_archivo_imagen_principal
       AND (a_producto.estado = true OR a_producto.estado IS NULL)`
        : ''}
      WHERE COALESCE(p.estado, true) = true
        AND p.id_tipo_departamento = ANY($4::INTEGER[])
        AND ($1::INTEGER IS NULL OR p.id_tipo_departamento = $1)
      ORDER BY nombre_producto ASC;
    `;

    const result = await pool.query(queryCatalogo, [
      idTipoDepartamento,
      recipeExcludedDepartmentIds,
      comboDepartmentId,
      productDepartmentIds
    ]);
    const enrichedItems = await enrichCatalogItemsWithSauceConfig(result.rows);

    return res.status(200).json({
      ok: true,
      total: enrichedItems.length,
      data: enrichedItems
    });
  } catch (err) {
    console.error('Error al listar catálogo POS por menu vigente:', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al listar catálogo POS por menu vigente',
      error: err.message
    });
  }
});

router.get('/menu-pos/catalogo-imagenes/:id_tipo_departamento', async (req, res) => {
  try {
    const { id_tipo_departamento } = req.params;
    const idDep = Number(id_tipo_departamento);

    if (Number.isNaN(idDep)) {
      return res.status(400).json({
        ok: false,
        message: 'id_tipo_departamento inválido'
      });
    }

    const productosTieneArchivo = await hasColumn('productos', 'id_archivo_imagen_principal');

    const queryProductosConArchivo = `
      SELECT
        p.id_producto,
        p.nombre_producto,
        p.precio,
        p.cantidad,
        p.stock_minimo,
        p.descripcion_producto,
        p.fecha_ingreso_producto,
        p.fecha_caducidad,
        p.id_categoria_producto,
        p.id_almacen,
        p.id_tipo_departamento,
        p.estado,
        p.id_archivo_imagen_principal AS id_archivo,
        a.url_publica AS url_imagen
      FROM productos p
      LEFT JOIN archivos a
        ON a.id_archivo = p.id_archivo_imagen_principal
       AND (a.estado = true OR a.estado IS NULL)
      WHERE p.id_tipo_departamento = $1
      ORDER BY p.nombre_producto ASC;
    `;

    const queryProductosSinArchivo = `
      SELECT
        p.id_producto,
        p.nombre_producto,
        p.precio,
        p.cantidad,
        p.stock_minimo,
        p.descripcion_producto,
        p.fecha_ingreso_producto,
        p.fecha_caducidad,
        p.id_categoria_producto,
        p.id_almacen,
        p.id_tipo_departamento,
        p.estado,
        NULL::INTEGER AS id_archivo,
        NULL::VARCHAR AS url_imagen
      FROM productos p
      WHERE p.id_tipo_departamento = $1
      ORDER BY p.nombre_producto ASC;
    `;

    const productosResult = await pool.query(
      productosTieneArchivo ? queryProductosConArchivo : queryProductosSinArchivo,
      [idDep]
    );

    const queryCombos = `
      SELECT
        c.id_combo,
        c.id_menu,
        c.nombre_combo,
        c.descripcion,
        c.cant_personas,
        c.precio,
        c.estado,
        c.id_archivo,
        a.url_publica AS url_imagen
      FROM combos c
      LEFT JOIN archivos a
        ON a.id_archivo = c.id_archivo
       AND (a.estado = true OR a.estado IS NULL)
      WHERE (c.estado = true OR c.estado IS NULL)
        AND c.id_tipo_departamento = $1
      ORDER BY c.id_combo DESC;
    `;

    const combosResult = await pool.query(queryCombos, [idDep]);

    return res.status(200).json({
      ok: true,
      productos_tiene_id_archivo_imagen_principal: productosTieneArchivo,
      productos: productosResult.rows,
      combos: combosResult.rows
    });
  } catch (err) {
    console.error('Error al listar catálogo POS con imágenes (HU-36):', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al listar catálogo POS con imágenes',
      error: err.message
    });
  }
});

export default router;
