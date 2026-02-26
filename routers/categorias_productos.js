import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// NEW: mensaje estandar para bloqueo de inactivacion por productos activos asociados.
// WHY: alinear backend con la regla de negocio y el copy requerido por frontend.
// IMPACT: solo respuestas 409 de DELETE /categorias_productos; no cambia contratos de entrada.
const CATEGORY_HAS_ACTIVE_PRODUCTS_MESSAGE = 'NO SE PUEDE INACTIVAR LA CATEGORIA PORQUE TIENE PRODUCTOS ASIGNADOS. REASIGNA O ACTUALIZA ESOS PRODUCTOS Y LUEGO INTENTA DE NUEVO.';

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

// NEW: helper para no exponer mensajes crudos de BD en respuestas 500.
// WHY: evitar filtrar detalles internos al cliente.
// IMPACT: solo cambia copy de errores 500; logs del servidor se mantienen.
const safeServerErrorMessage = (fallback = 'No se pudo completar la acción. Verifica los datos e intenta de nuevo.') => fallback;

// ------------------------------------------------------------------------------------
// GET: Obtener categorias_productos
// ------------------------------------------------------------------------------------
router.get('/categorias_productos', async (req, res) => {
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
router.post('/categorias_productos', async (req, res) => {
  try {
    const tabla = 'categorias_productos';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Categoría creada exitosamente.' });

  } catch (err) {
    console.error('Error al crear categoria_producto:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar categoria_producto (actualiza 1 campo)
// ------------------------------------------------------------------------------------
router.put('/categorias_productos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'categorias_productos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';

    await pool.query(query, [
      tabla,
      campo,
      String(valor),
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
// DELETE: Inactivar categoria_producto (soft delete)
// ------------------------------------------------------------------------------------
router.delete('/categorias_productos', async (req, res) => {
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
    const productosActivosRes = await pool.query(
      'SELECT COUNT(*)::int AS total FROM productos WHERE id_categoria_producto = $1 AND estado = true',
      [categoriaId]
    );
    const totalProductosActivos = Number(productosActivosRes.rows?.[0]?.total ?? 0);
    if (totalProductosActivos > 0) {
      return res.status(409).json({
        error: true,
        code: 'CATEGORY_HAS_ACTIVE_PRODUCTS',
        message: CATEGORY_HAS_ACTIVE_PRODUCTS_MESSAGE
      });
    }

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
