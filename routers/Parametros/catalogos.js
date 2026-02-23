import express from 'express';
import pool from '../../config/db-connection.js';

const router = express.Router();

// =====================================================
// MÓDULO 7.1 - CATÁLOGOS
// CRUD genérico por tabla catálogo (con lista blanca)
// Usa: function_select, pa_insert, pa_update, pa_delete
// =====================================================

// Lista blanca de tablas catálogo permitidas + columnas permitidas por tabla
// IMPORTANTE: aquí solo se agregan tablas de configuración (no transaccionales)
const CATALOGOS = {
  tipo_departamento:
    'id_tipo_departamento, nombre_departamento, descripcion, estado',
  categorias_productos:
    'id_categoria_producto, nombre_categoria, codigo_categoria, descripcion, estado',
  unidades_medida:
    'id_unidad_medida, nombre, simbolo, factor_base',

  tipo_cliente: 'id_tipo_cliente, tipo_cliente',
  tipo_notificacion: 'id_tipo_notificacion, descripcion_tipo_notificacion',
  estados_pedido: 'id_estado_pedido, descripcion',

  dispositivos_biometricos: 'id_dispositivo, nombre_dispositivo',

  tipo_hora_extra: 'id_tipo_hora, descripcion',
  factor_horas_extra: 'id_factor_horas_extras, cantidad_horas, precio_hora',

  tipo_nomina: 'id_tipo_nomina, descripcion_tipo_nomina',
  tipo_naturaleza: 'id_tipo_naturaleza, tipo_naturaleza, descripcion',
  concepto_nomina: 'id_concepto_nomina, id_tipo_nomina, descripcion, id_tipo_naturaleza',

  estado_planilla: 'id_estado_planilla, descripcion',

  // Si quieres agregar más catálogos, se agregan aquí (uno por uno)
};

// Valida que la tabla sea un catálogo permitido
const TABLA_ALIAS = {
  factor_horas_extra: ['factor_horas_extra', 'factor_hora_extra', 'factor_horas_extras']
};

const validarTablaCatalogo = (tabla) => {
  return Object.prototype.hasOwnProperty.call(CATALOGOS, tabla);
};

const resolverTablaFisica = async (tabla) => {
  const candidatas = TABLA_ALIAS[tabla] || [tabla];

  for (const candidata of candidatas) {
    const reg = await pool.query('SELECT to_regclass($1) as reg', [`public.${candidata}`]);
    if (reg.rows?.[0]?.reg) return candidata;
  }

  return null;
};

