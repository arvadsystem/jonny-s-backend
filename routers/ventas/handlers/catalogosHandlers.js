import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pool from '../../../config/db-connection.js';
import { resolveRequestUserSucursalScope } from '../../../utils/sucursalScope.js';
import { buildAbsolutePublicUrl } from '../../../utils/uploads.js';
import {
  DESCUENTO_ALCANCE_KEYS,
  VENTA_COMPLEMENTO_TIPO_SALSAS
} from '../constants.js';
import {
  buildVentaComplementContext,
  resolveRecetaComplementMetadata
} from '../services/complementosCatalogService.js';
import {
  buildCajaBootstrapCacheKey,
  fetchCachedCajaBootstrap
} from '../services/cajaBootstrapCacheService.js';
import {
  fetchVentaGlobalExtrasCatalog,
  resolveExtrasInventory
} from '../services/extrasInventoryService.js';
import { roundMoney } from '../utils/moneyUtils.js';
import { isVentasPerfEnabled } from '../utils/perfUtils.js';
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

const logDescuentosCatalogError = ({ err, req, scope, idSucursal }) => {
  console.error('[ventas.catalogos.descuentos] error', {
    route: `${req.method} ${req.originalUrl || req.path || '/ventas/catalogos/descuentos'}`,
    usuario: parseOptionalPositiveInt(req.user?.id_usuario),
    sucursal_solicitada: idSucursal || null,
    sucursales_permitidas: coercePositiveIntArray(scope?.allowedSucursalIds),
    postgres_code: err?.code || null,
    message: err?.message || 'Error sin mensaje',
    stack: err?.stack || null
  });
};

const CLIENTE_NOMBRE_PLACEHOLDERS = new Set([
  'sin nombre',
  'sin apellido',
  'sin nombres',
  'sin apellidos',
  'delivery',
  'no registrado',
  'no registra',
  'n/a',
  'na',
  'null',
  'undefined'
]);

const normalizeClienteNombrePart = (value) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const normalized = text.toLowerCase();
  if (CLIENTE_NOMBRE_PLACEHOLDERS.has(normalized)) return '';
  if (!/\p{L}/u.test(text)) return '';
  if (/^0+\d{2,}$/.test(text)) return '';
  return text;
};

const normalizeClienteNombre = (cliente) => {
  const nombreEmpresa = normalizeClienteNombrePart(cliente?.nombre_empresa);
  if (nombreEmpresa) return nombreEmpresa;

  const nombrePersona = [
    normalizeClienteNombrePart(cliente?.nombre),
    normalizeClienteNombrePart(cliente?.apellido)
  ].filter(Boolean).join(' ').trim();
  if (nombrePersona) return nombrePersona;

  const idCliente = parseOptionalPositiveInt(cliente?.id_cliente);
  return idCliente ? `Cliente #${idCliente}` : 'Cliente sin nombre';
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
    : 'recetas';
  const rows = parseJsonArrayValue(objetivos[key]);
  if (rows.length === 1) {
    return rows[0]?.nombre_producto || rows[0]?.nombre_receta || `${alcance} seleccionado`;
  }
  if (rows.length > 1) {
    const label = alcance === DESCUENTO_ALCANCE_KEYS.PRODUCTO ? 'productos' : 'recetas';
    return `${rows.length} ${label} seleccionados`;
  }
  return '--';
};

