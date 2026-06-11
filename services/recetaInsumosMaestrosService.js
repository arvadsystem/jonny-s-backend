import {
  CATALOGO_MAESTRO_VIEW_MISSING_CODE,
  queryCatalogoMaestroView
} from './catalogoMaestroReadService.js';

const CATALOGO_MAESTRO_STRUCTURE_SQLSTATES = new Set(['42P01', '42703']);

const buildCatalogoMaestroUnavailableError = (cause) => {
  const error = new Error('Catalogo maestro no disponible. Verifica que las vistas maestras esten creadas.');
  error.code = CATALOGO_MAESTRO_VIEW_MISSING_CODE;
  error.status = 500;
  error.cause = cause;
  error.body = {
    error: true,
    code: CATALOGO_MAESTRO_VIEW_MISSING_CODE,
    message: 'Catalogo maestro no disponible. Verifica que las vistas maestras esten creadas.'
  };
  return error;
};

const buildInsumoMaestroNoResueltoError = () => {
  const error = new Error('Uno o mas insumos no tienen una equivalencia maestra valida.');
  error.code = 'INSUMO_MAESTRO_NO_RESUELTO';
  error.status = 409;
  error.body = {
    error: true,
    code: 'INSUMO_MAESTRO_NO_RESUELTO',
    message: 'Uno o más insumos no tienen una equivalencia maestra válida.'
  };
  return error;
};

const buildInsumoMaestroDuplicadoError = () => {
  const error = new Error('No repitas el mismo insumo maestro en el detalle de receta.');
  error.code = 'INSUMO_MAESTRO_DUPLICADO';
  error.status = 400;
  error.body = {
    error: true,
    code: 'INSUMO_MAESTRO_DUPLICADO',
    message: 'No repitas el mismo insumo maestro en el detalle de receta.'
  };
  return error;
};

const buildValidationError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  error.body = { error: true, message };
  return error;
};

const queryMaestroStructure = async (client, sql, params = []) => {
  try {
    return await client.query(sql, Array.isArray(params) ? params : []);
  } catch (error) {
    if (CATALOGO_MAESTRO_STRUCTURE_SQLSTATES.has(error?.code)) {
      throw buildCatalogoMaestroUnavailableError(error);
    }
    throw error;
  }
};

export const isRecetaInsumosMaestrosControlledError = (error) =>
  Boolean(error?.body && Number.isInteger(error?.status));

export const getRecetaInsumosMaestrosErrorResponse = (error) => ({
  status: Number.isInteger(error?.status) ? error.status : 500,
  body: error?.body || {
    error: true,
    message: 'No se pudo completar la operacion con insumos maestros.'
  }
});

export const fetchCatalogoInsumosMaestros = async (db) => {
  const result = await queryCatalogoMaestroView(
    db,
    'public.vw_insumos_maestros_almacen',
    `
      WITH maestros AS (
        SELECT
          v.id_insumo_maestro,
          MIN(v.nombre_insumo) AS nombre_insumo,
          MIN(v.id_categoria_insumo) AS id_categoria_insumo,
          MIN(v.id_unidad_medida) AS id_unidad_medida,
          COUNT(DISTINCT v.id_almacen)::int AS total_almacenes,
          COALESCE(
            ARRAY_AGG(DISTINCT v.id_sucursal ORDER BY v.id_sucursal)
              FILTER (WHERE v.id_sucursal IS NOT NULL),
            ARRAY[]::integer[]
          ) AS id_sucursales,
          COALESCE(
            ARRAY_AGG(DISTINCT v.id_almacen ORDER BY v.id_almacen)
              FILTER (WHERE v.id_almacen IS NOT NULL),
            ARRAY[]::integer[]
          ) AS id_almacenes
        FROM public.vw_insumos_maestros_almacen v
        WHERE v.estado_global IS TRUE
        GROUP BY v.id_insumo_maestro
        HAVING BOOL_OR(v.estado_local IS TRUE)
      )
      SELECT
        m.id_insumo_maestro AS id_insumo,
        m.id_insumo_maestro,
        m.nombre_insumo,
        m.id_categoria_insumo,
        ci.nombre_categoria,
        m.id_unidad_medida,
        um.nombre AS unidad_nombre,
        um.simbolo AS unidad_abreviatura,
        um.simbolo AS unidad_simbolo,
        true AS estado,
        m.total_almacenes,
        m.id_sucursales,
        m.id_almacenes
      FROM maestros m
      LEFT JOIN public.categorias_insumos ci
        ON ci.id_categoria_insumo = m.id_categoria_insumo
      LEFT JOIN public.unidades_medida um
        ON um.id_unidad_medida = m.id_unidad_medida
      ORDER BY ci.nombre_categoria ASC NULLS LAST, m.nombre_insumo ASC, m.id_insumo_maestro ASC
    `
  );

  return result.rows || [];
};

