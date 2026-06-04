import pool from '../../../config/db-connection.js';
import { resolveRequestUserSucursalScope } from '../../../utils/sucursalScope.js';
import {
  DESCUENTO_ALCANCE_KEYS
} from '../constants.js';
import { roundMoney } from '../utils/moneyUtils.js';
import {
  coercePositiveIntArray,
  normalizeDescuentoAlcance,
  parseBooleanish,
  parseJsonArrayValue,
  parseOptionalPositiveInt
} from '../utils/parseUtils.js';

const sendVentasInternalError = (
  res,
  message = 'No se pudo procesar la solicitud de ventas.'
) => res.status(500).json({ error: true, message });

const normalizeClienteNombre = (cliente) => {
  const nombrePersona = [cliente?.nombre, cliente?.apellido].filter(Boolean).join(' ').trim();
  if (nombrePersona) return nombrePersona;
  if (cliente?.nombre_empresa) return cliente.nombre_empresa;
  return 'Consumidor final';
};

const ventasHandlersTableCache = new Map();

const hasTable = async (client, tableName) => {
  const key = `table:${String(tableName || '').trim().toLowerCase()}`;
  if (ventasHandlersTableCache.has(key)) return ventasHandlersTableCache.get(key);

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  const exists = result.rowCount > 0;
  ventasHandlersTableCache.set(key, exists);
  return exists;
};

const validateVentasCatalogSucursal = async ({ scope, idSucursal, queryRunner = pool }) => {
  if (!idSucursal) return { ok: true };

  if (scope?.isSuperAdmin) {
    const result = await queryRunner.query(
      `
        SELECT id_sucursal
        FROM public.sucursales
        WHERE id_sucursal = $1
          AND COALESCE(estado, true) = true
        LIMIT 1
      `,
      [idSucursal]
    );
    if (result.rowCount > 0) return { ok: true };
    return {
      ok: false,
      status: 403,
      body: { error: true, message: 'No tiene acceso a la sucursal solicitada.' }
    };
  }

  const allowedSucursalIds = coercePositiveIntArray(scope?.allowedSucursalIds);
  if (allowedSucursalIds.length === 0) {
    return {
      ok: false,
      status: 403,
      body: { error: true, message: 'El empleado no tiene sucursales asignadas.' }
    };
  }
  if (!allowedSucursalIds.includes(idSucursal)) {
    return {
      ok: false,
      status: 403,
      body: { error: true, message: 'No tiene acceso a la sucursal solicitada.' }
    };
  }

  return { ok: true };
};

const buildDescuentoObjetivoLabel = (row) => {
  const alcance = normalizeDescuentoAlcance(row?.alcance) || DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA;
  if (alcance === DESCUENTO_ALCANCE_KEYS.FACTURA_COMPLETA) return 'Factura completa';

  const objetivos = row?.objetivos || {};
  const key = alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO
    ? 'productos'
    : alcance === DESCUENTO_ALCANCE_KEYS.RECETA
      ? 'recetas'
      : 'combos';
  const rows = parseJsonArrayValue(objetivos[key]);
  if (rows.length === 1) {
    return rows[0]?.nombre_producto || rows[0]?.nombre_receta || rows[0]?.nombre_combo || `${alcance} seleccionado`;
  }
  if (rows.length > 1) {
    const label = alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO ? 'productos' : alcance === DESCUENTO_ALCANCE_KEYS.RECETA ? 'recetas' : 'combos';
    return `${rows.length} ${label} seleccionados`;
  }
  return '--';
};

const normalizeDescuentoCatalogoRow = (row) => {
  const productos = parseJsonArrayValue(row?.productos);
  const recetas = parseJsonArrayValue(row?.recetas);
  const combos = parseJsonArrayValue(row?.combos);
  const objetivos = { productos, recetas, combos };
  const normalized = {
    ...row,
    objetivos,
    objetivos_count: {
      productos: productos.length,
      recetas: recetas.length,
      combos: combos.length,
      total: productos.length + recetas.length + combos.length
    }
  };
  normalized.objetivo = buildDescuentoObjetivoLabel(normalized);
  return normalized;
};

