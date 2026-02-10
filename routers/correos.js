import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

router.get('/correos', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_correo, direccion_correo
      FROM correos
      ORDER BY id_correo;
    `);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener correos:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
