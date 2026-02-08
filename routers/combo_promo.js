import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// =====================================================
// MÓDULO 6 - MENÚ
// Combos definidos SOLO en detalle_combo
// - Usar: function_select, pa_insert, pa_update, pa_delete
// =====================================================

// =====================================================
// GET: Obtener combos (lista de productos del dep "Combos") - SOLO LECTURA
// URL: /menu/combos
// Nota: esto sirve para que el súper admin seleccione el id_producto_combo existente
// =====================================================
router.get('/menu/combos', async (req, res) => {
  try {
    // // 1) Buscar el id del departamento "Combos" en tipo_departamento
    const tablaDep = 'tipo_departamento';
    const columnasDep = 'id_tipo_departamento, nombre_departamento, estado';

    const qDep = 'SELECT function_select($1, $2) as resultado';
    const rDep = await pool.query(qDep, [tablaDep, columnasDep]);

    const departamentos = rDep.rows[0].resultado || [];
    const depCombos = departamentos.find(
      (d) =>
        String(d.nombre_departamento || '').trim().toLowerCase() === 'combos' &&
        (d.estado === true || d.estado === 'true' || d.estado === 1)
    );

    if (!depCombos) {
      return res.status(404).json({
        error: true,
        message: 'No existe el departamento "Combos" en tipo_departamento.'
      });
    }

    // // 2) Leer productos y filtrar por id_tipo_departamento = depCombos.id_tipo_departamento
    const tabla = 'productos';
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento';

    const q = 'SELECT function_select($1, $2) as resultado';
    const r = await pool.query(q, [tabla, columnas]);

    const datos = r.rows[0].resultado || [];
    const combos = datos.filter(
      (p) => Number(p.id_tipo_departamento) === Number(depCombos.id_tipo_departamento)
    );

    return res.status(200).json(combos);

  } catch (err) {
    console.error('Error al obtener combos:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// GET: Obtener detalle_combo
// URL: /menu/combos/detalle
// =====================================================
router.get('/menu/combos/detalle', async (req, res) => {
  try {
    const tabla = 'detalle_combo';
    const columnas = 'id_detalle_combo, id_producto_combo, id_producto_item, cantidad, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    return res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener detalle_combo:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// POST: Insertar detalle_combo (HU 6.1)
// URL: /menu/combos/detalle
// Body: { id_producto_combo, id_producto_item, cantidad }
// =====================================================
router.post('/menu/combos/detalle', async (req, res) => {
  try {
    const tabla = 'detalle_combo';
    const datos = req.body;

    // // Validación mínima
    if (!datos || Object.keys(datos).length === 0) {
      return res.status(400).json({
        error: true,
        message: 'No se recibieron datos para crear el detalle del combo.'
      });
    }

    if (!datos.id_producto_combo || !datos.id_producto_item || datos.cantidad === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Faltan campos obligatorios: id_producto_combo, id_producto_item, cantidad'
      });
    }

    if (Number(datos.cantidad) <= 0) {
      return res.status(400).json({
        error: true,
        message: 'La cantidad debe ser mayor a 0'
      });
    }

    // // Forzamos estado por defecto
    if (datos.estado === undefined) {
      datos.estado = true;
    }

    // // INSERT estándar del proyecto
    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    return res.status(201).json({ message: 'Detalle de combo creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear detalle_combo:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
