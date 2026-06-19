import express from 'express'; // Importa Express para crear rutas
import pool from '../config/db-connection.js'; // Pool de conexión PostgreSQL
import { checkPermission } from '../middleware/checkPermission.js';
import menuPosCatalogoRouter from './menu_pos_catalogo.js'; // Subrouter de catÃ¡logo POS
import { resolveMenuDepartmentIds } from './menu_departamentos.js';
import { SUPABASE_ADMIN_BUCKET, SUPABASE_ASSETS_BUCKET } from '../utils/uploads.js';

const router = express.Router(); // Inicializa router
const MENU_POS_VIEW_PERMISSIONS = ['MENU_POS_VER', 'MENU_VER'];
const MENU_POS_ARCHIVOS_UPLOAD_PERMISSIONS = ['MENU_POS_ARCHIVOS_SUBIR', 'MENU_VER'];
const MENU_POS_PRODUCT_IMAGE_PERMISSIONS = ['MENU_POS_PRODUCTOS_IMAGEN_EDITAR', 'MENU_VER'];
const MENU_POS_COMBO_IMAGE_PERMISSIONS = ['MENU_POS_COMBOS_IMAGEN_EDITAR', 'MENU_VER'];
const MENU_POS_ARCHIVOS_DELETE_PERMISSIONS = ['MENU_POS_ARCHIVOS_ELIMINAR', 'MENU_VER'];

const getSafeServerErrorMessage = (fallback = 'Error interno del servidor.') => fallback;

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