export const listCategoriasCatalogoHandler = async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) {
      return res.status(sucursalValidation.status).json(sucursalValidation.body);
    }

    const result = await pool.query(
      `
        SELECT cp.id_categoria_producto, cp.nombre_categoria, COALESCE(cp.estado, true) AS estado
        FROM public.categorias_productos cp
        WHERE COALESCE(cp.estado, true) = true
        ORDER BY cp.nombre_categoria ASC, cp.id_categoria_producto ASC
      `
    );

    return res.status(200).json(Array.isArray(result.rows) ? result.rows : []);
  } catch (err) {
    console.error('Error al listar catalogo de categorias para ventas:', err.message);
    return sendVentasInternalError(res);
  }
};

export const listExtrasPermitidosCatalogoHandler = async (req, res) => {
  const tipo = String(req.query.tipo || '').trim().toUpperCase();
  const idItem = parseOptionalPositiveInt(req.query.id_item);
  const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

  if (!['RECETA', 'COMBO'].includes(tipo)) {
    return res.status(400).json({ error: true, message: 'tipo debe ser RECETA o COMBO.' });
  }
  if (!idItem) {
    return res.status(400).json({ error: true, message: 'id_item debe ser entero mayor a 0.' });
  }

  try {
    const hasMenuExtraCombo = await hasTable(pool, 'menu_extra_combo');
    if (tipo === 'COMBO' && !hasMenuExtraCombo) {
      return res.status(200).json([]);
    }

    const linkJoin = tipo === 'RECETA'
      ? 'public.menu_extra_receta rel ON rel.id_extra = me.id_extra AND rel.id_receta = $1'
      : 'public.menu_extra_combo rel ON rel.id_extra = me.id_extra AND rel.id_combo = $1';
    const orderExpression = tipo === 'RECETA'
      ? 'COALESCE(rel.orden, me.orden, 2147483647)'
      : 'COALESCE(me.orden, 2147483647)';

    const result = await pool.query(
      `
        SELECT
          me.id_extra,
          me.codigo,
          me.nombre,
          me.precio_adicional AS precio,
          COALESCE(me.estado, true) AS estado,
          me.id_insumo,
          CASE WHEN me.id_insumo IS NULL THEN NULL ELSE i.cantidad END AS stock_disponible
        FROM public.menu_extras me
        INNER JOIN ${linkJoin}
          AND COALESCE(rel.estado, true) = true
        LEFT JOIN public.insumos i
          ON i.id_insumo = me.id_insumo
         AND COALESCE(i.estado, true) = true
        LEFT JOIN public.almacenes a
          ON a.id_almacen = i.id_almacen
         AND ($2::int IS NULL OR a.id_sucursal = $2::int)
        WHERE COALESCE(me.estado, true) = true
          AND (me.id_insumo IS NULL OR a.id_almacen IS NOT NULL)
        ORDER BY ${orderExpression}, me.nombre ASC
      `,
      [idItem, idSucursal || null]
    );

    return res.status(200).json(
      result.rows.map((row) => ({
        id_extra: Number(row.id_extra),
        codigo: row.codigo,
        nombre: row.nombre,
        precio: roundMoney(row.precio),
        estado: parseBooleanish(row.estado),
        id_insumo: parseOptionalPositiveInt(row.id_insumo),
        stock_disponible: row.stock_disponible === null || row.stock_disponible === undefined ? null : Number(row.stock_disponible)
      }))
    );
  } catch (err) {
    console.error('Error al listar extras permitidos venta:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar los extras permitidos.' });
  }
};

