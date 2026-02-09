import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

/* =======================
   GET - PERSONAS CON DETALLE (JOINS)
======================= */
router.get('/personas-detalle', async (req, res) => {
  try {

    const query = `
      SELECT 
        p.id_persona,
        p.nombre,
        p.apellido,
        p.fecha_nacimiento,
        p.genero,
        p.dni,
        p.rtn,

        t.telefono AS telefono,
        d.direccion AS direccion,
        c.direccion_correo AS correo

      FROM personas p
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
      LEFT JOIN correos c ON c.id_correo = p.id_correo

      ORDER BY p.id_persona;
    `;

    const result = await pool.query(query);
    res.status(200).json(result.rows);

  } catch (err) {
    console.error('Error al obtener personas detalle:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});


/* =======================
   GET - PERSONA POR ID
======================= */
router.get('/personas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const tabla = 'personas';
    const columnas ='id_persona, nombre, apellido, fecha_nacimiento, genero, dni, rtn, id_telefono, id_direccion, id_correo';

    const query = 'SELECT function_select($1::TEXT, $2::TEXT) AS resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];

    const persona = datos.find(
      p => String(p.id_persona) === String(id)
    );

    if (!persona) {
      return res.status(404).json({
        error: true,
        message: 'Persona no encontrada'
      });
    }

    res.status(200).json(persona);

  } catch (err) {
    console.error('Error al obtener persona:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});


/* =======================
   POST - INSERTAR
======================= */
router.post('/personas', async (req, res) => {
  try {
    const tabla = 'personas';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Persona creada exitosamente.' });
  } catch (err) {
    console.error('Error al crear persona:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});


/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/personas/:id', async (req, res) => {
  try {
    const { campo, valor } = req.body;
    const { id } = req.params;

    if (!campo || valor === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Debe enviar campo y valor'
      });
    }

    const tabla = 'personas';

    await pool.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      [
        tabla,
        campo,
        String(valor),
        'id_persona',
        String(id)
      ]
    );

    res.status(200).json({
      error: false,
      message: 'Persona actualizada correctamente'
    });

  } catch (err) {
    console.error('Error al actualizar persona:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});


/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/personas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['personas', 'id_persona', String(id)]
    );

    res.status(200).json({
      error: false,
      message: 'Persona eliminada correctamente'
    });

  } catch (err) {
    console.error('Error al eliminar persona:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

export default router;