const getDriveFileIdFromUrl = (rawUrl) => {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return '';

  try {
    const parsed = new URL(safeUrl);
    const host = String(parsed.hostname || '').toLowerCase();
    const isDrive =
      host.includes('drive.google.com') ||
      host.includes('drive.usercontent.google.com') ||
      host.includes('lh3.googleusercontent.com');

    if (!isDrive) return '';

    const path = String(parsed.pathname || '');
    const fromPath =
      path.match(/\/file\/d\/([^/?#]+)/i)?.[1] ||
      path.match(/\/d\/([^/?#]+)/i)?.[1] ||
      '';
    const fromQuery = String(parsed.searchParams.get('id') || '').trim();
    return String(fromPath || fromQuery).trim();
  } catch {
    return '';
  }
};

const getDriveResourceKeyFromUrl = (rawUrl) => {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return '';

  try {
    const parsed = new URL(safeUrl);
    return String(parsed.searchParams.get('resourcekey') || '').trim();
  } catch {
    return '';
  }
};

// Normaliza enlaces de Drive a URL de imagen renderizable en <img>.
const normalizeDriveImageUrl = (rawUrl) => {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return safeUrl;

  const fileId = getDriveFileIdFromUrl(safeUrl);
  if (!fileId) return safeUrl;

  const resourceKey = getDriveResourceKeyFromUrl(safeUrl);
  const resourceKeySuffix = resourceKey
    ? `&resourcekey=${encodeURIComponent(resourceKey)}`
    : '';

  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1200${resourceKeySuffix}`;
};

// Normaliza URL publica de Supabase al formato interno "bucket/ruta".
// Mantener este formato en BD facilita usar el mismo contrato de imagen que otros modulos.
const toSupabaseBucketPathFromPublicUrl = (rawUrl) => {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return '';

  if (safeUrl.startsWith(`${SUPABASE_ASSETS_BUCKET}/`) || safeUrl.startsWith(`${SUPABASE_ADMIN_BUCKET}/`)) {
    return safeUrl;
  }

  try {
    const parsed = new URL(safeUrl);
    const decodedPath = decodeURIComponent(String(parsed.pathname || ''));
    const publicObjectMarker = '/storage/v1/object/public/';
    const markerIndex = decodedPath.indexOf(publicObjectMarker);
    if (markerIndex < 0) return '';

    const remainder = decodedPath.slice(markerIndex + publicObjectMarker.length).replace(/^\/+/, '');
    const parts = remainder.split('/').filter(Boolean);
    if (parts.length < 2) return '';

    const bucket = String(parts[0] || '').trim();
    const filePath = parts.slice(1).join('/');
    if (!bucket || !filePath) return '';

    return `${bucket}/${filePath}`;
  } catch {
    return '';
  }
};

// Canoniza URL para imagen de menu:
// 1) Si viene URL publica de Supabase, la convertimos a "bucket/ruta".
// 2) Si no, mantenemos fallback de Google Drive para compatibilidad.
const normalizeMenuImageUrlForStorage = (rawUrl) => {
  const supabaseBucketPath = toSupabaseBucketPathFromPublicUrl(rawUrl);
  if (supabaseBucketPath) return supabaseBucketPath;
  return normalizeDriveImageUrl(rawUrl);
};

// NUEVO: helper para soportar boolean real o representaciones string/nÃºmero
const esProductoActivo = (estado) =>
  estado === true || estado === 'true' || estado === 1 || estado === '1';

// =====================================================
// MÃ“DULO 6 - MENÃš / POS
// HU-65: Listar productos por categorÃ­a (tipo_departamento)
// - SOLO LECTURA
// - NO CRUD de productos
// - Usa function_select
// =====================================================

// =====================================================
// GET: Categorias visibles del carrusel POS
// URL: /menu-pos/categorias
// =====================================================
router.get('/menu-pos/categorias', checkPermission(MENU_POS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    // Resuelve IDs por nombre para evitar dependencia de IDs fijos.
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

    const queryCategorias = `
      WITH categorias_menu AS (
        SELECT r.id_tipo_departamento
        FROM recetas r
        WHERE COALESCE(r.estado, true) = true
          AND r.id_tipo_departamento IS NOT NULL
          AND r.id_tipo_departamento <> ALL($1::INTEGER[])

        UNION

        SELECT c.id_tipo_departamento
        FROM combos c
        WHERE COALESCE(c.estado, true) = true
          AND ($2::INTEGER IS NOT NULL AND c.id_tipo_departamento = $2)

        UNION

        SELECT p.id_tipo_departamento
        FROM productos p
        WHERE COALESCE(p.estado, true) = true
          AND p.id_tipo_departamento = ANY($3::INTEGER[])
      )
      SELECT
        td.id_tipo_departamento,
        td.nombre_departamento,
        td.orden_menu
      FROM categorias_menu cm
      INNER JOIN tipo_departamento td
        ON td.id_tipo_departamento = cm.id_tipo_departamento
      WHERE COALESCE(td.estado, true) = true
      ORDER BY
        COALESCE(td.orden_menu, 2147483647),
        td.nombre_departamento ASC;
    `;

    const result = await pool.query(queryCategorias, [
      recipeExcludedDepartmentIds,
      comboDepartmentId,
      productDepartmentIds
    ]);

    return res.status(200).json({
      ok: true,
      total: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    console.error('Error al listar categorias del menu POS:', err.message);
    return res.status(500).json({
      ok: false,
      message: getSafeServerErrorMessage('Error al listar categorias del menu POS')
    });
  }
});

// =====================================================
// GET: Productos por categorÃ­a (POS)
// URL: /menu-pos/productos/:id_tipo_departamento
// Ej: /menu-pos/productos/9  -> Tacos de Birria
// =====================================================
router.get('/menu-pos/productos/:id_tipo_departamento', checkPermission(MENU_POS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    // 1) Obtener id del departamento desde la URL
    const { id_tipo_departamento } = req.params;

    const idDep = Number(id_tipo_departamento); // Convertir a nÃºmero
    if (Number.isNaN(idDep)) {
      return res.status(400).json({
        ok: false,
        message: 'id_tipo_departamento invÃ¡lido'
      }); // ValidaciÃ³n bÃ¡sica
    }

    // 2) Leer TODOS los productos (solo lectura)
    const tabla = 'productos'; // Tabla productos (NO CRUD)
    // AJUSTE: se agrega estado para filtrar productos activos
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento, estado';

    const query = 'SELECT function_select($1, $2) as resultado'; // Select estÃ¡ndar del proyecto
    const result = await pool.query(query, [tabla, columnas]);

    const productos = result.rows[0].resultado || []; // Lista completa

    // NUEVO: filtrar por categorÃ­a y por estado activo
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
    console.error('Error al listar productos del menÃº (HU-65):', err.message);
    return res.status(500).json({
      ok: false,
      message: getSafeServerErrorMessage('Error al listar productos del menu')
    });
  }
});

// CatÃ¡logo POS movido a subrouter interno para mantener este archivo mÃ¡s manejable.
router.use(menuPosCatalogoRouter);

// =====================================================
// HU-36
// POST: Registro de archivo para imagen de POS
// URL: /menu-pos/archivos/upload
// Nota: este endpoint registra metadata + URL pÃºblica (no maneja carga binaria)
// =====================================================
router.post('/menu-pos/archivos/upload', checkPermission(MENU_POS_ARCHIVOS_UPLOAD_PERMISSIONS), async (req, res) => {
  try {
    const {
      nombre_original,
      url_publica,
      bucket = SUPABASE_ASSETS_BUCKET,
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

    const normalizedBucket = String(bucket || SUPABASE_ASSETS_BUCKET).trim() || SUPABASE_ASSETS_BUCKET;
    // Las imagenes del menu publico deben vivir en el bucket publico oficial.
    if (normalizedBucket !== SUPABASE_ASSETS_BUCKET) {
      return res.status(400).json({
        ok: false,
        message: `Bucket invalido para imagenes de menu. Usa '${SUPABASE_ASSETS_BUCKET}'.`
      });
    }

    const size = tamano_bytes === null || tamano_bytes === undefined
      ? null
      : Number(tamano_bytes);

    if (size !== null && (Number.isNaN(size) || size < 0)) {
      return res.status(400).json({
        ok: false,
        message: 'tamano_bytes invÃ¡lido'
      });
    }

    const idUser = id_usuario === null || id_usuario === undefined
      ? null
      : Number(id_usuario);

    if (idUser !== null && Number.isNaN(idUser)) {
      return res.status(400).json({
        ok: false,
        message: 'id_usuario invÃ¡lido'
      });
    }

    // INSERT explicito para evitar desalineaciones de columnas/valores en pa_insert.
    // Se fuerza estado=true para que el archivo sea visible en JOINs que filtran activos.
    const insertQuery = `
      INSERT INTO archivos (
        nombre_original,
        url_publica,
        tipo_archivo,
        tamano_bytes,
        estado,
        id_usuario
      ) VALUES ($1, $2, $3, $4, true, $5)
      RETURNING id_archivo, nombre_original, url_publica, tipo_archivo, tamano_bytes, fecha_creacion, estado, id_usuario;
    `;

    const normalizedUrl = normalizeMenuImageUrlForStorage(url_publica);
    if (!String(normalizedUrl || '').trim()) {
      return res.status(400).json({
        ok: false,
        message: 'No se pudo normalizar la URL de imagen enviada.'
      });
    }

    // Proteccion adicional: evita registrar documentos privados en flujo de menu.
    if (String(normalizedUrl).startsWith(`${SUPABASE_ADMIN_BUCKET}/`)) {
      return res.status(400).json({
        ok: false,
        message: `No se permite el bucket privado '${SUPABASE_ADMIN_BUCKET}' para imagenes de menu.`
      });
    }

    const result = await pool.query(insertQuery, [
      String(nombre_original),
      normalizedUrl,
      tipo_archivo ? String(tipo_archivo) : null,
      size,
      idUser
    ]);

    return res.status(201).json({
      ok: true,
      message: 'Archivo registrado exitosamente.',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error al registrar archivo (HU-36):', err.message);
    return res.status(500).json({
      ok: false,
      message: getSafeServerErrorMessage('Error al registrar archivo')
    });
  }
});

// =====================================================
// HU-36
// PUT: Asignar imagen a producto
// URL: /menu-pos/productos/:id_producto/imagen
// Body: { id_archivo }
// =====================================================
router.put('/menu-pos/productos/:id_producto/imagen', checkPermission(MENU_POS_PRODUCT_IMAGE_PERMISSIONS), async (req, res) => {
  try {
    const idProducto = Number(req.params.id_producto);
    const { id_archivo } = req.body || {};

    if (Number.isNaN(idProducto)) {
      return res.status(400).json({ ok: false, message: 'id_producto invÃ¡lido' });
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
      return res.status(400).json({ ok: false, message: 'id_archivo invÃ¡lido' });
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
      message: getSafeServerErrorMessage('Error al asignar imagen a producto')
    });
  }
});

// =====================================================
// HU-36
// PUT: Asignar imagen a combo
// URL: /menu-pos/combos/:id_combo/imagen
// Body: { id_archivo }
// =====================================================
router.put('/menu-pos/combos/:id_combo/imagen', checkPermission(MENU_POS_COMBO_IMAGE_PERMISSIONS), async (req, res) => {
  try {
    const idCombo = Number(req.params.id_combo);
    const { id_archivo } = req.body || {};

    if (Number.isNaN(idCombo)) {
      return res.status(400).json({ ok: false, message: 'id_combo invÃ¡lido' });
    }

    if (id_archivo === undefined) {
      return res.status(400).json({
        ok: false,
        message: 'Debe enviar id_archivo'
      });
    }

    const idArchivo = Number(id_archivo);
    if (Number.isNaN(idArchivo)) {
      return res.status(400).json({ ok: false, message: 'id_archivo invÃ¡lido' });
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
      message: getSafeServerErrorMessage('Error al asignar imagen a combo')
    });
  }
});

// =====================================================
// HU-36
// PUT: Soft delete de archivo
// URL: /menu-pos/archivos/:id_archivo/soft-delete
// =====================================================
router.put('/menu-pos/archivos/:id_archivo/soft-delete', checkPermission(MENU_POS_ARCHIVOS_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const idArchivo = Number(req.params.id_archivo);

    if (Number.isNaN(idArchivo)) {
      return res.status(400).json({ ok: false, message: 'id_archivo invÃ¡lido' });
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
      message: getSafeServerErrorMessage('Error al desactivar archivo')
    });
  }
});

export default router; // Exporta router





