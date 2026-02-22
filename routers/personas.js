import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const MAX_LIMIT = 100;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/* =======================
   GET - PERSONAS CON DETALLE (JOINS)
======================= 
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
});*/

router.get('/personas-detalle', async (req, res) => {
  try {
    const pageParam = req.query.page;
    const limitParam = req.query.limit;

    const page = pageParam === undefined ? 1 : parsePositiveInt(pageParam);
    const limitRaw = limitParam === undefined ? 10 : parsePositiveInt(limitParam);

    if (!page || !limitRaw) {
      return res.status(400).json({
        error: true,
        message: 'Los parámetros page y limit deben ser enteros positivos'
      });
    }

    const limit = Math.min(limitRaw, MAX_LIMIT);

    const offset = (page - 1) * limit;

    // consulta datos
    const dataQuery = `
      SELECT 
        p.id_persona,
        p.nombre,
        p.apellido,
        p.fecha_nacimiento,
        p.genero,
        p.dni,
        p.rtn,
        t.telefono,
        d.direccion,
        c.direccion_correo AS correo
      FROM personas p
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      ORDER BY p.id_persona
      LIMIT $1 OFFSET $2;
    `;

    // total registros
    const totalQuery = `SELECT COUNT(*) FROM personas`;

    const [data, total] = await Promise.all([
      pool.query(dataQuery, [limit, offset]),
      pool.query(totalQuery)
    ]);

    res.status(200).json({
      data: data.rows,
      total: Number(total.rows[0].count),
      page,
      limit
    });

  } catch (err) {
    console.error('Error al obtener personas detalle:', err.message);
    res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});




/* =======================
   GET - PERSONA POR ID
======================= */
router.get('/personas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const idPersona = parsePositiveInt(id);
    if (!idPersona) {
      return res.status(400).json({
        error: true,
        message: 'El id debe ser un entero positivo'
      });
    }

    const query = `
      SELECT
        id_persona,
        nombre,
        apellido,
        fecha_nacimiento,
        genero,
        dni,
        rtn,
        id_telefono,
        id_direccion,
        id_correo
      FROM personas
      WHERE id_persona = $1
      LIMIT 1;
    `;
    const result = await pool.query(query, [idPersona]);
    const persona = result.rows[0];

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
      message: 'Error interno del servidor'
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

    if (!isPlainObject(datos) || Object.keys(datos).length === 0) {
      return res.status(400).json({
        error: true,
        message: 'El cuerpo de la solicitud debe ser un objeto con datos válidos'
      });
    }

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Persona creada exitosamente.' });
  } catch (err) {
    console.error('Error al crear persona:', err.message);
    res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});


/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/personas/:id', async (req, res) => {
  try {
    const { campo, valor } = req.body;
    const { id } = req.params;
    const idPersona = parsePositiveInt(id);

    if (!campo || valor === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Debe enviar campo y valor'
      });
    }

    if (!idPersona) {
      return res.status(400).json({
        error: true,
        message: 'El id debe ser un entero positivo'
      });
    }

    const allowedFields = new Set([
      'nombre',
      'apellido',
      'fecha_nacimiento',
      'genero',
      'dni',
      'rtn',
      'id_telefono',
      'id_direccion',
      'id_correo'
    ]);

    if (!allowedFields.has(campo)) {
      return res.status(400).json({
        error: true,
        message: 'El campo no es válido para actualización'
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
        String(idPersona)
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
      message: 'Error interno del servidor'
    });
  }
});


/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/personas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idPersona = parsePositiveInt(id);

    if (!idPersona) {
      return res.status(400).json({
        error: true,
        message: 'El id debe ser un entero positivo'
      });
    }

    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['personas', 'id_persona', String(idPersona)]
    );

    res.status(200).json({
      error: false,
      message: 'Persona eliminada correctamente'
    });

  } catch (err) {
    console.error('Error al eliminar persona:', err.message);
    res.status(500).json({
      error: true,
      message: 'Error interno del servidor'
    });
  }
});

export default router;