const normalizeDescuentoCatalogoRow = (row) => {
  const productos = parseJsonArrayValue(row?.productos);
  const recetas = parseJsonArrayValue(row?.recetas);
  const objetivos = { productos, recetas };
  const normalized = {
    ...row,
    objetivos,
    objetivos_count: {
      productos: productos.length,
      recetas: recetas.length,
      total: productos.length + recetas.length
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
  const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);

  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) {
      return res.status(sucursalValidation.status).json(sucursalValidation.body);
    }
    const resultRows = await fetchVentaGlobalExtrasCatalog({
      queryRunner: pool,
      idSucursal
    });

    const resolvedExtras = await resolveExtrasInventory({
      queryRunner: pool,
      extras: resultRows,
      idSucursal,
      mode: 'catalog'
    });

    return res.status(200).json(
      resolvedExtras.map((row) => ({
        id_extra: Number(row.id_extra),
        codigo: row.codigo,
        nombre: row.nombre,
        precio: roundMoney(row.precio),
        precio_adicional: roundMoney(row.precio),
        estado: parseBooleanish(row.estado),
        id_insumo: parseOptionalPositiveInt(row.id_insumo_configurado),
        id_insumo_maestro: parseOptionalPositiveInt(row.id_insumo_maestro),
        nombre_insumo: row.nombre_insumo || null,
        stock_disponible: row.stock_disponible === null || row.stock_disponible === undefined ? null : Number(row.stock_disponible),
        cantidad_consumo_base: row.cantidad_consumo_base === null || row.cantidad_consumo_base === undefined
          ? null
          : Number(row.cantidad_consumo_base),
        cantidad_consumo: row.cantidad_consumo_base === null || row.cantidad_consumo_base === undefined
          ? null
          : Number(row.cantidad_consumo_base),
        id_unidad_base: parseOptionalPositiveInt(row.id_unidad_base),
        id_unidad_medida: parseOptionalPositiveInt(row.id_unidad_base || row.id_unidad_medida),
        unidad_medida: row.unidad_medida || null,
        id_almacen: parseOptionalPositiveInt(row.id_almacen),
        id_sucursal: parseOptionalPositiveInt(idSucursal),
        disponible: Boolean(row.disponible),
        inventario_configurado: Boolean(row.inventario_configurado),
        motivo_no_disponible: row.motivo_no_disponible || null,
        codigo_no_disponible: row.codigo_no_disponible || null
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
    const data = Array.isArray(result.rows)
      ? result.rows.map((row) => ({
        ...row,
        imagen_principal_url: buildAbsolutePublicUrl(req, row.imagen_principal_url)
      }))
      : [];
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar catalogo de productos para ventas:', err.message);
    return sendVentasInternalError(res);
  }
};

export const listClientesCatalogoHandler = async (req, res) => {
  try {
    const search = String(req.query.search || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const normalizedSearch = search
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const directId = parseOptionalPositiveInt(search);
    const searchDigits = search.replace(/\D/g, '');
    const isNumericSearch = /^\d+$/.test(search);
    const isDirectIdentifier = Boolean(directId || searchDigits.length >= 4);
    const shortDirectIdOnly = Boolean(directId && search === searchDigits && searchDigits.length < 4);
    const parsedLimit = Number.parseInt(String(req.query.limit ?? 100), 10);
    const limit = Math.min(100, Math.max(1, Number.isInteger(parsedLimit) ? parsedLimit : 100));
    if (!search || (!isNumericSearch && search.length < 2) || (isNumericSearch && !isDirectIdentifier)) {
      return res.status(200).json({ data: [], meta: { limit, has_more: false } });
    }
    const query = `
      WITH matched AS (
        SELECT DISTINCT
          c.id_cliente,
          c.estado,
          c.id_tipo_cliente,
          tc.tipo_cliente,
          p.nombre,
          p.apellido,
          p.dni,
          p.rtn AS persona_rtn,
          p.id_telefono AS persona_id_telefono,
          tp.telefono AS persona_telefono,
          e.nombre_empresa,
          e.rtn AS empresa_rtn,
          e.id_telefono AS empresa_id_telefono,
          te.telefono AS empresa_telefono,
          CASE
            WHEN $2::int IS NOT NULL AND c.id_cliente = $2 THEN 0
            WHEN UPPER(COALESCE(p.dni, '')) = UPPER($4) OR UPPER(COALESCE(p.rtn, '')) = UPPER($4) OR UPPER(COALESCE(e.rtn, '')) = UPPER($4) THEN 1
            WHEN regexp_replace(COALESCE(tp.telefono, ''), '\\D', '', 'g') = $5 OR regexp_replace(COALESCE(te.telefono, ''), '\\D', '', 'g') = $5 THEN 2
            WHEN translate(lower(trim(concat_ws(' ', p.nombre, p.apellido))), 'áéíóúüñ', 'aeiouun') = $6
              OR translate(lower(trim(COALESCE(p.nombre, ''))), 'áéíóúüñ', 'aeiouun') = $6
              OR translate(lower(trim(COALESCE(e.nombre_empresa, ''))), 'áéíóúüñ', 'aeiouun') = $6 THEN 3
            WHEN translate(lower(trim(concat_ws(' ', p.nombre, p.apellido))), 'áéíóúüñ', 'aeiouun') LIKE $6 || '%'
              OR translate(lower(trim(COALESCE(p.nombre, ''))), 'áéíóúüñ', 'aeiouun') LIKE $6 || '%'
              OR translate(lower(trim(COALESCE(p.apellido, ''))), 'áéíóúüñ', 'aeiouun') LIKE $6 || '%'
              OR translate(lower(trim(COALESCE(e.nombre_empresa, ''))), 'áéíóúüñ', 'aeiouun') LIKE $6 || '%' THEN 4
            ELSE 5
          END AS relevance_rank,
          LOWER(COALESCE(NULLIF(trim(concat_ws(' ', p.nombre, p.apellido)), ''), e.nombre_empresa, c.id_cliente::text)) AS sort_name
        FROM clientes c
        LEFT JOIN personas p ON p.id_persona = c.id_persona
        LEFT JOIN telefonos tp ON tp.id_telefono = p.id_telefono
        LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
        LEFT JOIN telefonos te ON te.id_telefono = e.id_telefono
        LEFT JOIN tipo_cliente tc ON tc.id_tipo_cliente = c.id_tipo_cliente
        WHERE COALESCE(c.estado, true) = true
          AND (
            $4 = ''
            OR ($2::int IS NOT NULL AND c.id_cliente = $2)
            OR UPPER(COALESCE(p.dni, '')) = UPPER($4)
            OR UPPER(COALESCE(p.rtn, '')) = UPPER($4)
            OR UPPER(COALESCE(e.rtn, '')) = UPPER($4)
            OR COALESCE(p.dni, '') ILIKE $1
            OR COALESCE(p.rtn, '') ILIKE $1
            OR COALESCE(e.rtn, '') ILIKE $1
            OR regexp_replace(COALESCE(tp.telefono, ''), '\\D', '', 'g') ILIKE $3
            OR regexp_replace(COALESCE(te.telefono, ''), '\\D', '', 'g') ILIKE $3
            OR p.nombre ILIKE $1
            OR p.apellido ILIKE $1
            OR trim(concat_ws(' ', p.nombre, p.apellido)) ILIKE $1
            OR COALESCE(e.nombre_empresa, '') ILIKE $1
            OR translate(lower(trim(concat_ws(' ', p.nombre, p.apellido))), 'áéíóúüñ', 'aeiouun') LIKE '%' || $6 || '%'
            OR translate(lower(COALESCE(e.nombre_empresa, '')), 'áéíóúüñ', 'aeiouun') LIKE '%' || $6 || '%'
          )
      )
      SELECT
        id_cliente, estado, id_tipo_cliente, tipo_cliente, nombre, apellido, dni,
        persona_rtn, persona_id_telefono, persona_telefono, nombre_empresa,
        empresa_rtn, empresa_id_telefono, empresa_telefono
      FROM matched
      ORDER BY
        relevance_rank,
        sort_name,
        id_cliente
      LIMIT $7
    `;

    const queryValues = [
      shortDirectIdOnly ? '%__NO_TEXT_MATCH__%' : `%${search}%`,
      directId,
      searchDigits.length >= 4 ? `%${searchDigits}%` : '%__NO_PHONE_MATCH__%',
      search,
      searchDigits.length >= 4 ? searchDigits : '__NO_PHONE_MATCH__',
      shortDirectIdOnly ? '__NO_TEXT_MATCH__' : normalizedSearch,
      limit + 1
    ];
    const result = await pool.query({
      text: query,
      values: queryValues,
      query_timeout: 8_000
    });
    const hasMore = result.rows.length > limit;
    const data = result.rows.slice(0, limit).map((row) => ({
      id_cliente: row.id_cliente,
      id_tipo_cliente: row.id_tipo_cliente,
      tipo_cliente: row.tipo_cliente || null,
      estado: row.estado,
      nombre_cliente: normalizeClienteNombre(row),
      telefono: row.persona_telefono || row.empresa_telefono || null,
      id_telefono: row.persona_id_telefono || row.empresa_id_telefono || null,
      dni: row.dni || null,
      rtn: row.empresa_rtn || row.persona_rtn || null,
      es_consumidor_final: false
    }));

    res.status(200).json({ data, meta: { limit, has_more: hasMore } });
  } catch (err) {
    console.error('Error al listar catalogo de clientes para ventas:', err.message);
    sendVentasInternalError(res);
  }
};

const fetchRecetasCatalogoData = async ({
  req,
  idSucursal,
  idTipoDepartamento = null
}) => {
  let sqlDurationMs = 0;
  let mappingDurationMs = 0;
  const schemaStartedAt = performance.now();
  const hasRecipeAssignmentsTable = await hasTable(pool, 'menu_receta_almacenes');
  sqlDurationMs += performance.now() - schemaStartedAt;

  let joinClause = 'INNER JOIN menu_vigente mv ON mv.id_menu = r.id_menu';
  if (hasRecipeAssignmentsTable) {
    joinClause += `
      INNER JOIN public.menu_receta_almacenes mra
        ON mra.id_receta = r.id_receta
       AND COALESCE(mra.estado, true) = true
      INNER JOIN public.almacenes ara
        ON ara.id_almacen = mra.id_almacen
       AND COALESCE(ara.estado, true) = true
       AND ara.id_sucursal = $1
      INNER JOIN public.sucursales sra
        ON sra.id_sucursal = ara.id_sucursal
       AND COALESCE(sra.estado, true) = true
    `;
  }

  const params = [idSucursal];
  let departmentClause = '';
  if (idTipoDepartamento) {
    params.push(idTipoDepartamento);
    departmentClause = `AND r.id_tipo_departamento = $${params.length}`;
  }

  const sqlStartedAt = performance.now();
  const result = await pool.query(
    `
      SELECT DISTINCT
        r.id_receta,
        r.nombre_receta,
        r.descripcion,
        r.estado,
        r.precio,
        r.id_archivo,
        r.id_tipo_departamento,
        a.url_publica AS imagen_principal_url,
        NULL::INTEGER AS id_producto_base,
        r.nombre_receta AS nombre_producto_base,
        r.precio AS precio_producto_base,
        r.estado AS estado_producto_base
      FROM recetas r
      LEFT JOIN archivos a ON a.id_archivo = r.id_archivo AND (a.estado = true OR a.estado IS NULL)
      ${joinClause}
      WHERE COALESCE(r.estado, true) = true
        AND mv.id_sucursal = $1
        AND COALESCE(mv.estado, true) = true
        AND (mv.fecha_inicio IS NULL OR mv.fecha_inicio <= CURRENT_TIMESTAMP)
        ${departmentClause}
      ORDER BY r.nombre_receta ASC, r.id_receta ASC
    `,
    params
  );
  sqlDurationMs += performance.now() - sqlStartedAt;
  const recetaRows = Array.isArray(result.rows) ? result.rows : [];

  const complementStartedAt = performance.now();
  const complementContext = await buildVentaComplementContext({
    client: pool,
    idSucursal,
    normalizedItems: recetaRows.map((row) => ({
      kind: 'RECETA',
      id_receta: Number(row?.id_receta || 0),
      cantidad: 1,
      complementos: []
    }))
  });
  sqlDurationMs += performance.now() - complementStartedAt;

  const mappingStartedAt = performance.now();
  const data = recetaRows.map((row) => {
    const metadata = resolveRecetaComplementMetadata({
      receta: row,
      quantity: 1,
      allowedSauces: complementContext.saucesByRecipe.get(Number(row?.id_receta || 0)) || [],
      rules: complementContext.rulesByRecipe.get(Number(row?.id_receta || 0)) || [],
      fallbackSauces: complementContext.fallbackSauces
    });
    return {
      ...row,
      imagen_principal_url: buildAbsolutePublicUrl(req, row.imagen_principal_url),
      requiere_complementos: Boolean(metadata.requiere_complementos),
      tipo_complemento: metadata.tipo_complemento || VENTA_COMPLEMENTO_TIPO_SALSAS,
      minimo_complementos: Number(metadata.minimo_complementos || 0),
      maximo_complementos: Number(metadata.maximo_complementos || 0),
      complementos_disponibles: (Array.isArray(metadata.complementos_disponibles)
        ? metadata.complementos_disponibles
        : []).map((entry) => ({
        id_complemento: Number(entry?.id_complemento || entry?.id_salsa || 0),
        nombre: String(entry?.nombre || 'Salsa').trim(),
        disponible: entry?.disponible !== false
      })).filter((entry) => entry.id_complemento > 0)
    };
  });
  mappingDurationMs += performance.now() - mappingStartedAt;
  return { data, sqlDurationMs, mappingDurationMs };
};

export const listRecetasCatalogoHandler = async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);
    const idTipoDepartamentoRaw = req.query.id_tipo_departamento;
    const idTipoDepartamento = parseOptionalPositiveInt(idTipoDepartamentoRaw);
    if (idTipoDepartamentoRaw !== undefined && !idTipoDepartamento) {
      return res.status(400).json({ error: true, message: 'id_tipo_departamento debe ser un entero mayor a 0.' });
    }
    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) return res.status(sucursalValidation.status).json(sucursalValidation.body);
    if (!idSucursal) {
      return res.status(400).json({ error: true, message: 'id_sucursal es obligatorio para listar complementos.' });
    }
    const result = await fetchRecetasCatalogoData({ req, idSucursal, idTipoDepartamento });
    return res.status(200).json(result.data);
  } catch (err) {
    console.error('Error al listar catalogo de recetas para ventas:', err.message);
    return sendVentasInternalError(res);
  }
};

