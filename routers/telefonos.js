import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

router.get('/telefonos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_telefono, telefono
      FROM telefonos
      ORDER BY id_telefono;
    `);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener telefonos:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
