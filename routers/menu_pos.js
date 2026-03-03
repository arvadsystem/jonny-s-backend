import express from 'express'; // Importa Express para crear rutas
import pool from '../config/db-connection.js'; // Pool de conexión PostgreSQL

const router = express.Router(); // Inicializa router

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

const getArchivoById = async (idArchivo) => {
  const query = `
    SELECT id_archivo, estado
    FROM archivos
    WHERE id_archivo = $1
    LIMIT 1;
  `;
  const result = await pool.query(query, [idArchivo]);
  return result.rows[0] || null;
};

// NUEVO: helper para soportar boolean real o representaciones string/número
const esProductoActivo = (estado) =>
  estado === true || estado === 'true' || estado === 1 || estado === '1';

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
// MÓDULO 6 - MENÚ / POS
// HU-65: Listar productos por categoría (tipo_departamento)
// - SOLO LECTURA
// - NO CRUD de productos
// - Usa function_select
// =====================================================

// =====================================================
// GET: Categorias visibles del carrusel POS
// URL: /menu-pos/categorias
// =====================================================
router.get('/menu-pos/categorias', async (req, res) => {
  try {
    const queryCategorias = `
      WITH categorias_menu AS (
        SELECT r.id_tipo_departamento
        FROM recetas r
        WHERE COALESCE(r.estado, true) = true
          AND r.id_tipo_departamento IS NOT NULL
          AND r.id_tipo_departamento NOT IN (11, 12, 13, 14, 15, 19)

        UNION

        SELECT c.id_tipo_departamento
        FROM combos c
        WHERE COALESCE(c.estado, true) = true
          AND c.id_tipo_departamento = 19

        UNION

        SELECT p.id_tipo_departamento
        FROM productos p
        WHERE COALESCE(p.estado, true) = true
          AND p.id_tipo_departamento IN (12, 13, 14, 15)
      )
      SELECT
        td.id_tipo_departamento,
        td.nombre_departamento,
        td.orden_menu
      FROM categorias_menu cm
      INNER JOIN tipo_departamento td
        ON td.id_tipo_departamento = cm.id_tipo_departamento
      WHERE COALESCE(td.estado, true) = true
        AND td.id_tipo_departamento <> 11
      ORDER BY
        COALESCE(td.orden_menu, 2147483647),
        td.nombre_departamento ASC;
    `;

    const result = await pool.query(queryCategorias);

    return res.status(200).json({
      ok: true,
      total: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    console.error('Error al listar categorias del menu POS:', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al listar categorias del menu POS',
      error: err.message
    });
  }
});

// =====================================================
// GET: Productos por categoría (POS)
// URL: /menu-pos/productos/:id_tipo_departamento
// Ej: /menu-pos/productos/9  -> Tacos de Birria
// =====================================================
router.get('/menu-pos/productos/:id_tipo_departamento', async (req, res) => {
  try {
    // 1) Obtener id del departamento desde la URL
    const { id_tipo_departamento } = req.params;

    const idDep = Number(id_tipo_departamento); // Convertir a número
    if (Number.isNaN(idDep)) {
      return res.status(400).json({
        ok: false,
        message: 'id_tipo_departamento inválido'
      }); // Validación básica
    }

    // 2) Leer TODOS los productos (solo lectura)
    const tabla = 'productos'; // Tabla productos (NO CRUD)
    // AJUSTE: se agrega estado para filtrar productos activos
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento, estado';

    const query = 'SELECT function_select($1, $2) as resultado'; // Select estándar del proyecto
    const result = await pool.query(query, [tabla, columnas]);

    const productos = result.rows[0].resultado || []; // Lista completa

    // NUEVO: filtrar por categoría y por estado activo
    const productosFiltrados = productos.filter(
      (p) => Number(p.id_tipo_departamento) === idDep && esProductoActivo(p.estado)
    );

    // 4) Ordenar por nombre (para el POS)
    productosFiltrados.sort((a, b) =>
      String(a.nombre_producto || '').localeCompare(
        String(b.nombre_producto || ''),
        'es',
        { sensitivity: 'base' }
      )
    );

    // 5) Respuesta final
    return res.status(200).json({
      ok: true,
      total: productosFiltrados.length,
      data: productosFiltrados
    });
  } catch (err) {
    console.error('Error al listar productos del menú (HU-65):', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al listar productos del menú',
      error: err.message
    });
  }
});

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

    const queryCatalogo = `
      SELECT
        p.id_producto,
        r.id_receta,
        NULL::INTEGER AS id_combo,
        r.nombre_receta AS nombre_producto,
        COALESCE(r.descripcion, p.descripcion_producto, '') AS descripcion_producto,
        p.precio,
        p.cantidad,
        p.stock_minimo,
        p.id_categoria_producto,
        p.id_almacen,
        r.id_tipo_departamento,
        COALESCE(r.estado, true) AS estado,
        ${productosTieneArchivo ? 'p.id_archivo_imagen_principal' : 'NULL::INTEGER'} AS id_archivo,
        ${productosTieneArchivo ? 'a_receta.url_publica' : 'NULL::VARCHAR'} AS url_imagen,
        false AS es_combo
      FROM recetas r
      INNER JOIN productos p
        ON p.id_producto = r.id_producto
      ${productosTieneArchivo
        ? `LEFT JOIN archivos a_receta
        ON a_receta.id_archivo = p.id_archivo_imagen_principal
       AND (a_receta.estado = true OR a_receta.estado IS NULL)`
        : ''}
      WHERE COALESCE(r.estado, true) = true
        AND r.id_tipo_departamento IS NOT NULL
        AND r.id_tipo_departamento NOT IN (11, 12, 13, 14, 15, 19)
        AND ($1::INTEGER IS NULL OR r.id_tipo_departamento = $1)

      UNION ALL

      SELECT
        NULL::INTEGER AS id_producto,
        NULL::INTEGER AS id_receta,
        c.id_combo,
        COALESCE(c.descripcion, CONCAT('Combo #', c.id_combo::text)) AS nombre_producto,
        COALESCE(c.descripcion, '') AS descripcion_producto,
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
        AND c.id_tipo_departamento = 19
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
        AND p.id_tipo_departamento IN (12, 13, 14, 15)
        AND ($1::INTEGER IS NULL OR p.id_tipo_departamento = $1)
      ORDER BY nombre_producto ASC;
    `;

    const result = await pool.query(queryCatalogo, [idTipoDepartamento]);
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
      WHERE c.estado = true OR c.estado IS NULL
      ORDER BY c.id_combo DESC;
    `;

    const combosResult = await pool.query(queryCombos);

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

// =====================================================
// HU-36
// POST: Registro de archivo para imagen de POS
// URL: /menu-pos/archivos/upload
// Nota: este endpoint registra metadata + URL pública (no maneja carga binaria)
// =====================================================
router.post('/menu-pos/archivos/upload', async (req, res) => {
  try {
    const {
      nombre_original,
      url_publica,
      tipo_archivo = null,
      tamano_bytes = null,
      id_usuario = null
    } = req.body || {};

    if (!nombre_original || !url_publica) {
      return res.status(400).json({
        ok: false,
        message: 'Faltan campos obligatorios: nombre_original, url_publica'
      });
    }

    const size = tamano_bytes === null || tamano_bytes === undefined
      ? null
      : Number(tamano_bytes);

    if (size !== null && (Number.isNaN(size) || size < 0)) {
      return res.status(400).json({
        ok: false,
        message: 'tamano_bytes inválido'
      });
    }

    const idUser = id_usuario === null || id_usuario === undefined
      ? null
      : Number(id_usuario);

    if (idUser !== null && Number.isNaN(idUser)) {
      return res.status(400).json({
        ok: false,
        message: 'id_usuario inválido'
      });
    }

    const tabla = 'archivos';
    const datos = {
      nombre_original: String(nombre_original),
      url_publica: String(url_publica),
      tipo_archivo: tipo_archivo ? String(tipo_archivo) : null,
      tamano_bytes: size,
      fecha_creacion: new Date().toISOString(),
      estado: true,
      id_usuario: idUser
    };

    await pool.query('CALL pa_insert($1, $2)', [tabla, datos]);

    const seqQuery = `
      SELECT currval(pg_get_serial_sequence('public.archivos', 'id_archivo')) AS id_archivo;
    `;
    const seqResult = await pool.query(seqQuery);
    const nuevoIdArchivo = seqResult.rows[0]?.id_archivo;

    const selectQuery = `
      SELECT id_archivo, nombre_original, url_publica, tipo_archivo, tamano_bytes, fecha_creacion, estado, id_usuario
      FROM archivos
      WHERE id_archivo = $1
      LIMIT 1;
    `;
    const result = await pool.query(selectQuery, [nuevoIdArchivo]);

    return res.status(201).json({
      ok: true,
      message: 'Archivo registrado exitosamente.',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error al registrar archivo (HU-36):', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al registrar archivo',
      error: err.message
    });
  }
});

// =====================================================
// HU-36
// PUT: Asignar imagen a producto
// URL: /menu-pos/productos/:id_producto/imagen
// Body: { id_archivo }
// =====================================================
router.put('/menu-pos/productos/:id_producto/imagen', async (req, res) => {
  try {
    const idProducto = Number(req.params.id_producto);
    const { id_archivo } = req.body || {};

    if (Number.isNaN(idProducto)) {
      return res.status(400).json({ ok: false, message: 'id_producto inválido' });
    }

    if (id_archivo === undefined) {
      return res.status(400).json({
        ok: false,
        message: 'Debe enviar id_archivo'
      });
    }

    const productosTieneArchivo = await hasColumn('productos', 'id_archivo_imagen_principal');
    if (!productosTieneArchivo) {
      return res.status(409).json({
        ok: false,
        message: 'La tabla productos no tiene la columna id_archivo_imagen_principal en el esquema actual.',
        pending_schema_change: 'Aplicar productos.id_archivo_imagen_principal con FK a archivos(id_archivo).'
      });
    }

    const idArchivo = Number(id_archivo);
    if (Number.isNaN(idArchivo)) {
      return res.status(400).json({ ok: false, message: 'id_archivo inválido' });
    }

    const archivo = await getArchivoById(idArchivo);
    if (!archivo) {
      return res.status(404).json({ ok: false, message: 'Archivo no encontrado.' });
    }
    if (archivo.estado === false) {
      return res.status(409).json({ ok: false, message: 'No se puede asignar un archivo inactivo.' });
    }

    const productoQuery = `
      SELECT id_producto
      FROM productos
      WHERE id_producto = $1
      LIMIT 1;
    `;
    const productoResult = await pool.query(productoQuery, [idProducto]);
    if (productoResult.rowCount === 0) {
      return res.status(404).json({ ok: false, message: 'Producto no encontrado.' });
    }

    await pool.query('CALL pa_update($1, $2, $3, $4, $5)', [
      'productos',
      'id_archivo_imagen_principal',
      String(idArchivo),
      'id_producto',
      String(idProducto)
    ]);

    const result = await pool.query(
      `
        SELECT id_producto, id_archivo_imagen_principal AS id_archivo
        FROM productos
        WHERE id_producto = $1
        LIMIT 1;
      `,
      [idProducto]
    );

    return res.status(200).json({
      ok: true,
      message: 'Imagen asignada al producto correctamente.',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error al asignar imagen a producto (HU-36):', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al asignar imagen a producto',
      error: err.message
    });
  }
});

// =====================================================
// HU-36
// PUT: Asignar imagen a combo
// URL: /menu-pos/combos/:id_combo/imagen
// Body: { id_archivo }
// =====================================================
router.put('/menu-pos/combos/:id_combo/imagen', async (req, res) => {
  try {
    const idCombo = Number(req.params.id_combo);
    const { id_archivo } = req.body || {};

    if (Number.isNaN(idCombo)) {
      return res.status(400).json({ ok: false, message: 'id_combo inválido' });
    }

    if (id_archivo === undefined) {
      return res.status(400).json({
        ok: false,
        message: 'Debe enviar id_archivo'
      });
    }

    const idArchivo = Number(id_archivo);
    if (Number.isNaN(idArchivo)) {
      return res.status(400).json({ ok: false, message: 'id_archivo inválido' });
    }

    const archivo = await getArchivoById(idArchivo);
    if (!archivo) {
      return res.status(404).json({ ok: false, message: 'Archivo no encontrado.' });
    }
    if (archivo.estado === false) {
      return res.status(409).json({ ok: false, message: 'No se puede asignar un archivo inactivo.' });
    }

    const comboQuery = `
      SELECT id_combo
      FROM combos
      WHERE id_combo = $1
      LIMIT 1;
    `;
    const comboResult = await pool.query(comboQuery, [idCombo]);
    if (comboResult.rowCount === 0) {
      return res.status(404).json({ ok: false, message: 'Combo no encontrado.' });
    }

    await pool.query('CALL pa_update($1, $2, $3, $4, $5)', [
      'combos',
      'id_archivo',
      String(idArchivo),
      'id_combo',
      String(idCombo)
    ]);

    const result = await pool.query(
      `
        SELECT id_combo, id_archivo
        FROM combos
        WHERE id_combo = $1
        LIMIT 1;
      `,
      [idCombo]
    );

    return res.status(200).json({
      ok: true,
      message: 'Imagen asignada al combo correctamente.',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error al asignar imagen a combo (HU-36):', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al asignar imagen a combo',
      error: err.message
    });
  }
});

// =====================================================
// HU-36
// PUT: Soft delete de archivo
// URL: /menu-pos/archivos/:id_archivo/soft-delete
// =====================================================
router.put('/menu-pos/archivos/:id_archivo/soft-delete', async (req, res) => {
  try {
    const idArchivo = Number(req.params.id_archivo);

    if (Number.isNaN(idArchivo)) {
      return res.status(400).json({ ok: false, message: 'id_archivo inválido' });
    }

    const archivo = await getArchivoById(idArchivo);
    if (!archivo) {
      return res.status(404).json({ ok: false, message: 'Archivo no encontrado.' });
    }

    await pool.query('CALL pa_update($1, $2, $3, $4, $5)', [
      'archivos',
      'estado',
      'false',
      'id_archivo',
      String(idArchivo)
    ]);

    const result = await pool.query(
      `
        SELECT id_archivo, estado
        FROM archivos
        WHERE id_archivo = $1
        LIMIT 1;
      `,
      [idArchivo]
    );

    return res.status(200).json({
      ok: true,
      message: 'Archivo desactivado correctamente (soft delete).',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error en soft delete de archivo (HU-36):', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al desactivar archivo',
      error: err.message
    });
  }
});

export default router; // Exporta router
