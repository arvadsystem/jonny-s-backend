import pool from '../../../config/db-connection.js';
import { resolveRequestUserSucursalScope } from '../../../utils/sucursalScope.js';
import { roundMoney } from '../utils/moneyUtils.js';
import {
  coercePositiveIntArray,
  parseBooleanish,
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