const mapCajaAvailableSession = (row) => ({
  id_sucursal: Number(row.id_sucursal),
  nombre_sucursal: row.nombre_sucursal,
  id_caja: Number(row.id_caja),
  codigo_caja: row.codigo_caja,
  nombre_caja: row.nombre_caja,
  id_sesion_caja: Number(row.id_sesion_caja),
  estado_sesion: row.estado_codigo,
  estado_codigo: row.estado_codigo,
  fecha_apertura: row.fecha_apertura,
  rol_participacion: row.rol_participacion || null
});

const mapCajaBootstrapSucursal = (row) => ({
  id_sucursal: Number(row.id_sucursal),
  nombre_sucursal: row.nombre_sucursal
});

const fetchCajaBootstrapSucursalesDisponibles = async ({ scope }) => {
  if (scope?.isSuperAdmin) {
    const result = await pool.query(
      `
        SELECT s.id_sucursal, s.nombre_sucursal
        FROM public.sucursales s
        WHERE COALESCE(s.estado, true) = true
        ORDER BY s.nombre_sucursal, s.id_sucursal
      `
    );
    return (result.rows || []).map(mapCajaBootstrapSucursal);
  }

  const allowedIds = coercePositiveIntArray(scope?.allowedSucursalIds);
  const userSucursalId = parseOptionalPositiveInt(scope?.userSucursalId);
  const effectiveIds = allowedIds.length > 0
    ? allowedIds
    : userSucursalId
      ? [userSucursalId]
      : [];
  if (effectiveIds.length === 0) return [];

  const result = await pool.query(
    `
      SELECT s.id_sucursal, s.nombre_sucursal
      FROM public.sucursales s
      WHERE s.id_sucursal = ANY($1::int[])
        AND COALESCE(s.estado, true) = true
      ORDER BY s.nombre_sucursal, s.id_sucursal
    `,
    [effectiveIds]
  );
  return (result.rows || []).map(mapCajaBootstrapSucursal);
};

