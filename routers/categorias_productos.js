import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const CATEGORIAS_PRODUCTOS_VIEW_PERMISSIONS = ['INVENTARIO_CATEGORIAS_VER'];
const CATEGORIAS_PRODUCTOS_CREATE_PERMISSIONS = ['INVENTARIO_CATEGORIAS_CREAR'];
const CATEGORIAS_PRODUCTOS_EDIT_PERMISSIONS = ['INVENTARIO_CATEGORIAS_EDITAR'];
const CATEGORIAS_PRODUCTOS_STATE_PERMISSIONS = ['INVENTARIO_CATEGORIAS_ESTADO_CAMBIAR'];
const CATEGORIAS_PRODUCTOS_DELETE_PERMISSIONS = ['INVENTARIO_CATEGORIAS_ELIMINAR'];
const CATEGORY_ACTIVE_PRODUCTS_BLOCK_CODE = 'CATEGORY_HAS_ACTIVE_PRODUCTS';
const CATEGORY_ACTIVE_PRODUCTS_BLOCK_MESSAGE = 'No se puede inactivar la categoria porque tiene productos activos asignados.';
const CATEGORY_ACTIVE_PRODUCTS_PREVIEW_LIMIT = 10;

// NEW: permite incluir inactivos solo bajo solicitud explicita.
// WHY: GET debe devolver activos por defecto tras cambiar a soft delete.
// IMPACT: `?incluir_inactivos=1` mantiene compatibilidad administrativa.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// NEW: normalizador de estado para manejar boolean/string/number sin romper listados.
// WHY: `function_select` puede devolver tipos mixtos segun serializacion/configuracion.
// IMPACT: solo afecta el filtrado de salida en GET.
const isRowActive = (row) => {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
};

// NEW: helper de validacion de IDs positivos.
// WHY: responder 400 antes de llegar a BD con valores invalidos.
// IMPACT: solo endurece validaciones en DELETE; flujo valido no cambia.
const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

// NEW: normaliza entradas booleanas usadas en updates por campo (PUT) para detectar inactivaciones.
// WHY: `pa_update` recibe strings y el frontend puede enviar boolean/0/1/'false'; la regla de negocio debe aplicar igual.
// IMPACT: solo agrega validación previa cuando `campo === "estado"`; no altera otros updates.
const normalizeBooleanInput = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 't', 'si', 'sí', 'on'].includes(raw)) return true;
  if (['false', '0', 'f', 'no', 'off'].includes(raw)) return false;
  return null;
};

// NEW: helper para no exponer mensajes crudos de BD en respuestas 500.
// WHY: evitar filtrar detalles internos al cliente.
// IMPACT: solo cambia copy de errores 500; logs del servidor se mantienen.
const safeServerErrorMessage = (fallback = 'No se pudo completar la acción. Verifica los datos e intenta de nuevo.') => fallback;

// NEW: helpers de payload para endurecer validaciones sin cambiar contratos del módulo.
// WHY: prevenir entradas con estructura inválida o campos inesperados en create/edición completa.
// IMPACT: solo aplica a POST y PUT /edicion.
const PRODUCT_CATEGORY_CREATE_ALLOWED_FIELDS = new Set(['nombre_categoria', 'codigo_categoria', 'descripcion', 'estado']);
const PRODUCT_CATEGORY_FULL_EDIT_ALLOWED_FIELDS = new Set(['id_categoria_producto', 'nombre_categoria', 'codigo_categoria', 'descripcion', 'estado']);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnlyAllowedFields = (payload, allowedSet) => Object.keys(payload).every((key) => allowedSet.has(key));

// AM: resumen reutilizable de productos activos asociados para bloqueo de inactivacion.
const getCategoriaProductoActiveProductsSummary = async (categoriaId) => {
  const query = `
    SELECT
      p.id_producto,
      p.nombre_producto,
      COUNT(*) OVER()::int AS total_count
    FROM productos p
    WHERE p.id_categoria_producto = $1
      AND p.estado = true
    ORDER BY p.id_producto ASC
    LIMIT $2
  `;
  const result = await pool.query(query, [categoriaId, CATEGORY_ACTIVE_PRODUCTS_PREVIEW_LIMIT]);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const total = Number(rows?.[0]?.total_count ?? 0);
  const items = rows.map((row) => ({
    id_producto: Number(row.id_producto),
    nombre: String(row.nombre_producto ?? '')
  }));
  const remaining = Math.max(0, total - items.length);
  return {
    entity: 'categoria_producto',
    blocking_relation: 'productos_activos',
    total,
    items,
    remaining
  };
};

