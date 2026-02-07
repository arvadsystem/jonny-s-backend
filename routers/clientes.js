import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();  

/* =======================
   GET - LISTAR CLIENTES
======================= */
router.get('/clientes', async (req, res) => {
  try {
    const tabla = 'clientes';
    const columnas = 'id_cliente, fecha_ingreso, puntos, id_tipo_cliente, id_persona, id_empresa, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener el cliente:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});


/* =======================
   GET - LISTAR CLIENTES POR ID
======================= */
router.get('/clientes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const tabla = 'clientes';
    const columnas = 'id_cliente, fecha_ingreso, puntos, id_tipo_cliente, id_persona, id_empresa, estado';

    const query = 'SELECT function_select($1::TEXT, $2::TEXT) AS resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];

    // FILTRAR SOLO LA EMPRESA POR ID
    const clientes = datos.find(
      e => String(e.id_cliente) === String(id)
    );

    if (!clientes) {
      return res.status(404).json({
        error: true,
        message: 'Cliente no encontrado'
      });
    }

    res.status(200).json(clientes);

  } catch (err) {
    console.error('Error al obtener el cliente:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

/* =======================
   POST - INSERTAR CLIENTES
======================= */
router.post('/clientes', async (req, res) => {
  try {
    const tabla = 'clientes';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Cliente creado exitosamente.' });
  } catch (err) {
    console.error('Error al crear el cliente:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

/* =======================
   PUT - ACTUALIZAR LOS CLIENTES
======================= */
router.put('/clientes/:id', async (req, res) => {
  try {
    const { campo, valor } = req.body;
    const { id } = req.params;

    if (!campo || valor === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Debe enviar campo y valor'
      });
    }

    const tabla = 'clientes';

    await pool.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      [
        tabla,
        campo,
        String(valor),
        'id_cliente',
        String(id)
      ]
    );

    res.status(200).json({
      error: false,
      message: 'Cliente actualizado correctamente'
    });

  } catch (err) {
    console.error('Error al actualizar el cliente:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

/* =======================
   DELETE - ELIMINAR LOS CLIENTES
======================= */
router.delete('/clientes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['clientes', 'id_cliente', String(id)]
    );

    res.status(200).json({
      error: false,
      message: 'Cliente eliminado correctamente'
    });

  } catch (err) {
    console.error('Error al eliminar el cliente:', err.message);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});


export default router;