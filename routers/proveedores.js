import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// GET: Obtener proveedores
router.get('/proveedores', async (req, res) => {
  try {
    const tabla = 'proveedores';
    const columnas = 'id_proveedor, nombre_proveedor, id_persona, id_empresa';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener proveedores:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear proveedor
router.post('/proveedores', async (req, res) => {
  try {
    const tabla = 'proveedores';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Proveedor creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear proveedor:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// PUT: Actualizar proveedor (1 campo)
router.put('/proveedores', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'proveedores';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Proveedor actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar proveedor:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar proveedor
router.delete('/proveedores', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'proveedores';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Proveedor eliminado.' });

  } catch (err) {
    console.error('Error al eliminar proveedor:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