const obtenerColumnasReales = async (tablaFisica) => {
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY ordinal_position`,
    [tablaFisica]
  );

  return result.rows.map((row) => row.column_name);
};

// GET: Listar registros de un catálogo
// GET /parametros/catalogos/:tabla
router.get('/:tabla', async (req, res) => {
  try {
    const { tabla } = req.params;

    if (!validarTablaCatalogo(tabla)) {
      return res.status(400).json({
    ok: false,
    message: 'Tabla catálogo no permitida.',
    data: null,
    });
    }

    const tablaFisica = await resolverTablaFisica(tabla);
    if (!tablaFisica) {
      return res.status(500).json({
        ok: false,
        message: `No existe la tabla fisica para el catalogo: ${tabla}`,
        data: null
      });
    }

    const columnasReales = await obtenerColumnasReales(tablaFisica);
    if (columnasReales.length === 0) {
      return res.status(500).json({
        ok: false,
        message: `No se encontraron columnas para la tabla fisica: ${tablaFisica}`,
        data: null
      });
    }

    const columnas = columnasReales.join(', ');

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tablaFisica, columnas]);

    const datos = result.rows[0].resultado || [];
    return res.status(200).json({
    ok: true,
    message: 'Catálogo listado correctamente.',
    data: datos,
});

} catch (err) {
  console.error('Error al listar catálogo:', err.message);
  return res.status(500).json({
    ok: false,
    message: err.message,
    data: null,
  });
}
});

// POST: Insertar registro en un catálogo
// POST /parametros/catalogos/:tabla
router.post('/:tabla', async (req, res) => {
  try {
    const { tabla } = req.params;

    if (!validarTablaCatalogo(tabla)) {
      return res.status(400).json({
        ok: false,
        message: 'Tabla catálogo no permitida.',
        data: null,
      });
    }

    const tablaFisica = await resolverTablaFisica(tabla);
    if (!tablaFisica) {
      return res.status(500).json({
        ok: false,
        message: `No existe la tabla fisica para el catalogo: ${tabla}`,
        data: null
      });
    }

    const datos = req.body;

    const query = 'CALL public.pa_insert($1::text, $2::json)';
    await pool.query(query, [tablaFisica, JSON.stringify(datos)]);

    return res.status(201).json({
      ok: true,
      message: 'Registro creado exitosamente.',
      data: null,
    });

  } catch (err) {
    console.error('Error al crear catálogo:', err.message);
    return res.status(500).json({
      ok: false,
      message: err.message,
      data: null,
    });
  }
});

// PUT: Actualizar registro (1 campo) en un catálogo
// PUT /parametros/catalogos/:tabla
router.put('/:tabla', async (req, res) => {
  try {
    const { tabla } = req.params;
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!validarTablaCatalogo(tabla)) {
      return res.status(400).json({
        ok: false,
        message: 'Tabla catálogo no permitida.',
        data: null,
      });
    }

    const tablaFisica = await resolverTablaFisica(tabla);
    if (!tablaFisica) {
      return res.status(500).json({
        ok: false,
        message: `No existe la tabla fisica para el catalogo: ${tabla}`,
        data: null
      });
    }

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({
        ok: false,
        message: 'Faltan campos obligatorios',
        data: null,
      });
    }

    // Seguridad: solo permitir columnas definidas en el catálogo
    const columnasPermitidas = await obtenerColumnasReales(tablaFisica);

    if (!columnasPermitidas.includes(campo) || !columnasPermitidas.includes(id_campo)) {
      return res.status(400).json({
        ok: false,
        message: 'Campo no permitido para este catálogo.',
        data: null,
      });
    }

    // 1) Verificar que el registro exista antes del UPDATE (evita "200" falso)
    const existsQuery = `SELECT 1 FROM ${tablaFisica} WHERE ${id_campo} = $1 LIMIT 1`;
    const exists = await pool.query(existsQuery, [String(id_valor)]);

    if (exists.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        message: 'No existe registro con ese ID.',
        data: null,
      });
    }

    // 2) Ejecutar pa_update (forzando schema y tipos)
    const query = 'CALL public.pa_update($1::text, $2::text, $3::text, $4::text, $5::text)';
    await pool.query(query, [
      tablaFisica,
      campo,
      String(valor),
      id_campo,
      String(id_valor),
    ]);

    return res.status(200).json({
      ok: true,
      message: 'Registro actualizado correctamente.',
      data: null,
    });

  } catch (err) {
    console.error('Error al actualizar catálogo:', err.message);
    return res.status(500).json({
      ok: false,
      message: err.message,
      data: null,
    });
  }
});

// DELETE: Eliminar registro en un catálogo
// DELETE /parametros/catalogos/:tabla
router.delete('/:tabla', async (req, res) => {
  try {
    const { tabla } = req.params;
    const { columna_id, valor_id } = req.body;

    if (!validarTablaCatalogo(tabla)) {
      return res.status(400).json({
        ok: false,
        message: 'Tabla catálogo no permitida.',
        data: null,
      });
    }

    const tablaFisica = await resolverTablaFisica(tabla);
    if (!tablaFisica) {
      return res.status(500).json({
        ok: false,
        message: `No existe la tabla fisica para el catalogo: ${tabla}`,
        data: null
      });
    }

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({
        ok: false,
        message: 'Faltan datos para eliminar',
        data: null,
      });
    }

    // Seguridad extra: solo permitir borrar por columnas válidas del catálogo
    const columnasPermitidas = await obtenerColumnasReales(tablaFisica);

    if (!columnasPermitidas.includes(columna_id)) {
      return res.status(400).json({
        ok: false,
        message: 'Columna de eliminación no permitida para este catálogo.',
        data: null,
      });
    }

    const query = 'CALL public.pa_delete($1::text, $2::text, $3::text)';
    await pool.query(query, [tablaFisica, columna_id, String(valor_id)]);

    return res.status(200).json({
      ok: true,
      message: 'Registro eliminado.',
      data: null,
    });

  } catch (err) {
    console.error('Error al eliminar catálogo:', err.message);
    return res.status(500).json({
      ok: false,
      message: err.message,
      data: null,
    });
  }
});

export default router;
