import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// NEW: permite incluir inactivos solo cuando el cliente lo solicita explicitamente.
// WHY: el listado por defecto debe devolver solo registros activos tras migrar a soft delete.
// IMPACT: mantiene compatibilidad agregando soporte opt-in `?incluir_inactivos=1`.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// NEW: normaliza el valor de `estado` para soportar boolean/string/number.
// WHY: `function_select` puede serializar booleans de distintas formas segun el entorno.
// IMPACT: solo afecta el filtrado del GET /insumos.
const isRowActive = (row) => {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
};

// NEW: helper para validar IDs enteros positivos.
// WHY: evitar llamadas a BD/SP con IDs invalidos y responder 400/404 de forma consistente.
// IMPACT: solo endurece requests mal formados; requests validos no cambian.
const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

// NEW: mensaje seguro para no exponer errores crudos de BD.
// WHY: alinear manejo de errores con UX y evitar detalles internos.
// IMPACT: no cambia contratos exitosos ni status codes de validacion.
const safeServerErrorMessage = (fallback = 'No se pudo completar la accion. Verifica los datos e intenta de nuevo.') => fallback;

// GET: Obtener insumos
router.get('/insumos', async (req, res) => {
  try {
    const tabla = 'insumos';

    // COMENTARIO EN MAYUSCULAS: SE AGREGA stock_minimo PARA ALERTAS
    const columnas =
      'id_insumo, nombre_insumo, precio, cantidad, stock_minimo, fecha_ingreso_insumo, id_almacen, fecha_caducidad, descripcion, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const baseDatos = result.rows[0].resultado || [];
    // NEW: por defecto devuelve solo activos; admin puede pedir todos con query param.
    // WHY: alinear el GET con la regla de soft delete basada en `estado`.
    // IMPACT: `?incluir_inactivos=1` mantiene soporte administrativo sin endpoint nuevo.
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener insumos:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage('No se pudieron cargar los insumos.') });
  }
});

// POST: Crear insumo
router.post('/insumos', async (req, res) => {
  try {
    const tabla = 'insumos';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Insumo creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// PUT: Actualizar insumo (1 campo)
router.put('/insumos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Insumo actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// DELETE: Inactivar insumo (soft delete)
router.delete('/insumos', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    // NEW: mantiene el contrato actual del DELETE pero restringe la columna esperada.
    // WHY: evitar operaciones arbitrarias y dejar el endpoint retrocompatible.
    // IMPACT: solo responde 400 en requests malformed.
    if (columna_id !== 'id_insumo') {
      return res.status(400).json({ error: true, message: 'columna_id invalido. Debe ser exactamente id_insumo.' });
    }

    const insumoId = Number(valor_id);
    if (!isPositiveIntegerId(insumoId)) {
      return res.status(400).json({ error: true, message: 'valor_id debe ser un entero mayor a 0.' });
    }

    // NEW: 404 explicito antes de inactivar.
    // WHY: estandarizar respuestas y evitar "exito" sobre IDs inexistentes.
    // IMPACT: no cambia el flujo de IDs validos.
    const existe = await pool.query('SELECT 1 FROM insumos WHERE id_insumo = $1 LIMIT 1', [insumoId]);
    if (existe.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Insumo no encontrado.' });
    }

    const tabla = 'insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, 'estado', 'false', columna_id, String(insumoId)]);

    res.status(200).json({ error: false, message: 'Insumo inactivado.' });

  } catch (err) {
    console.error('Error al inactivar insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

export default router;