export const fetchDetalleRecetaInsumosMaestros = async (db, idReceta) => {
  const result = await queryMaestroStructure(
    db,
    `
      SELECT
        dr.id_detalle,
        dr.id_receta,
        COALESCE(mm.id_insumo_maestro, dr.id_insumo) AS id_insumo,
        COALESCE(mm.id_insumo_maestro, dr.id_insumo) AS id_insumo_maestro,
        i.nombre_insumo,
        dr.cant,
        dr.id_unidad_medida,
        um.nombre AS unidad_nombre,
        um.simbolo AS unidad_simbolo,
        dr.estado
      FROM detalle_recetas dr
      LEFT JOIN LATERAL (
        SELECT MIN(m.id_insumo_maestro)::integer AS id_insumo_maestro
        FROM public.insumos_mapeo_maestro m
        WHERE m.id_insumo_legacy = dr.id_insumo
           OR m.id_insumo_maestro = dr.id_insumo
      ) mm ON true
      INNER JOIN insumos i
        ON i.id_insumo = COALESCE(mm.id_insumo_maestro, dr.id_insumo)
      LEFT JOIN unidades_medida um
        ON um.id_unidad_medida = dr.id_unidad_medida
      WHERE dr.id_receta = $1
        AND COALESCE(dr.estado, true) = true
      ORDER BY i.nombre_insumo ASC, dr.id_detalle ASC
    `,
    [idReceta]
  );

  return result.rows || [];
};

export const normalizeDetalleRecetaInsumosMaestros = async (client, detalle) => {
  const inputIds = [...new Set((Array.isArray(detalle) ? detalle : []).map((item) => item.id_insumo))];
  if (inputIds.length === 0) return [];

  const mappingResult = await queryMaestroStructure(
    client,
    `
      SELECT
        input.id_insumo AS input_id,
        MIN(m.id_insumo_maestro)::integer AS id_insumo_maestro,
        COUNT(DISTINCT m.id_insumo_maestro)::int AS total_maestros
      FROM UNNEST($1::int[]) AS input(id_insumo)
      LEFT JOIN public.insumos_mapeo_maestro m
        ON m.id_insumo_legacy = input.id_insumo
        OR m.id_insumo_maestro = input.id_insumo
      GROUP BY input.id_insumo
    `,
    [inputIds]
  );

  const mappingByInput = new Map(
    (mappingResult.rows || []).map((row) => [
      Number(row.input_id),
      {
        id_insumo_maestro: Number(row.id_insumo_maestro),
        total_maestros: Number(row.total_maestros)
      }
    ])
  );

  const normalized = detalle.map((item) => {
    const mapping = mappingByInput.get(Number(item.id_insumo));
    if (!mapping || mapping.total_maestros !== 1 || !Number.isSafeInteger(mapping.id_insumo_maestro)) {
      throw buildInsumoMaestroNoResueltoError();
    }
    return {
      ...item,
      id_insumo: mapping.id_insumo_maestro,
      id_insumo_maestro: mapping.id_insumo_maestro
    };
  });

  const seenMasters = new Set();
  for (const item of normalized) {
    if (seenMasters.has(item.id_insumo_maestro)) {
      throw buildInsumoMaestroDuplicadoError();
    }
    seenMasters.add(item.id_insumo_maestro);
  }

  const masterIds = normalized.map((item) => item.id_insumo_maestro);
  const mastersResult = await queryMaestroStructure(
    client,
    `
      SELECT
        i.id_insumo,
        i.nombre_insumo,
        COALESCE(i.estado, true) AS estado,
        i.id_unidad_medida
      FROM public.insumos i
      WHERE i.id_insumo = ANY($1::int[])
    `,
    [masterIds]
  );
  const mastersById = new Map((mastersResult.rows || []).map((row) => [Number(row.id_insumo), row]));

  for (const item of normalized) {
    const master = mastersById.get(item.id_insumo_maestro);
    if (!master) {
      throw buildInsumoMaestroNoResueltoError();
    }
    if (!master.estado) {
      throw buildValidationError(409, `El insumo ${item.id_insumo_maestro} esta inactivo.`);
    }

    const masterUnidadId =
      master.id_unidad_medida === null || master.id_unidad_medida === undefined
        ? null
        : Number(master.id_unidad_medida);

    if (!Number.isSafeInteger(masterUnidadId) || masterUnidadId <= 0) {
      throw buildValidationError(
        409,
        `El insumo ${item.id_insumo_maestro} no tiene unidad de medida definida.`
      );
    }

    if (masterUnidadId !== item.id_unidad_medida) {
      const safeName = String(master.nombre_insumo || '').trim();
      throw buildValidationError(
        409,
        safeName
          ? `El insumo "${safeName}" ya tiene una unidad definida diferente. Actualiza el detalle con la unidad correcta.`
          : `El insumo ${item.id_insumo_maestro} ya tiene una unidad definida diferente. Actualiza el detalle con la unidad correcta.`
      );
    }
  }

  return normalized;
};
