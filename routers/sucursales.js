import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

/**
 * Función auxiliar para calcular la diferencia de tiempo
 */
const calcularAntiguedad = (fechaInauguracion) => {
  if (!fechaInauguracion) return 'Fecha no registrada';

  const fechaInicio = new Date(fechaInauguracion);
  const fechaActual = new Date();

  let anios = fechaActual.getFullYear() - fechaInicio.getFullYear();
  let meses = fechaActual.getMonth() - fechaInicio.getMonth();

  if (meses < 0) {
    anios--;
    meses += 12;
  }

  if (anios < 0) return 'Por inaugurar';

  return `${anios} años, ${meses} meses`;
};

/**
 * ✅ NUEVO: Inserta dirección/teléfono/correo y luego sucursal (en DB)
 * Espera un body como:
 * {
 *   nombre_sucursal,
 *   texto_direccion,
 *   texto_telefono,
 *   texto_correo,
 *   fecha_inauguracion,
 *   estado
 * }
 */
async function crearSucursalCompleta(datos) {
  const query = 'SELECT public.fn_crear_sucursal_completa($1::jsonb) AS id_sucursal';
  const { rows } = await pool.query(query, [datos]);
  return rows?.[0]?.id_sucursal ?? null;
}

/**
 * ✅ NUEVO: Actualiza formulario completo (en DB)
 */
async function actualizarSucursalCompleta(idSucursal, datos) {
  const query = 'SELECT public.fn_actualizar_sucursal_completa($1::int, $2::jsonb) AS id_sucursal';
  const { rows } = await pool.query(query, [idSucursal, datos]);
  return rows?.[0]?.id_sucursal ?? null;
}

// ==========================================
// GET: Listar sucursales con cálculo de antigüedad
// ==========================================
router.get('/sucursales', async (req, res) => {
  try {
    const tabla = 'v_sucursales_info';
    const columnas =
      'id_sucursal, nombre_sucursal, fecha_inauguracion, estado, texto_direccion, texto_telefono, texto_correo';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    let datos = result.rows[0].resultado || [];

    datos = datos.map((sucursal) => ({
      ...sucursal,
      antiguedad_calculada: calcularAntiguedad(sucursal.fecha_inauguracion),
    }));

    res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener sucursales:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// POST: Crear nueva sucursal (COMPLETA)
// ==========================================
router.post('/sucursales', async (req, res) => {
  try {
    const datos = req.body;

    if (!datos.nombre_sucursal) {
      return res.status(400).json({ error: true, message: 'El nombre de la sucursal es obligatorio.' });
    }

    const id = await crearSucursalCompleta(datos);

    res.status(201).json({
      message: 'Sucursal creada exitosamente.',
      id_sucursal: id,
    });
  } catch (err) {
    console.error('Error al crear sucursal:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// PUT: Actualizar sucursal (FORMULARIO COMPLETO)
// Endpoint nuevo: /sucursales/:id
// ==========================================
router.put('/sucursales/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: true, message: 'ID de sucursal inválido.' });
    }

    const datos = req.body;

    const updatedId = await actualizarSucursalCompleta(id, datos);

    res.status(200).json({
      message: 'Sucursal actualizada correctamente.',
      id_sucursal: updatedId,
    });
  } catch (err) {
    console.error('Error al actualizar sucursal:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// PUT: Actualizar sucursal (1 campo a la vez) - se mantiene por compatibilidad
// ==========================================
router.put('/sucursales', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Faltan campos obligatorios para la actualización.',
      });
    }

    const tabla = 'sucursales';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Sucursal actualizada correctamente.' });
  } catch (err) {
    console.error('Error al actualizar sucursal:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// DELETE: Eliminar sucursal
// ==========================================
router.delete('/sucursales', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar.' });
    }

    const tabla = 'sucursales';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Sucursal eliminada.' });
  } catch (err) {
    console.error('Error al eliminar sucursal:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
