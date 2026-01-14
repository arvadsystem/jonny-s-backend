import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// GET: Obtener productos
router.get('/productos', async (req, res) => {
  try {
    const tabla = 'productos';
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener productos:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear producto
router.post('/productos', async (req, res) => {
  try {
    const tabla = 'productos';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Producto creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear producto:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// PUT: Actualizar producto (1 campo)
router.put('/productos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'productos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Producto actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar producto:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar producto
router.delete('/productos', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'productos';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Producto eliminado.' });

  } catch (err) {
    console.error('Error al eliminar producto:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
