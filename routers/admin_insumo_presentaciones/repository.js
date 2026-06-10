import pool from '../../config/db-connection.js';

const PRESENTATION_COLUMNS = `
  ip.id_presentacion,
  ip.id_insumo,
  ip.nombre_presentacion,
  ip.cantidad_presentacion,
  ip.id_unidad_presentacion,
  unidad_presentacion.nombre AS unidad_presentacion_nombre,
  unidad_presentacion.simbolo AS unidad_presentacion_simbolo,
  ip.cantidad_base,
  ip.id_unidad_base,
  unidad_base.nombre AS unidad_base_nombre,
  unidad_base.simbolo AS unidad_base_simbolo,
  ip.uso_compra,
  ip.uso_receta,
  ip.es_predeterminada_compra,
  ip.es_predeterminada_receta,
  ip.estado
`;

export const getClient = () => pool.connect();

export const findInsumoById = async (client, idInsumo) => {
  const result = await client.query(
    `
      SELECT id_insumo, nombre_insumo, id_unidad_medida, COALESCE(estado, true) AS estado
      FROM public.insumos
      WHERE id_insumo = $1
      LIMIT 1
    `,
    [idInsumo]
  );
  return result.rows[0] || null;
};

export const unidadExists = async (client, idUnidadMedida) => {
  const result = await client.query(
    `
      SELECT 1
      FROM public.unidades_medida
      WHERE id_unidad_medida = $1
      LIMIT 1
    `,
    [idUnidadMedida]
  );
  return result.rowCount > 0;
};

export const listPresentacionesByInsumo = async (client, idInsumo) => {
  const result = await client.query(
    `
      SELECT ${PRESENTATION_COLUMNS}
      FROM public.insumo_presentaciones ip
      LEFT JOIN public.unidades_medida unidad_presentacion
        ON unidad_presentacion.id_unidad_medida = ip.id_unidad_presentacion
      LEFT JOIN public.unidades_medida unidad_base
        ON unidad_base.id_unidad_medida = ip.id_unidad_base
      WHERE ip.id_insumo = $1
      ORDER BY COALESCE(ip.estado, true) DESC,
               ip.uso_receta DESC,
               ip.uso_compra DESC,
               ip.nombre_presentacion ASC,
               ip.id_presentacion ASC
    `,
    [idInsumo]
  );
  return result.rows || [];
};

export const findPresentacionById = async (client, idPresentacion) => {
  const result = await client.query(
    `
      SELECT *
      FROM public.insumo_presentaciones
      WHERE id_presentacion = $1
      LIMIT 1
    `,
    [idPresentacion]
  );
  return result.rows[0] || null;
};

export const clearDefaultCompra = async (client, idInsumo, exceptIdPresentacion = null) => {
  await client.query(
    `
      UPDATE public.insumo_presentaciones
      SET es_predeterminada_compra = false,
          actualizado_en = NOW()
      WHERE id_insumo = $1
        AND COALESCE(estado, true) = true
        AND uso_compra = true
        AND es_predeterminada_compra = true
        AND ($2::int IS NULL OR id_presentacion <> $2::int)
    `,
    [idInsumo, exceptIdPresentacion]
  );
};

export const clearDefaultReceta = async (client, idInsumo, exceptIdPresentacion = null) => {
  await client.query(
    `
      UPDATE public.insumo_presentaciones
      SET es_predeterminada_receta = false,
          actualizado_en = NOW()
      WHERE id_insumo = $1
        AND COALESCE(estado, true) = true
        AND uso_receta = true
        AND es_predeterminada_receta = true
        AND ($2::int IS NULL OR id_presentacion <> $2::int)
    `,
    [idInsumo, exceptIdPresentacion]
  );
};

export const createPresentacion = async (client, idInsumo, data) => {
  const result = await client.query(
    `
      INSERT INTO public.insumo_presentaciones (
        id_insumo,
        nombre_presentacion,
        cantidad_presentacion,
        id_unidad_presentacion,
        cantidad_base,
        id_unidad_base,
        uso_compra,
        uso_receta,
        es_predeterminada_compra,
        es_predeterminada_receta,
        estado
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id_presentacion
    `,
    [
      idInsumo,
      data.nombre_presentacion,
      data.cantidad_presentacion,
      data.id_unidad_presentacion,
      data.cantidad_base,
      data.id_unidad_base,
      data.uso_compra,
      data.uso_receta,
      data.es_predeterminada_compra,
      data.es_predeterminada_receta,
      data.estado
    ]
  );
  return Number(result.rows[0].id_presentacion);
};

export const updatePresentacion = async (client, idPresentacion, data) => {
  const result = await client.query(
    `
      UPDATE public.insumo_presentaciones
      SET nombre_presentacion = $1,
          cantidad_presentacion = $2,
          id_unidad_presentacion = $3,
          cantidad_base = $4,
          id_unidad_base = $5,
          uso_compra = $6,
          uso_receta = $7,
          es_predeterminada_compra = $8,
          es_predeterminada_receta = $9,
          estado = $10,
          actualizado_en = NOW()
      WHERE id_presentacion = $11
      RETURNING id_presentacion
    `,
    [
      data.nombre_presentacion,
      data.cantidad_presentacion,
      data.id_unidad_presentacion,
      data.cantidad_base,
      data.id_unidad_base,
      data.uso_compra,
      data.uso_receta,
      data.es_predeterminada_compra,
      data.es_predeterminada_receta,
      data.estado,
      idPresentacion
    ]
  );
  return result.rowCount > 0;
};

export const updatePresentacionEstado = async (client, idPresentacion, estado) => {
  const result = await client.query(
    `
      UPDATE public.insumo_presentaciones
      SET estado = $1,
          actualizado_en = NOW()
      WHERE id_presentacion = $2
      RETURNING id_presentacion
    `,
    [estado, idPresentacion]
  );
  return result.rowCount > 0;
};
