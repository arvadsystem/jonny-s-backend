import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// GET: Obtener insumos
router.get('/insumos', async (req, res) => {
  try {
    const tabla = 'insumos';
    const columnas =
      'id_insumo, nombre_insumo, precio, cantidad, fecha_ingreso_insumo, id_almacen, fecha_caducidad, descripcion';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener insumos:', err.message);
    res.status(500).json({ error: true, message: err.message });
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
    res.status(500).json({ error: true, message: err.message });
  }
});

// PUT: Actualizar insumo (1 campo)
router.put('/insumos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Insumo actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar insumo:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar insumo
router.delete('/insumos', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'insumos';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Insumo eliminado.' });

  } catch (err) {
    console.error('Error al eliminar insumo:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
