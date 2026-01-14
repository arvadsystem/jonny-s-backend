import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// ------------------------------------------------------------------------------------
// GET: Obtener categorias_productos
// ------------------------------------------------------------------------------------
router.get('/categorias_productos', async (req, res) => {
  try {
    const tabla = 'categorias_productos';
    const columnas = 'id_categoria_producto, nombre_categoria, codigo_categoria, descripcion, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener categorias_productos:', err.message);
    res.status(500).json({ error: true, message: err.message });
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
    res.status(500).json({ error: true, message: err.message });
  }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar categoria_producto (actualiza 1 campo)
// ------------------------------------------------------------------------------------
router.put('/categorias_productos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

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
    res.status(500).json({ error: true, message: err.message });
  }
});

// ------------------------------------------------------------------------------------
// DELETE: Eliminar categoria_producto
// ------------------------------------------------------------------------------------
router.delete('/categorias_productos', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'categorias_productos';
    const query = 'CALL pa_delete($1, $2, $3)';

    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Categoría eliminada.' });

  } catch (err) {
    console.error('Error al eliminar categoria_producto:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