export const listProductosCatalogoHandler = async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) {
      return res.status(sucursalValidation.status).json(sucursalValidation.body);
    }

    let whereClause = '';
    const params = [];

    if (idSucursal) {
      params.push(idSucursal);
      whereClause = 'AND al.id_sucursal = $1';
    } else if (!isSuperAdmin) {
      const allowedSucursalIds = coercePositiveIntArray(scope.allowedSucursalIds);
      if (allowedSucursalIds.length === 0) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }
      params.push(allowedSucursalIds);
      whereClause = 'AND al.id_sucursal = ANY($1::int[])';
    }

    const query = `
      SELECT DISTINCT
        p.id_producto,
        p.nombre_producto,
        p.descripcion_producto,
        p.precio,
        p.cantidad,
        p.estado,
        p.id_categoria_producto,
        p.id_tipo_departamento,
        p.id_archivo_imagen_principal,
        al.id_sucursal,
        a.url_publica AS imagen_principal_url
      FROM public.productos p
      LEFT JOIN public.almacenes al ON al.id_almacen = p.id_almacen
      LEFT JOIN public.archivos a ON a.id_archivo = p.id_archivo_imagen_principal AND (a.estado = true OR a.estado IS NULL)
      WHERE COALESCE(p.estado, true) = true
        AND COALESCE(al.estado, true) = true
      ${whereClause}
      ORDER BY p.nombre_producto ASC, p.id_producto ASC
    `;

    const result = await pool.query(query, params);
    return res.status(200).json(Array.isArray(result.rows) ? result.rows : []);
  } catch (err) {
    console.error('Error al listar catalogo de productos para ventas:', err.message);
    return sendVentasInternalError(res);
  }
};

export const listClientesCatalogoHandler = async (req, res) => {
  try {
    const query = `
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
      WHERE COALESCE(c.estado, true) = true
      ORDER BY
        COALESCE(NULLIF(trim(concat_ws(' ', p.nombre, p.apellido)), ''), e.nombre_empresa, c.id_cliente::text)
    `;

    const result = await pool.query(query);
    const data = result.rows.map((row) => ({
      id_cliente: row.id_cliente,
      id_tipo_cliente: row.id_tipo_cliente,
      estado: row.estado,
      nombre_cliente: normalizeClienteNombre(row),
      es_consumidor_final: false
    }));

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar catalogo de clientes para ventas:', err.message);
    sendVentasInternalError(res);
  }
};

export const listTiposDescuentoCatalogoHandler = async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          td.id_tipo_descuento,
          td.nombre_tipo_descuento,
          td.descripcion,
          td.estado
        FROM tipo_descuentos td
        WHERE COALESCE(td.estado, true) = true
        ORDER BY td.id_tipo_descuento
      `
    );
    res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar tipos de descuento:', err.message);
    sendVentasInternalError(res);
  }
};

export const listTipoDepartamentoCatalogoHandler = async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          td.id_tipo_departamento,
          td.nombre_departamento,
          td.descripcion,
          td.estado
        FROM tipo_departamento td
        WHERE COALESCE(td.estado, true) = true
        ORDER BY td.nombre_departamento
      `
    );
    res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar tipos de departamento:', err.message);
    sendVentasInternalError(res);
  }
};