// AM: assertion centralizada para bloquear inactivacion de categoria con productos activos.
const assertCategoriaProductoCanBeDeactivated = async (res, categoriaId) => {
  const dependency_summary = await getCategoriaProductoActiveProductsSummary(categoriaId);
  if (dependency_summary.total <= 0) return true;

  res.status(409).json({
    error: true,
    code: CATEGORY_ACTIVE_PRODUCTS_BLOCK_CODE,
    message: CATEGORY_ACTIVE_PRODUCTS_BLOCK_MESSAGE,
    dependency_summary
  });
  return false;
};

// ------------------------------------------------------------------------------------
// GET: Obtener categorias_productos
// ------------------------------------------------------------------------------------
router.get('/categorias_productos', checkPermission(CATEGORIAS_PRODUCTOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const tabla = 'categorias_productos';
    const columnas = 'id_categoria_producto, nombre_categoria, codigo_categoria, descripcion, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const baseDatos = result.rows[0].resultado || [];
    // NEW: por defecto se devuelven solo categorias activas.
    // WHY: alinear GET con soft delete basado en `estado=false`.
    // IMPACT: admin puede incluir inactivas con `?incluir_inactivos=1`.
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener categorias_productos:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage('No se pudieron cargar las categorías.') });
  }
});

// ------------------------------------------------------------------------------------
// POST: Crear categoria_producto
// ------------------------------------------------------------------------------------
router.post('/categorias_productos', checkPermission(CATEGORIAS_PRODUCTOS_CREATE_PERMISSIONS), async (req, res) => {
  try {
    const tabla = 'categorias_productos';
    const datosEntrada = req.body;
    if (!isPlainObject(datosEntrada)) {
      return res.status(400).json({ error: true, message: 'Payload invalido.' });
    }
    if (!hasOnlyAllowedFields(datosEntrada, PRODUCT_CATEGORY_CREATE_ALLOWED_FIELDS)) {
      return res.status(400).json({ error: true, message: 'El payload contiene campos no permitidos.' });
    }

    const nombre = String(datosEntrada?.nombre_categoria ?? '').trim();
    const codigo = String(datosEntrada?.codigo_categoria ?? '').trim();
    const descripcion = datosEntrada?.descripcion === undefined || datosEntrada?.descripcion === null
      ? ''
      : String(datosEntrada.descripcion).trim();

    if (!nombre) {
      return res.status(400).json({ error: true, message: 'nombre_categoria es obligatorio.' });
    }
    if (!codigo) {
      return res.status(400).json({ error: true, message: 'codigo_categoria es obligatorio.' });
    }
    if (nombre.length < 2 || nombre.length > 50) {
      return res.status(400).json({ error: true, message: 'nombre_categoria debe tener entre 2 y 50 caracteres.' });
    }
    if (codigo.length < 2 || codigo.length > 10) {
      return res.status(400).json({ error: true, message: 'codigo_categoria debe tener entre 2 y 10 caracteres.' });
    }
    if (!/^[A-Z0-9_-]+$/.test(codigo)) {
      return res.status(400).json({ error: true, message: 'codigo_categoria solo permite mayusculas, numeros, - o _.' });
    }

    // NEW: hardening de longitud para descripcion en alta.
    // WHY: evitar rechazo por BD y responder error controlado al cliente.
    // IMPACT: solo bloquea descripciones mayores a 50 caracteres.
    if (descripcion.length > 50) {
      return res.status(400).json({ error: true, message: 'La descripcion no puede exceder 50 caracteres.' });
    }

    const datos = {
      ...datosEntrada,
      nombre_categoria: nombre,
      codigo_categoria: codigo,
      descripcion
    };

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Categoría creada exitosamente.' });

  } catch (err) {
    console.error('Error al crear categoria_producto:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar categoria_producto completa (edicion atomica)
// ------------------------------------------------------------------------------------
router.put('/categorias_productos/edicion', checkPermission(CATEGORIAS_PRODUCTOS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const datosEntrada = req.body;
    if (!isPlainObject(datosEntrada)) {
      return res.status(400).json({ error: true, message: 'Payload invalido.' });
    }
    if (!hasOnlyAllowedFields(datosEntrada, PRODUCT_CATEGORY_FULL_EDIT_ALLOWED_FIELDS)) {
      return res.status(400).json({ error: true, message: 'El payload contiene campos no permitidos.' });
    }

    const {
      id_categoria_producto,
      nombre_categoria,
      codigo_categoria,
      descripcion,
      estado
    } = datosEntrada;

    const categoriaId = Number(id_categoria_producto);
    if (!isPositiveIntegerId(categoriaId)) {
      return res.status(400).json({ error: true, message: 'id_categoria_producto debe ser un entero mayor a 0.' });
    }

    const nombre = String(nombre_categoria ?? '').trim();
    const codigo = String(codigo_categoria ?? '').trim();
    const descripcionNormalizada = descripcion === undefined || descripcion === null
      ? ''
      : String(descripcion).trim();
    const estadoNormalizado = normalizeBooleanInput(estado);

    if (!nombre) {
      return res.status(400).json({ error: true, message: 'nombre_categoria es obligatorio.' });
    }
    if (!codigo) {
      return res.status(400).json({ error: true, message: 'codigo_categoria es obligatorio.' });
    }
    if (nombre.length < 2 || nombre.length > 50) {
      return res.status(400).json({ error: true, message: 'nombre_categoria debe tener entre 2 y 50 caracteres.' });
    }
    if (codigo.length < 2 || codigo.length > 10) {
      return res.status(400).json({ error: true, message: 'codigo_categoria debe tener entre 2 y 10 caracteres.' });
    }
    if (!/^[A-Z0-9_-]+$/.test(codigo)) {
      return res.status(400).json({ error: true, message: 'codigo_categoria solo permite mayusculas, numeros, - o _.' });
    }
    if (descripcionNormalizada.length > 50) {
      return res.status(400).json({ error: true, message: 'La descripcion no puede exceder 50 caracteres.' });
    }
    if (estadoNormalizado === null) {
      return res.status(400).json({ error: true, message: 'estado invalido.' });
    }

    // NEW: conserva la misma regla de negocio para inactivar cuando hay productos activos asociados.
    // WHY: mantener consistencia con DELETE y PUT por campo.
    // IMPACT: solo bloquea cuando la edicion intenta dejar `estado=false` y existen dependencias activas.
    if (estadoNormalizado === false) {
      const canDeactivate = await assertCategoriaProductoCanBeDeactivated(res, categoriaId);
      if (!canDeactivate) return;
    }

    const updateRes = await pool.query(
      `UPDATE categorias_productos
       SET nombre_categoria = $1,
           codigo_categoria = $2,
           descripcion = $3,
           estado = $4
       WHERE id_categoria_producto = $5`,
      [nombre, codigo, descripcionNormalizada, estadoNormalizado, categoriaId]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Categoría no encontrada.' });
    }

    res.status(200).json({ message: 'Categoría actualizada correctamente.' });

  } catch (err) {
    console.error('Error en edicion atomica de categoria_producto:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar categoria_producto (actualiza 1 campo)
// ------------------------------------------------------------------------------------
router.put('/categorias_productos', checkPermission(CATEGORIAS_PRODUCTOS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const isTextField = campo === 'nombre_categoria' || campo === 'codigo_categoria' || campo === 'descripcion';
    const valorSaneado = isTextField ? String(valor ?? '').trim() : valor;

    if (campo === 'nombre_categoria' && !valorSaneado) {
      return res.status(400).json({ error: true, message: 'nombre_categoria es obligatorio.' });
    }
    if (campo === 'codigo_categoria' && !valorSaneado) {
      return res.status(400).json({ error: true, message: 'codigo_categoria es obligatorio.' });
    }
    if (campo === 'nombre_categoria' && (String(valorSaneado).length < 2 || String(valorSaneado).length > 50)) {
      return res.status(400).json({ error: true, message: 'nombre_categoria debe tener entre 2 y 50 caracteres.' });
    }
    if (campo === 'codigo_categoria' && (String(valorSaneado).length < 2 || String(valorSaneado).length > 10)) {
      return res.status(400).json({ error: true, message: 'codigo_categoria debe tener entre 2 y 10 caracteres.' });
    }
    if (campo === 'codigo_categoria' && !/^[A-Z0-9_-]+$/.test(String(valorSaneado))) {
      return res.status(400).json({ error: true, message: 'codigo_categoria solo permite mayusculas, numeros, - o _.' });
    }
    // NEW: hardening de longitud para descripcion en update por campo.
    // WHY: evitar llegar a BD con un valor que excede el limite real.
    // IMPACT: solo aplica cuando `campo` es `descripcion`.
    if (campo === 'descripcion' && String(valorSaneado).length > 50) {
      return res.status(400).json({ error: true, message: 'La descripcion no puede exceder 50 caracteres.' });
    }

    // NEW: aplica la misma regla de bloqueo en PUT cuando el frontend intenta inactivar via `estado=false`.
    // WHY: el drawer de edicion puede cambiar `estado`; la proteccion no debe depender solo de DELETE ni del layout (desktop/responsive).
    // IMPACT: responde 409 estandar en inactivaciones bloqueadas; otros updates siguen igual.
    if (campo === 'estado') {
      const normalizedEstado = normalizeBooleanInput(valor);
      if (normalizedEstado === false) {
        if (id_campo !== 'id_categoria_producto') {
          return res.status(400).json({
            error: true,
            message: 'id_campo invalido. Debe ser exactamente id_categoria_producto para actualizar estado.'
          });
        }
        const categoriaId = Number(id_valor);
        if (!isPositiveIntegerId(categoriaId)) {
          return res.status(400).json({ error: true, message: 'id_valor debe ser un entero mayor a 0.' });
        }
        const canDeactivate = await assertCategoriaProductoCanBeDeactivated(res, categoriaId);
        if (!canDeactivate) return;
      }
    }

    const tabla = 'categorias_productos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';

    await pool.query(query, [
      tabla,
      campo,
      String(valorSaneado),
      id_campo,
      String(id_valor)
    ]);

    res.status(200).json({ message: 'Categoría actualizada correctamente.' });

  } catch (err) {
    console.error('Error al actualizar categoria_producto:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PATCH: Cambiar estado categoria_producto (flujo dedicado activar/inactivar)
// ------------------------------------------------------------------------------------
router.patch('/categorias_productos/estado', checkPermission(CATEGORIAS_PRODUCTOS_STATE_PERMISSIONS), async (req, res) => {
  try {
    const categoriaId = Number(req.body?.id_categoria_producto);
    if (!isPositiveIntegerId(categoriaId)) {
      return res.status(400).json({ error: true, message: 'id_categoria_producto debe ser un entero mayor a 0.' });
    }

    const normalizedEstado = normalizeBooleanInput(req.body?.estado);
    if (normalizedEstado === null) {
      return res.status(400).json({ error: true, message: 'estado invalido.' });
    }

    const categoriaRes = await pool.query(
      'SELECT 1 FROM categorias_productos WHERE id_categoria_producto = $1 LIMIT 1',
      [categoriaId]
    );
    if (categoriaRes.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'CategorÃ­a no encontrada.' });
    }

    if (normalizedEstado === false) {
      const canDeactivate = await assertCategoriaProductoCanBeDeactivated(res, categoriaId);
      if (!canDeactivate) return;
    }

    await pool.query(
      'UPDATE categorias_productos SET estado = $1 WHERE id_categoria_producto = $2',
      [normalizedEstado, categoriaId]
    );

    return res.status(200).json({
      error: false,
      message: normalizedEstado ? 'CategorÃ­a activada.' : 'CategorÃ­a inactivada.'
    });
  } catch (err) {
    console.error('Error al actualizar estado de categoria_producto:', err.message);
    return res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// DELETE: Inactivar categoria_producto (soft delete)
// ------------------------------------------------------------------------------------
router.delete('/categorias_productos', checkPermission(CATEGORIAS_PRODUCTOS_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    // NEW: mantiene la firma actual pero valida la columna esperada.
    // WHY: evitar operaciones arbitrarias y mantener consistencia del contrato.
    // IMPACT: solo responde 400 ante requests mal formados.
    if (columna_id !== 'id_categoria_producto') {
      return res.status(400).json({
        error: true,
        message: 'columna_id invalido. Debe ser exactamente id_categoria_producto.'
      });
    }

    const categoriaId = Number(valor_id);
    if (!isPositiveIntegerId(categoriaId)) {
      return res.status(400).json({ error: true, message: 'valor_id debe ser un entero mayor a 0.' });
    }

    // NEW: 404 explícito para IDs inexistentes.
    // WHY: estandarizar respuestas y evitar "éxito" sobre registros no existentes.
    // IMPACT: solo afecta requests con IDs inválidos/inexistentes.
    const categoriaRes = await pool.query(
      'SELECT 1 FROM categorias_productos WHERE id_categoria_producto = $1 LIMIT 1',
      [categoriaId]
    );
    if (categoriaRes.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Categoría no encontrada.' });
    }

    // NEW: regla de negocio para bloquear inactivación si hay productos activos asociados.
    // WHY: prevenir inconsistencias operativas y cumplir el requisito funcional.
    // IMPACT: responde 409 con código/mensaje estándar; frontend puede manejarlo de forma explícita.
    const canDeactivate = await assertCategoriaProductoCanBeDeactivated(res, categoriaId);
    if (!canDeactivate) return;

    const tabla = 'categorias_productos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, 'estado', 'false', columna_id, String(categoriaId)]);

    res.status(200).json({ error: false, message: 'Categoría inactivada.' });

  } catch (err) {
    console.error('Error al inactivar categoria_producto:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

export default router;