const fetchCajaBootstrapAvailableSessions = async ({ idUsuario, isSuperAdmin, idSucursal = null }) => {
  const result = await pool.query(
    `
      SELECT DISTINCT ON (cs.id_sucursal, cs.id_sesion_caja)
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        c.codigo_caja,
        c.nombre_caja,
        s.nombre_sucursal,
        estado.codigo AS estado_codigo,
        cs.fecha_apertura,
        COALESCE(
          rol.codigo,
          CASE WHEN cs.id_usuario_responsable = $1 THEN 'RESPONSABLE' END,
          CASE WHEN autorizacion.id_caja_usuario_autorizado IS NOT NULL THEN 'AUTORIZADO' END,
          CASE WHEN $2::boolean THEN 'SUPER_ADMIN' END
        ) AS rol_participacion
      FROM public.cajas_sesiones cs
      INNER JOIN public.cat_cajas_sesiones_estados estado
        ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
       AND UPPER(estado.codigo) = 'ABIERTA'
      INNER JOIN public.cajas c
        ON c.id_caja = cs.id_caja
       AND COALESCE(c.estado, true) = true
      INNER JOIN public.sucursales s
        ON s.id_sucursal = cs.id_sucursal
       AND COALESCE(s.estado, true) = true
      LEFT JOIN public.cajas_sesiones_participantes participante
        ON participante.id_sesion_caja = cs.id_sesion_caja
       AND participante.id_usuario = $1
       AND COALESCE(participante.activo, true) = true
      LEFT JOIN public.cat_cajas_roles_participacion rol
        ON rol.id_rol_participacion_caja = participante.id_rol_participacion_caja
      LEFT JOIN public.cajas_usuarios_autorizados autorizacion
        ON autorizacion.id_caja = cs.id_caja
       AND autorizacion.id_usuario = $1
       AND COALESCE(autorizacion.estado, true) = true
       AND (
         COALESCE(autorizacion.puede_responsable, false) = true
         OR COALESCE(autorizacion.puede_auxiliar, false) = true
       )
      WHERE ($3::int IS NULL OR cs.id_sucursal = $3)
        AND (
          cs.id_usuario_responsable = $1
          OR participante.id_participacion_caja IS NOT NULL
          OR autorizacion.id_caja_usuario_autorizado IS NOT NULL
          OR $2::boolean = true
        )
      ORDER BY cs.id_sucursal, cs.id_sesion_caja, cs.fecha_apertura DESC
    `,
    [idUsuario, Boolean(isSuperAdmin), idSucursal]
  );
  return (result.rows || []).map(mapCajaAvailableSession);
};

