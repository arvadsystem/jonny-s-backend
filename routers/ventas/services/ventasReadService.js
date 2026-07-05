import { fetchProductosMaestrosByIdsForUpdate } from '../../../services/inventarioStockValidator.js';

export const fetchProductoMap = async (client, ids, options = {}) => {
  if (!ids.length) return new Map();

  const idSucursal = Number(options?.idSucursal || 0) || null;
  if (idSucursal) {
    const productosFetchResult = await fetchProductosMaestrosByIdsForUpdate(client, ids, idSucursal);
    return new Map((productosFetchResult.rows || []).map((row) => [Number(row.id_producto), row]));
  }

  const forUpdateClause = options?.forUpdate ? 'FOR UPDATE' : '';
  const result = await client.query(
    `
      SELECT id_producto, nombre_producto, precio, estado, cantidad, id_almacen
      FROM productos
      WHERE id_producto = ANY($1::int[])
      ${forUpdateClause}
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_producto), row]));
};

export const fetchRecetaMap = async (client, ids) => {
  if (!ids.length) return new Map();

  const result = await client.query(
    `
      SELECT
        r.id_receta,
        r.nombre_receta,
        r.descripcion,
        r.estado,
        r.precio,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id_insumo', dr.id_insumo,
            'cantidad', dr.cant
          ) ORDER BY dr.id_detalle)
          FROM public.detalle_recetas dr
          WHERE dr.id_receta = r.id_receta
            AND COALESCE(dr.estado, true) IS TRUE
            AND dr.cant > 0
        ), '[]'::jsonb) AS componentes
      FROM recetas r
      WHERE r.id_receta = ANY($1::int[])
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_receta), row]));
};

export const fetchVentaCatalogMaps = async (client, { productoIds = [], recetaIds = [], lockProductos = true, idSucursal = null } = {}) => {
  const uniqueProductoIds = [...new Set((Array.isArray(productoIds) ? productoIds : []).filter(Boolean))];
  const uniqueRecetaIds = [...new Set((Array.isArray(recetaIds) ? recetaIds : []).filter(Boolean))];
  const productoMap = await fetchProductoMap(client, uniqueProductoIds, { forUpdate: lockProductos, idSucursal });

  if (uniqueProductoIds.length === 0 && uniqueRecetaIds.length === 0) {
    return {
      productoMap,
      recetaMap: new Map()
    };
  }

  const ctes = [];
  const selects = [];
  const params = [];
  const addArrayParam = (values) => {
    params.push(values);
    return `$${params.length}::int[]`;
  };

  if (uniqueRecetaIds.length > 0) {
    const recetasParam = addArrayParam(uniqueRecetaIds);
    const sucursalParam = idSucursal ? `$${params.push(Number(idSucursal))}::int` : 'NULL::int';
    ctes.push(`
      recetas_rows AS (
        SELECT
          r.id_receta,
          r.nombre_receta,
          r.descripcion,
          r.estado,
          r.precio,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id_insumo', dr.id_insumo,
              'cantidad', dr.cant,
              'id_almacen', (
                SELECT MIN(ia.id_almacen)::int
                FROM public.insumos_almacenes ia
                INNER JOIN public.almacenes a
                  ON a.id_almacen = ia.id_almacen
                 AND COALESCE(a.estado, true) IS TRUE
                WHERE ia.id_insumo = dr.id_insumo
                  AND COALESCE(ia.estado, true) IS TRUE
                  AND (${sucursalParam} IS NULL OR a.id_sucursal = ${sucursalParam})
              )
            ) ORDER BY dr.id_detalle)
            FROM public.detalle_recetas dr
            WHERE dr.id_receta = r.id_receta
              AND COALESCE(dr.estado, true) IS TRUE
              AND dr.cant > 0
          ), '[]'::jsonb) AS componentes
        FROM recetas r
        WHERE r.id_receta = ANY(${recetasParam})
      )
    `);
    selects.push(`COALESCE((SELECT jsonb_agg(to_jsonb(rr)) FROM recetas_rows rr), '[]'::jsonb) AS recetas`);
  } else {
    selects.push(`'[]'::jsonb AS recetas`);
  }

  if (ctes.length === 0) {
    return {
      productoMap,
      recetaMap: new Map()
    };
  }

  const result = await client.query(
    `
      WITH ${ctes.join(',')}
      SELECT ${selects.join(', ')}
    `,
    params
  );
  const row = result.rows?.[0] || {};
  const recetas = Array.isArray(row.recetas) ? row.recetas : [];

  return {
    productoMap,
    recetaMap: new Map(recetas.map((item) => [Number(item.id_receta), item]))
  };
};

export const fetchClienteInfo = async (client, idCliente) => {
  if (!idCliente) return null;

  const result = await client.query(
    `
      SELECT
        c.id_cliente,
        c.estado,
        c.id_tipo_cliente,
        p.nombre,
        p.apellido,
        e.nombre_empresa
      FROM clientes c
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
      WHERE c.id_cliente = $1
      LIMIT 1
    `,
    [idCliente]
  );

  return result.rows[0] || null;
};
