import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();  

/* =======================
   GET - LISTAR EMPRESAS
======================= */
router.get('/empresas', async (req, res) => {
  try {
    const tabla = 'empresas';
    const columnas = 'id_empresa, rtn, nombre_empresa, id_telefono, id_direccion, id_correo';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener la empresa:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});


/* =======================
   GET - LISTAR EMPRESAS POR ID
======================= */
router.get('/empresas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const tabla = 'empresas';
    const columnas = 'id_empresa, rtn, nombre_empresa, id_telefono, id_direccion, id_correo';

    const query = 'SELECT function_select($1::TEXT, $2::TEXT) AS resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];

    // FILTRAR SOLO LA EMPRESA POR ID
    const empresa = datos.find(
      e => String(e.id_empresa) === String(id)
    );

    if (!empresa) {
      return res.status(404).json({
        error: true,
        message: 'Empresa no encontrada'
      });
    }

    res.status(200).json(empresa);

  } catch (err) {
    console.error('Error al obtener empresa:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

/* =======================
   POST - INSERTAR
======================= */
router.post('/empresas', async (req, res) => {
  try {
    const tabla = 'empresas';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Empresa creada exitosamente.' });
  } catch (err) {
    console.error('Error al crear la empresa:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/empresas/:id', async (req, res) => {
  try {
    const { campo, valor } = req.body;
    const { id } = req.params;

    if (!campo || valor === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Debe enviar campo y valor'
      });
    }

    const tabla = 'empresas';

    await pool.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      [
        tabla,
        campo,
        String(valor),
        'id_empresa',
        String(id)
      ]
    );

    res.status(200).json({
      error: false,
      message: 'Empresa actualizada correctamente'
    });

  } catch (err) {
    console.error('Error al actualizar la empresa:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/empresas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['empresas', 'id_empresa', String(id)]
    );

    res.status(200).json({
      error: false,
      message: 'Empresa eliminada correctamente'
    });

  } catch (err) {
    console.error('Error al eliminar la empresa:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});


export default router;