export const fetchCajaBootstrapOperationalState = async ({ idUsuario, idSucursal = null, db = pool }) => {
  const result = await db.query(
    `
      WITH active_session AS (
        SELECT
          cs.id_sesion_caja,
          cs.id_caja,
          cs.id_sucursal,
          c.codigo_caja,
          c.nombre_caja,
          COALESCE(c.estado, true) AS caja_estado,
          s.nombre_sucursal,
          estado.codigo AS estado_codigo,
          cs.id_usuario_responsable,
          responsable.nombre_usuario AS responsable_usuario,
          COALESCE(
            NULLIF(TRIM(CONCAT_WS(' ', persona.nombre, persona.apellido)), ''),
            responsable.nombre_usuario
          ) AS responsable_nombre,
          COALESCE(
            participante.rol_codigo,
            CASE WHEN cs.id_usuario_responsable = $1 THEN 'RESPONSABLE' END
          ) AS rol_participacion,
          cs.fecha_apertura,
          cs.monto_apertura
        FROM public.cajas_sesiones cs
        INNER JOIN public.cat_cajas_sesiones_estados estado
          ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
         AND UPPER(estado.codigo) = 'ABIERTA'
        INNER JOIN public.cajas c
          ON c.id_caja = cs.id_caja
         AND COALESCE(c.estado, true) = true
        INNER JOIN public.sucursales s
          ON s.id_sucursal = cs.id_sucursal
         AND COALESCE(s.estado, true) = true
        INNER JOIN public.usuarios responsable
          ON responsable.id_usuario = cs.id_usuario_responsable
        LEFT JOIN public.empleados empleado
          ON empleado.id_empleado = responsable.id_empleado
        LEFT JOIN public.personas persona
          ON persona.id_persona = empleado.id_persona
        LEFT JOIN LATERAL (
          SELECT participacion.id_participacion_caja, rol.codigo AS rol_codigo
          FROM public.cajas_sesiones_participantes participacion
          LEFT JOIN public.cat_cajas_roles_participacion rol
            ON rol.id_rol_participacion_caja = participacion.id_rol_participacion_caja
          WHERE participacion.id_sesion_caja = cs.id_sesion_caja
            AND participacion.id_usuario = $1
            AND COALESCE(participacion.activo, true) = true
          ORDER BY participacion.fecha_inicio DESC NULLS LAST, participacion.id_participacion_caja DESC
          LIMIT 1
        ) participante ON true
        WHERE (
            cs.id_usuario_responsable = $1
            OR participante.id_participacion_caja IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM public.cajas_usuarios_autorizados autorizacion_operativa
              WHERE autorizacion_operativa.id_caja = cs.id_caja
                AND autorizacion_operativa.id_usuario = $1
                AND COALESCE(autorizacion_operativa.estado, true) = true
                AND (
                  COALESCE(autorizacion_operativa.puede_responsable, false) = true
                  OR COALESCE(autorizacion_operativa.puede_auxiliar, false) = true
                )
            )
          )
          AND ($2::int IS NULL OR cs.id_sucursal = $2)
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
        LIMIT 1
      ),
      target_sucursal AS (
        SELECT COALESCE($2::int, (SELECT id_sucursal FROM active_session)) AS id_sucursal
      )
      SELECT
        sucursal.id_sucursal,
        sucursal.nombre_sucursal,
        sesion.id_sesion_caja,
        sesion.estado_codigo,
        sesion.id_usuario_responsable,
        sesion.responsable_usuario,
        sesion.responsable_nombre,
        sesion.rol_participacion,
        sesion.fecha_apertura,
        sesion.monto_apertura,
        COALESCE(sesion.id_caja, asignacion.id_caja) AS id_caja,
        COALESCE(sesion.codigo_caja, caja.codigo_caja) AS codigo_caja,
        COALESCE(sesion.nombre_caja, caja.nombre_caja) AS nombre_caja,
        COALESCE(sesion.caja_estado, caja.estado, false) AS caja_estado,
        COALESCE(asignacion.puede_responsable, false) AS puede_responsable,
        COALESCE(asignacion.puede_auxiliar, false) AS puede_auxiliar
      FROM target_sucursal objetivo
      INNER JOIN public.sucursales sucursal
        ON sucursal.id_sucursal = objetivo.id_sucursal
       AND COALESCE(sucursal.estado, true) = true
      LEFT JOIN active_session sesion
        ON sesion.id_sucursal = sucursal.id_sucursal
      LEFT JOIN LATERAL (
        SELECT
          autorizacion.id_caja,
          autorizacion.puede_responsable,
          autorizacion.puede_auxiliar
        FROM public.cajas_usuarios_autorizados autorizacion
        INNER JOIN public.cajas caja_asignada
          ON caja_asignada.id_caja = autorizacion.id_caja
         AND caja_asignada.id_sucursal = sucursal.id_sucursal
         AND COALESCE(caja_asignada.estado, true) = true
        WHERE autorizacion.id_usuario = $1
          AND COALESCE(autorizacion.estado, true) = true
          AND (
            COALESCE(autorizacion.puede_responsable, false) = true
            OR COALESCE(autorizacion.puede_auxiliar, false) = true
          )
        ORDER BY
          COALESCE(autorizacion.puede_responsable, false) DESC,
          autorizacion.fecha_actualizacion DESC,
          autorizacion.id_caja_usuario_autorizado DESC
        LIMIT 1
      ) asignacion ON true
      LEFT JOIN public.cajas caja
        ON caja.id_caja = COALESCE(sesion.id_caja, asignacion.id_caja)
      LIMIT 1
    `,
    [idUsuario, idSucursal]
  );

  const row = result.rows?.[0] || null;
  if (!row) return null;

  const cajaActiva = row.id_caja
    ? {
        id_caja: Number(row.id_caja),
        id_sucursal: Number(row.id_sucursal),
        nombre_sucursal: row.nombre_sucursal,
        codigo_caja: row.codigo_caja,
        nombre_caja: row.nombre_caja,
        estado: Boolean(row.caja_estado),
        puede_responsable: Boolean(row.puede_responsable),
        puede_auxiliar: Boolean(row.puede_auxiliar),
        puede_operar: Boolean(row.id_sesion_caja),
        puede_abrir: Boolean(!row.id_sesion_caja && row.puede_responsable),
        estado_operativo: row.id_sesion_caja ? 'SESION_ACTIVA_USUARIO' : 'ASIGNADA_SIN_SESION'
      }
    : null;
  const sesionCaja = row.id_sesion_caja
    ? {
        id_sesion_caja: Number(row.id_sesion_caja),
        id_caja: Number(row.id_caja),
        id_sucursal: Number(row.id_sucursal),
        nombre_sucursal: row.nombre_sucursal,
        codigo_caja: row.codigo_caja,
        nombre_caja: row.nombre_caja,
        estado: row.estado_codigo,
        estado_codigo: row.estado_codigo,
        id_usuario_responsable: Number(row.id_usuario_responsable),
        responsable_usuario: row.responsable_usuario,
        responsable_nombre: row.responsable_nombre,
        rol_participacion: row.rol_participacion,
        rol_codigo: row.rol_participacion,
        fecha_apertura: row.fecha_apertura,
        monto_apertura: Number(row.monto_apertura || 0)
      }
    : null;

  return {
    id_sucursal: Number(row.id_sucursal),
    sucursal: {
      id_sucursal: Number(row.id_sucursal),
      nombre_sucursal: row.nombre_sucursal
    },
    caja_activa: cajaActiva,
    sesion_caja: sesionCaja
  };
};

