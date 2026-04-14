import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

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

const normalizeHour = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(normalized)) return null;
  return normalized.length === 5 ? `${normalized}:00` : normalized;
};

const normalizePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const validateHorario = ({ horaInicio, horaFinal }) => {
  if ((horaInicio && !horaFinal) || (!horaInicio && horaFinal)) {
    return 'Hora inicio y hora final deben enviarse juntas.';
  }
  if (horaInicio && horaFinal && horaFinal <= horaInicio) {
    return 'Hora final debe ser mayor que hora inicio.';
  }
  return null;
};

async function crearSucursalCompleta(datos) {
  const query = 'SELECT public.fn_crear_sucursal_completa($1::jsonb) AS id_sucursal';
  const { rows } = await pool.query(query, [datos]);
  return rows?.[0]?.id_sucursal ?? null;
}

async function actualizarSucursalCompleta(idSucursal, datos) {
  const query = 'SELECT public.fn_actualizar_sucursal_completa($1::int, $2::jsonb) AS id_sucursal';
  const { rows } = await pool.query(query, [idSucursal, datos]);
  return rows?.[0]?.id_sucursal ?? null;
}

const upsertSucursalExtras = async ({ idSucursal, horaInicio, horaFinal, idArchivoImagen }) => {
  await pool.query(
    `
      UPDATE public.sucursales
      SET hora_inicio = $1,
          hora_final = $2,
          id_archivo_imagen = $3
      WHERE id_sucursal = $4
    `,
    [horaInicio, horaFinal, idArchivoImagen, idSucursal]
  );
};

router.get('/sucursales', async (req, res) => {
  try {
    const tabla = 'v_sucursales_info';
    const columnas =
      'id_sucursal, nombre_sucursal, fecha_inauguracion, estado, texto_direccion, texto_telefono, texto_correo';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);
    const datos = Array.isArray(result.rows?.[0]?.resultado) ? result.rows[0].resultado : [];

    const ids = datos
      .map((row) => normalizePositiveInt(row?.id_sucursal))
      .filter((value) => value !== null);

    const complementById = new Map();
    if (ids.length > 0) {
      const extras = await pool.query(
        `
          SELECT
            s.id_sucursal,
            s.hora_inicio,
            s.hora_final,
            s.id_archivo_imagen,
            a.url_publica AS imagen_url_publica
          FROM public.sucursales s
          LEFT JOIN public.archivos a ON a.id_archivo = s.id_archivo_imagen
          WHERE s.id_sucursal = ANY($1::int[])
        `,
        [ids]
      );
      for (const row of extras.rows) {
        complementById.set(normalizePositiveInt(row.id_sucursal), row);
      }
    }

    const payload = datos.map((sucursal) => {
      const id = normalizePositiveInt(sucursal?.id_sucursal);
      const extra = complementById.get(id) || {};
      return {
        ...sucursal,
        antiguedad_calculada: calcularAntiguedad(sucursal.fecha_inauguracion),
        hora_inicio: extra.hora_inicio || null,
        hora_final: extra.hora_final || null,
        id_archivo_imagen: extra.id_archivo_imagen || null,
        imagen_url_publica: extra.imagen_url_publica || null
      };
    });

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[sucursales] list error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo obtener sucursales.' });
  }
});

router.post('/sucursales', async (req, res) => {
  try {
    const datos = req.body || {};
    if (!datos.nombre_sucursal) {
      return res.status(400).json({ error: true, message: 'El nombre de la sucursal es obligatorio.' });
    }

    const horaInicio = normalizeHour(datos.hora_inicio);
    const horaFinal = normalizeHour(datos.hora_final);
    const idArchivoImagen = normalizePositiveInt(datos.id_archivo_imagen);
    const horarioError = validateHorario({ horaInicio, horaFinal });
    if (horarioError) {
      return res.status(400).json({ error: true, message: horarioError });
    }

    const id = await crearSucursalCompleta(datos);
    if (id) {
      await upsertSucursalExtras({
        idSucursal: id,
        horaInicio,
        horaFinal,
        idArchivoImagen
      });
    }

    return res.status(201).json({
      message: 'Sucursal creada exitosamente.',
      id_sucursal: id
    });
  } catch (err) {
    console.error('[sucursales] create error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo crear la sucursal.' });
  }
});

router.put('/sucursales/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: true, message: 'ID de sucursal invalido.' });
    }

    const datos = req.body || {};
    const horaInicio = normalizeHour(datos.hora_inicio);
    const horaFinal = normalizeHour(datos.hora_final);
    const idArchivoImagen = normalizePositiveInt(datos.id_archivo_imagen);
    const horarioError = validateHorario({ horaInicio, horaFinal });
    if (horarioError) {
      return res.status(400).json({ error: true, message: horarioError });
    }

    const updatedId = await actualizarSucursalCompleta(id, datos);
    await upsertSucursalExtras({
      idSucursal: id,
      horaInicio,
      horaFinal,
      idArchivoImagen
    });

    return res.status(200).json({
      message: 'Sucursal actualizada correctamente.',
      id_sucursal: updatedId
    });
  } catch (err) {
    console.error('[sucursales] update full error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo actualizar la sucursal.' });
  }
});

router.put('/sucursales', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Faltan campos obligatorios para la actualizacion.'
      });
    }

    const tabla = 'sucursales';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    return res.status(200).json({ message: 'Sucursal actualizada correctamente.' });
  } catch (err) {
    console.error('[sucursales] update compat error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo actualizar la sucursal.' });
  }
});

router.delete('/sucursales', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar.' });
    }

    const tabla = 'sucursales';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    return res.status(200).json({ message: 'Sucursal eliminada.' });
  } catch (err) {
    console.error('[sucursales] delete error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo eliminar la sucursal.' });
  }
});

export default router;
