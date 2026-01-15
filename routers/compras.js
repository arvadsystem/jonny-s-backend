import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// GET: Obtener compras
router.get('/compras', async (req, res) => {
  try {
    const tabla = 'compras';
    const columnas =
      'id_compra, id_orden_compra, id_proveedor, fecha, total, estado, sub_total, descuento, isv, total_detalle';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener compras:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear compra
router.post('/compras', async (req, res) => {
  try {
    const tabla = 'compras';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Compra creada exitosamente.' });

  } catch (err) {
    console.error('Error al crear compra:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// PUT: Actualizar compra (1 campo)
router.put('/compras', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'compras';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Compra actualizada correctamente.' });

  } catch (err) {
    console.error('Error al actualizar compra:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar compra
router.delete('/compras', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'compras';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Compra eliminada.' });

  } catch (err) {
    console.error('Error al eliminar compra:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
