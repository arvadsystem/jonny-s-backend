import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

router.get('/direcciones', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_direccion, direccion
      FROM direcciones
      ORDER BY id_direccion;
    `);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener direcciones:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
