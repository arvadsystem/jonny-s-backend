import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// ==============================
// COMENTARIO EN MAYÚSCULAS: CRUD DE MOVIMIENTOS DE INVENTARIO (KARDEX)
// TABLA: movimientos_inventario
// COLUMNAS (SEGÚN LA TABLA QUE CREASTE):
// id_movimiento, fecha_mov, tipo, cantidad, id_almacen, id_producto, id_insumo, ref_origen, id_ref, descripcion
// ==============================

// GET: Obtener movimientos de inventario
router.get('/movimientos_inventario', async (req, res) => {
  try {
    const tabla = 'movimientos_inventario';
    const columnas =
      'id_movimiento, fecha_mov, tipo, cantidad, id_almacen, id_producto, id_insumo, ref_origen, id_ref, descripcion';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener movimientos_inventario:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear movimiento
router.post('/movimientos_inventario', async (req, res) => {
  try {
    const tabla = 'movimientos_inventario';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Movimiento creado exitosamente.' });
  } catch (err) {
    console.error('Error al crear movimiento_inventario:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// PUT: Actualizar movimiento (1 campo)
router.put('/movimientos_inventario', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'movimientos_inventario';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Movimiento actualizado correctamente.' });
  } catch (err) {
    console.error('Error al actualizar movimiento_inventario:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar movimiento
router.delete('/movimientos_inventario', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'movimientos_inventario';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Movimiento eliminado.' });
  } catch (err) {
    console.error('Error al eliminar movimiento_inventario:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
