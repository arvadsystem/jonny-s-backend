import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// NEW: mensaje estándar para bloqueo de inactivación por insumos activos asociados.
// WHY: alinear backend con la regla de negocio para categorías de insumos.
// IMPACT: solo respuestas 409 de DELETE /categorias_insumos; no cambia contratos de entrada.
const CATEGORY_INSUMO_HAS_ACTIVE_ITEMS_MESSAGE = 'NO SE PUEDE INACTIVAR LA CATEGORIA PORQUE TIENE INSUMOS ASIGNADOS. REASIGNA O ACTUALIZA ESOS INSUMOS Y LUEGO INTENTA DE NUEVO.';

// NEW: permite incluir inactivos solo bajo solicitud explícita.
// WHY: GET debe devolver activos por defecto tras migrar a soft delete.
// IMPACT: `?incluir_inactivos=1` habilita vista administrativa sin endpoint nuevo.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// NEW: normaliza el valor de `estado` para soportar boolean/string/number.
// WHY: `function_select` puede serializar booleans de distintas formas según entorno.
// IMPACT: solo afecta el filtrado del GET.
const isRowActive = (row) => {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
};

// NEW: helper para validar IDs enteros positivos.
// WHY: responder 400 antes de invocar SPs/queries con valores inválidos.
// IMPACT: solo endurece validaciones; requests válidos no cambian.
const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

// NEW: normaliza entradas booleanas usadas en updates por campo (PUT) para detectar inactivaciones.
// WHY: `pa_update` recibe strings y el frontend puede enviar boolean/0/1/'false'; la regla debe aplicarse igual.
// IMPACT: solo agrega validación previa cuando `campo === "estado"`; no altera otros updates.
const normalizeBooleanInput = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 't', 'si', 'sí', 'on'].includes(raw)) return true;
  if (['false', '0', 'f', 'no', 'off'].includes(raw)) return false;
  return null;
};

// NEW: mensaje seguro para no exponer detalles internos de BD.
// WHY: evitar mensajes crudos al cliente en errores 500.
// IMPACT: solo cambia el copy de errores 500.
const safeServerErrorMessage = (fallback = 'No se pudo completar la acción. Verifica los datos e intenta de nuevo.') => fallback;

// ------------------------------------------------------------------------------------
// GET: Obtener categorias_insumos
// ------------------------------------------------------------------------------------
router.get('/categorias_insumos', async (req, res) => {
  try {
    const tabla = 'categorias_insumos';
    const columnas = 'id_categoria_insumo, nombre_categoria, codigo_categoria, descripcion, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const baseDatos = result.rows?.[0]?.resultado || [];
    // NEW: por defecto se devuelven solo categorías activas.
    // WHY: alinear GET con la regla de soft delete basada en `estado=false`.
    // IMPACT: admin puede incluir inactivas con `?incluir_inactivos=1`.
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener categorias_insumos:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage('No se pudieron cargar las categorías de insumos.') });
  }
});

// ------------------------------------------------------------------------------------
// POST: Crear categoria_insumo
// ------------------------------------------------------------------------------------
router.post('/categorias_insumos', async (req, res) => {
  try {
    const tabla = 'categorias_insumos';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Categoría de insumo creada exitosamente.' });
  } catch (err) {
    console.error('Error al crear categoria_insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar categoria_insumo (actualiza 1 campo)
// ------------------------------------------------------------------------------------
router.put('/categorias_insumos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    // NEW: aplica la misma regla de bloqueo en PUT cuando el frontend intenta inactivar via `estado=false`.
    // WHY: el drawer de edicion puede cambiar `estado`; backend debe proteger igual en desktop/responsive.
    // IMPACT: responde 409 estandar en inactivaciones bloqueadas; otros updates siguen intactos.
    if (campo === 'estado') {
      const normalizedEstado = normalizeBooleanInput(valor);
      if (normalizedEstado === false) {
        if (id_campo !== 'id_categoria_insumo') {
          return res.status(400).json({
            error: true,
            message: 'id_campo invalido. Debe ser exactamente id_categoria_insumo para actualizar estado.'
          });
        }
        const categoriaId = Number(id_valor);
        if (!isPositiveIntegerId(categoriaId)) {
          return res.status(400).json({ error: true, message: 'id_valor debe ser un entero mayor a 0.' });
        }
        const insumosActivosRes = await pool.query(
          'SELECT COUNT(1)::int AS total FROM insumos WHERE id_categoria_insumo = $1 AND estado = true',
          [categoriaId]
        );
        const totalInsumosActivos = Number(insumosActivosRes.rows?.[0]?.total ?? 0);
        if (totalInsumosActivos > 0) {
          return res.status(409).json({
            error: true,
            code: 'CATEGORY_INSUMO_HAS_ACTIVE_ITEMS',
            message: CATEGORY_INSUMO_HAS_ACTIVE_ITEMS_MESSAGE
          });
        }
      }
    }

    const tabla = 'categorias_insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';

    await pool.query(query, [
      tabla,
      campo,
      String(valor),
      id_campo,
      String(id_valor)
    ]);

    res.status(200).json({ message: 'Categoría de insumo actualizada correctamente.' });
  } catch (err) {
    console.error('Error al actualizar categoria_insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// DELETE: Inactivar categoria_insumo (soft delete)
// ------------------------------------------------------------------------------------
router.delete('/categorias_insumos', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    // NEW: mantiene la firma actual pero valida la columna esperada.
    // WHY: evitar operaciones arbitrarias y conservar el contrato retrocompatible.
    // IMPACT: solo responde 400 en requests mal formados.
    if (columna_id !== 'id_categoria_insumo') {
      return res.status(400).json({
        error: true,
        message: 'columna_id invalido. Debe ser exactamente id_categoria_insumo.'
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
      'SELECT 1 FROM categorias_insumos WHERE id_categoria_insumo = $1 LIMIT 1',
      [categoriaId]
    );
    if (categoriaRes.rowCount === 0) {
      return res.status(404).json({ error: true, code: 'CATEGORY_INSUMO_NOT_FOUND', message: 'Categoría de insumo no encontrada.' });
    }

    // NEW: regla de negocio para bloquear inactivación si hay insumos activos asociados.
    // WHY: evitar dejar insumos activos ligados a categorías inactivas.
    // IMPACT: responde 409 con código/mensaje estándar para manejo explícito en frontend.
    const insumosActivosRes = await pool.query(
      'SELECT COUNT(1)::int AS total FROM insumos WHERE id_categoria_insumo = $1 AND estado = true',
      [categoriaId]
    );
    const totalInsumosActivos = Number(insumosActivosRes.rows?.[0]?.total ?? 0);
    if (totalInsumosActivos > 0) {
      return res.status(409).json({
        error: true,
        code: 'CATEGORY_INSUMO_HAS_ACTIVE_ITEMS',
        message: CATEGORY_INSUMO_HAS_ACTIVE_ITEMS_MESSAGE
      });
    }

    const tabla = 'categorias_insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, 'estado', 'false', columna_id, String(categoriaId)]);

    res.status(200).json({ error: false, message: 'Categoría de insumo inactivada.' });
  } catch (err) {
    console.error('Error al inactivar categoria_insumo:', err.message);
    res.status(500).json({ error: true, code: 'INTERNAL_ERROR', message: safeServerErrorMessage() });
  }
});

export default router;