export const getCajaBootstrapHandler = async (req, res) => {
  const startedAt = performance.now();
  const requestId = String(req.headers['x-request-id'] || '').trim().slice(0, 80) || `vcb-${randomUUID()}`;
  let idSucursal = null;
  let idTipoDepartamento = null;
  let cacheStatus = 'MISS';
  let sqlDurationMs = 0;
  let mappingDurationMs = 0;
  let recipeCount = 0;
  try {
    idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);
    idTipoDepartamento = parseOptionalPositiveInt(req.query.id_tipo_departamento);
    if (req.query.id_tipo_departamento !== undefined && !idTipoDepartamento) {
      return res.status(400).json({ error: true, message: 'id_tipo_departamento debe ser un entero mayor a 0.' });
    }

    const scope = await resolveRequestUserSucursalScope(req);
    if (!idSucursal && !scope.isSuperAdmin) {
      idSucursal = scope.userSucursalId
        || (scope.allowedSucursalIds.length === 1 ? Number(scope.allowedSucursalIds[0]) : null);
    }
    const sessionsStartedAt = performance.now();
    const [sesionesDisponibles, sucursalesDisponibles] = await Promise.all([
      fetchCajaBootstrapAvailableSessions({
        idUsuario: scope.idUsuario,
        isSuperAdmin: scope.isSuperAdmin,
        idSucursal
      }),
      fetchCajaBootstrapSucursalesDisponibles({ scope })
    ]);
    sqlDurationMs += performance.now() - sessionsStartedAt;
    if (!idSucursal && scope.isSuperAdmin) {
      if (sesionesDisponibles.length === 1) {
        idSucursal = Number(sesionesDisponibles[0].id_sucursal);
      } else {
        return res.status(200).json({
          data: {
            id_sucursal: null,
            sucursal: null,
            caja_activa: null,
            sesion_caja: null,
            sesiones_disponibles: sesionesDisponibles,
            sucursales_disponibles: sucursalesDisponibles,
            requiere_seleccion_sucursal: sucursalesDisponibles.length > 1,
            requiere_sesion_caja: sesionesDisponibles.length === 0,
            departamentos: [],
            departamento_activo: null,
            recetas: []
          },
          meta: {
            cache: 'MISS',
            duration_ms: Number((performance.now() - startedAt).toFixed(2)),
            sql_duration_ms: Number(sqlDurationMs.toFixed(2)),
            mapping_duration_ms: 0
          }
        });
      }
    }
    const operationalStartedAt = performance.now();
    let operationalState = await fetchCajaBootstrapOperationalState({
      idUsuario: scope.idUsuario,
      idSucursal
    });
    sqlDurationMs += performance.now() - operationalStartedAt;
    idSucursal = idSucursal || operationalState?.id_sucursal || null;
    if (!idSucursal) {
      return res.status(200).json({
        data: {
          id_sucursal: null,
          sucursal: null,
          caja_activa: null,
          sesion_caja: null,
          sesiones_disponibles: sesionesDisponibles,
          sucursales_disponibles: sucursalesDisponibles,
          requiere_seleccion_sucursal: true,
          departamentos: [],
          departamento_activo: null,
          recetas: []
        },
        meta: {
          cache: 'MISS',
          duration_ms: Number((performance.now() - startedAt).toFixed(2)),
          sql_duration_ms: Number(sqlDurationMs.toFixed(2)),
          mapping_duration_ms: 0
        }
      });
    }
    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) return res.status(sucursalValidation.status).json(sucursalValidation.body);
    if (!operationalState || Number(operationalState.id_sucursal) !== idSucursal) {
      const scopedOperationalStartedAt = performance.now();
      operationalState = await fetchCajaBootstrapOperationalState({
        idUsuario: scope.idUsuario,
        idSucursal
      });
      sqlDurationMs += performance.now() - scopedOperationalStartedAt;
    }

    if (!operationalState?.sesion_caja) {
      const durationMs = performance.now() - startedAt;
      return res.status(200).json({
        data: {
          id_sucursal: idSucursal,
          sucursal: operationalState?.sucursal || null,
          caja_activa: operationalState?.caja_activa || null,
          sesion_caja: null,
          sesiones_disponibles: sesionesDisponibles,
          sucursales_disponibles: sucursalesDisponibles,
          requiere_sesion_caja: true,
          departamentos: [],
          departamento_activo: null,
          recetas: []
        },
        meta: {
          cache: 'MISS',
          duration_ms: Number(durationMs.toFixed(2)),
          sql_duration_ms: Number(sqlDurationMs.toFixed(2)),
          mapping_duration_ms: 0
        }
      });
    }

    const cacheKey = buildCajaBootstrapCacheKey({
      idSucursal,
      idTipoDepartamento: idTipoDepartamento || 0
    });
    const cached = await fetchCachedCajaBootstrap(cacheKey, async () => {
      const departmentsStartedAt = performance.now();
      const departmentsResult = await pool.query(
        `
          SELECT id_tipo_departamento, nombre_departamento, descripcion, estado
          FROM public.tipo_departamento
          WHERE COALESCE(estado, true) = true
          ORDER BY nombre_departamento, id_tipo_departamento
        `
      );
      const departmentsSqlMs = performance.now() - departmentsStartedAt;
      const departamentos = departmentsResult.rows || [];
      const departamentoActivo = idTipoDepartamento
        ? departamentos.find((row) => Number(row.id_tipo_departamento) === idTipoDepartamento)
        : departamentos.find((row) => String(row.nombre_departamento || '').trim().toUpperCase() === 'ALITAS');
      if (!departamentoActivo) {
        const error = new Error('El departamento solicitado no existe o esta inactivo.');
        error.httpStatus = 404;
        throw error;
      }
      const recetasResult = await fetchRecetasCatalogoData({
        req,
        idSucursal,
        idTipoDepartamento: Number(departamentoActivo.id_tipo_departamento)
      });
      return {
        data: {
          id_sucursal: idSucursal,
          departamentos,
          departamento_activo: departamentoActivo,
          recetas: recetasResult.data
        },
        metrics: {
          sql_duration_ms: departmentsSqlMs + recetasResult.sqlDurationMs,
          mapping_duration_ms: recetasResult.mappingDurationMs
        }
      };
    });
    cacheStatus = cached.cache;
    idTipoDepartamento = Number(cached.value.data?.departamento_activo?.id_tipo_departamento || idTipoDepartamento || 0) || null;
    sqlDurationMs += cacheStatus === 'HIT' ? 0 : Number(cached.value.metrics?.sql_duration_ms || 0);
    mappingDurationMs = cacheStatus === 'HIT' ? 0 : Number(cached.value.metrics?.mapping_duration_ms || 0);
    recipeCount = Array.isArray(cached.value.data?.recetas) ? cached.value.data.recetas.length : 0;
    const durationMs = performance.now() - startedAt;
    res.setHeader('X-Request-Id', requestId);
    return res.status(200).json({
      data: {
        ...cached.value.data,
        sucursal: operationalState.sucursal,
        caja_activa: operationalState.caja_activa,
        sesion_caja: operationalState.sesion_caja,
        sesiones_disponibles: sesionesDisponibles,
        sucursales_disponibles: sucursalesDisponibles,
        requiere_seleccion_sucursal: false,
        requiere_sesion_caja: false
      },
      meta: {
        cache: cacheStatus,
        duration_ms: Number(durationMs.toFixed(2)),
        sql_duration_ms: Number(sqlDurationMs.toFixed(2)),
        mapping_duration_ms: Number(mappingDurationMs.toFixed(2))
      }
    });
  } catch (err) {
    const status = Number(err?.httpStatus || 500);
    console.error('[ventas.caja.bootstrap] error', {
      request_id: requestId,
      id_sucursal: idSucursal,
      id_tipo_departamento: idTipoDepartamento,
      code: err?.code || null,
      message: err?.message || 'Error sin mensaje'
    });
    return res.status(status).json({
      error: true,
      message: status === 404 ? err.message : 'No se pudo cargar Caja.'
    });
  } finally {
    if (isVentasPerfEnabled()) {
      console.info('[ventas:caja:bootstrap]', {
        request_id: requestId,
        endpoint: 'GET /api/ventas/caja/bootstrap',
        id_sucursal: idSucursal,
        id_tipo_departamento: idTipoDepartamento,
        cache: cacheStatus,
        sql_duration_ms: Number(sqlDurationMs.toFixed(2)),
        mapping_duration_ms: Number(mappingDurationMs.toFixed(2)),
        total_duration_ms: Number((performance.now() - startedAt).toFixed(2)),
        cantidad_recetas: recipeCount,
        pool: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount
        }
      });
    }
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
  let scope = null;
  let idSucursal = null;
  try {
    scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);
    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) {
      return res.status(sucursalValidation.status).json(sucursalValidation.body);
    }

    const params = [];
    let sucursalWhere = '';
    if (idSucursal) {
      params.push(idSucursal);
      sucursalWhere = 'AND (dc.id_sucursal IS NULL OR dc.id_sucursal = $1)';
    } else if (!isSuperAdmin) {
      const allowedSucursalIds = coercePositiveIntArray(scope.allowedSucursalIds);
      if (allowedSucursalIds.length === 0) {
        return res.status(200).json([]);
      }
      params.push(allowedSucursalIds);
      sucursalWhere = 'AND (dc.id_sucursal IS NULL OR dc.id_sucursal = ANY($1::int[]))';
    }

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
          dc.id_sucursal,
          dc.fecha_inicio,
          dc.fecha_fin,
          dc.id_tipo_descuento,
          td.nombre_tipo_descuento,
          COALESCE(objp.productos, '[]'::jsonb) AS productos,
          COALESCE(objr.recetas, '[]'::jsonb) AS recetas,
          COALESCE(objp.productos_ids, ARRAY[]::int[]) AS productos_ids,
          COALESCE(objr.recetas_ids, ARRAY[]::int[]) AS recetas_ids
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
        WHERE COALESCE(dc.estado, true) = true
          AND COALESCE(td.estado, true) = true
          ${sucursalWhere}
        ORDER BY dc.nombre_descuento ASC, dc.id_descuento_catalogo ASC
      `,
      params
    );
    res.status(200).json((result.rows || []).map(normalizeDescuentoCatalogoRow));
  } catch (err) {
    logDescuentosCatalogError({ err, req, scope, idSucursal });
    sendVentasInternalError(res);
  }
};