export const listDescuentosCatalogoHandler = async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);
    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) {
      return res.status(sucursalValidation.status).json(sucursalValidation.body);
    }

    const params = [];
    const sucursalWhere = idSucursal
      ? 'AND (dc.id_sucursal IS NULL OR dc.id_sucursal = $1)'
      : '';
    if (idSucursal) params.push(idSucursal);

    const result = await pool.query(
      `
        SELECT
          dc.id_descuento_catalogo,
          dc.nombre_descuento,
          dc.descripcion,
          dc.valor_descuento,
          dc.alcance,
          dc.id_producto,
          dc.id_receta,
          dc.id_combo,
          dc.id_sucursal,
          dc.fecha_inicio,
          dc.fecha_fin,
          dc.id_tipo_descuento,
          td.nombre_tipo_descuento,
          COALESCE(objp.productos, '[]'::jsonb) AS productos,
          COALESCE(objr.recetas, '[]'::jsonb) AS recetas,
          COALESCE(objc.combos, '[]'::jsonb) AS combos,
          COALESCE(objp.productos_ids, ARRAY[]::int[]) AS productos_ids,
          COALESCE(objr.recetas_ids, ARRAY[]::int[]) AS recetas_ids,
          COALESCE(objc.combos_ids, ARRAY[]::int[]) AS combos_ids
        FROM descuentos_catalogos dc
        INNER JOIN tipo_descuentos td
          ON td.id_tipo_descuento = dc.id_tipo_descuento
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(jsonb_agg(jsonb_build_object('id_producto', x.id_producto, 'nombre_producto', x.nombre_producto) ORDER BY x.nombre_producto), '[]'::jsonb) AS productos,
            COALESCE(array_agg(x.id_producto ORDER BY x.id_producto), ARRAY[]::int[]) AS productos_ids
          FROM (
            SELECT DISTINCT p.id_producto, p.nombre_producto
            FROM descuentos_catalogos_productos rel
            INNER JOIN productos p ON p.id_producto = rel.id_producto
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT p.id_producto, p.nombre_producto
            FROM productos p
            WHERE p.id_producto = dc.id_producto
              AND NOT EXISTS (
                SELECT 1 FROM descuentos_catalogos_productos rel
                WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
              )
          ) x
        ) objp ON true
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(jsonb_agg(jsonb_build_object('id_receta', x.id_receta, 'nombre_receta', x.nombre_receta) ORDER BY x.nombre_receta), '[]'::jsonb) AS recetas,
            COALESCE(array_agg(x.id_receta ORDER BY x.id_receta), ARRAY[]::int[]) AS recetas_ids
          FROM (
            SELECT DISTINCT r.id_receta, r.nombre_receta
            FROM descuentos_catalogos_recetas rel
            INNER JOIN recetas r ON r.id_receta = rel.id_receta
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT r.id_receta, r.nombre_receta
            FROM recetas r
            WHERE r.id_receta = dc.id_receta
              AND NOT EXISTS (
                SELECT 1 FROM descuentos_catalogos_recetas rel
                WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
              )
          ) x
        ) objr ON true
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(jsonb_agg(jsonb_build_object('id_combo', x.id_combo, 'nombre_combo', x.nombre_combo) ORDER BY x.nombre_combo), '[]'::jsonb) AS combos,
            COALESCE(array_agg(x.id_combo ORDER BY x.id_combo), ARRAY[]::int[]) AS combos_ids
          FROM (
            SELECT DISTINCT cb.id_combo, COALESCE(cb.nombre_combo, cb.descripcion) AS nombre_combo
            FROM descuentos_catalogos_combos rel
            INNER JOIN combos cb ON cb.id_combo = rel.id_combo
            WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
            UNION
            SELECT cb.id_combo, COALESCE(cb.nombre_combo, cb.descripcion) AS nombre_combo
            FROM combos cb
            WHERE cb.id_combo = dc.id_combo
              AND NOT EXISTS (
                SELECT 1 FROM descuentos_catalogos_combos rel
                WHERE rel.id_descuento_catalogo = dc.id_descuento_catalogo
              )
          ) x
        ) objc ON true
        WHERE COALESCE(dc.estado, true) = true
          AND COALESCE(td.estado, true) = true
          ${sucursalWhere}
        ORDER BY dc.nombre_descuento ASC, dc.id_descuento_catalogo ASC
      `,
      params
    );
    res.status(200).json((result.rows || []).map(normalizeDescuentoCatalogoRow));
  } catch (err) {
    console.error('Error al listar descuentos activos de catalogo:', err.message);
    sendVentasInternalError(res);
  }
};
