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

// =====================================================
// MÓDULO 6 - MENÚ / POS
// HU-65: Listar productos por categoría (tipo_departamento)
// - SOLO LECTURA
// - NO CRUD de productos
// - Usa function_select
// =====================================================

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
// URL: /menu-pos/catalogo-imagenes/:id_tipo_departamento
// Nota: si productos.id_archivo_imagen_principal no existe en BD, productos se devuelven con url_imagen = null
// =====================================================
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
