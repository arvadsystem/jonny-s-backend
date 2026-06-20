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
  resolveComboComplementMetadata,
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
    const directId = parseOptionalPositiveInt(search);
    const searchDigits = search.replace(/\D/g, '');
    const isDirectIdentifier = Boolean(directId || searchDigits.length >= 4);
    if (search && !isDirectIdentifier && search.length < 2) {
      return res.status(200).json([]);
    }
    const parsedLimit = Number.parseInt(String(req.query.limit ?? 20), 10);
    const limit = Math.min(50, Math.max(1, Number.isInteger(parsedLimit) ? parsedLimit : 20));
    const query = `
      SELECT
        c.id_cliente,
        c.estado,
        c.id_tipo_cliente,
        p.nombre,
        p.apellido,
        p.dni,
        p.rtn AS persona_rtn,
        p.id_telefono AS persona_id_telefono,
        tp.telefono AS persona_telefono,
        e.nombre_empresa,
        e.rtn AS empresa_rtn,
        e.id_telefono AS empresa_id_telefono,
        te.telefono AS empresa_telefono
      FROM clientes c
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN telefonos tp ON tp.id_telefono = p.id_telefono
      LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
      LEFT JOIN telefonos te ON te.id_telefono = e.id_telefono
      WHERE COALESCE(c.estado, true) = true
        AND (
          $4 = ''
          OR ($2::int IS NOT NULL AND c.id_cliente = $2)
          OR COALESCE(p.dni, '') ILIKE $1
          OR COALESCE(p.rtn, '') ILIKE $1
          OR COALESCE(e.rtn, '') ILIKE $1
          OR regexp_replace(COALESCE(tp.telefono, ''), '\\D', '', 'g') ILIKE $3
          OR regexp_replace(COALESCE(te.telefono, ''), '\\D', '', 'g') ILIKE $3
          OR trim(concat_ws(' ', p.nombre, p.apellido)) ILIKE $1
          OR COALESCE(e.nombre_empresa, '') ILIKE $1
        )
      ORDER BY
        CASE
          WHEN $2::int IS NOT NULL AND c.id_cliente = $2 THEN 0
          WHEN UPPER(COALESCE(p.dni, '')) = UPPER($4) OR UPPER(COALESCE(p.rtn, '')) = UPPER($4) OR UPPER(COALESCE(e.rtn, '')) = UPPER($4) THEN 1
          WHEN regexp_replace(COALESCE(tp.telefono, ''), '\\D', '', 'g') = $5 OR regexp_replace(COALESCE(te.telefono, ''), '\\D', '', 'g') = $5 THEN 2
          WHEN trim(concat_ws(' ', p.nombre, p.apellido)) ILIKE $6 OR COALESCE(e.nombre_empresa, '') ILIKE $6 THEN 3
          ELSE 4
        END,
        COALESCE(NULLIF(trim(concat_ws(' ', p.nombre, p.apellido)), ''), e.nombre_empresa, c.id_cliente::text),
        c.id_cliente
      LIMIT $7
    `;

    const result = await pool.query(query, [
      `%${search}%`,
      directId,
      searchDigits ? `%${searchDigits}%` : '%__NO_PHONE_MATCH__%',
      search,
      searchDigits || '__NO_PHONE_MATCH__',
      `${search}%`,
      limit
    ]);
    const data = result.rows.map((row) => ({
      id_cliente: row.id_cliente,
      id_tipo_cliente: row.id_tipo_cliente,
      estado: row.estado,
      nombre_cliente: normalizeClienteNombre(row),
      telefono: row.persona_telefono || row.empresa_telefono || null,
      id_telefono: row.persona_id_telefono || row.empresa_id_telefono || null,
      dni: row.dni || null,
      rtn: row.empresa_rtn || row.persona_rtn || null,
      es_consumidor_final: false
    }));

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar catalogo de clientes para ventas:', err.message);
    sendVentasInternalError(res);
  }
};

export const listCombosCatalogoHandler = async (req, res) => {
  let idSucursal = null;
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);
    const hasComboAssignmentsTable = await hasTable(pool, 'menu_combo_almacenes');

    const sucursalValidation = await validateVentasCatalogSucursal({ scope, idSucursal });
    if (!sucursalValidation.ok) {
      return res.status(sucursalValidation.status).json(sucursalValidation.body);
    }
    if (!idSucursal) {
      return res.status(400).json({ error: true, message: 'id_sucursal es obligatorio para listar complementos.' });
    }

    let joinClause = '';
    let whereClause = '';
    const params = [];

    if (idSucursal) {
      params.push(idSucursal);
      joinClause = 'INNER JOIN menu_vigente mv ON mv.id_menu = c.id_menu';
      whereClause = 'AND mv.id_sucursal = $1 AND COALESCE(mv.estado, true) = true AND (mv.fecha_inicio IS NULL OR mv.fecha_inicio <= CURRENT_TIMESTAMP)';
      if (hasComboAssignmentsTable) {
        joinClause += `
          INNER JOIN public.menu_combo_almacenes mca
            ON mca.id_combo = c.id_combo
           AND COALESCE(mca.estado, true) = true
          INNER JOIN public.almacenes aca
            ON aca.id_almacen = mca.id_almacen
           AND COALESCE(aca.estado, true) = true
           AND aca.id_sucursal = $1
          INNER JOIN public.sucursales sca
            ON sca.id_sucursal = aca.id_sucursal
           AND COALESCE(sca.estado, true) = true
        `;
      }
    } else if (!isSuperAdmin) {
      params.push(scope.allowedSucursalIds);
      joinClause = 'INNER JOIN menu_vigente mv ON mv.id_menu = c.id_menu';
      whereClause = 'AND mv.id_sucursal = ANY($1::int[]) AND COALESCE(mv.estado, true) = true AND (mv.fecha_inicio IS NULL OR mv.fecha_inicio <= CURRENT_TIMESTAMP)';
      if (hasComboAssignmentsTable) {
        joinClause += `
          INNER JOIN public.menu_combo_almacenes mca
            ON mca.id_combo = c.id_combo
           AND COALESCE(mca.estado, true) = true
          INNER JOIN public.almacenes aca
            ON aca.id_almacen = mca.id_almacen
           AND COALESCE(aca.estado, true) = true
           AND aca.id_sucursal = ANY($1::int[])
          INNER JOIN public.sucursales sca
            ON sca.id_sucursal = aca.id_sucursal
           AND COALESCE(sca.estado, true) = true
        `;
      }
    }

    const query = `
      WITH combo_departamento_counts AS (
        SELECT
          dc.id_combo,
          r.id_tipo_departamento,
          td.nombre_departamento,
          COUNT(*)::int AS total_componentes
        FROM detalle_combo dc
        INNER JOIN recetas r
          ON r.id_receta = dc.id_receta
        LEFT JOIN tipo_departamento td
          ON td.id_tipo_departamento = r.id_tipo_departamento
        WHERE COALESCE(dc.estado, true) = true
          AND COALESCE(r.estado, true) = true
          AND r.id_tipo_departamento IS NOT NULL
        GROUP BY dc.id_combo, r.id_tipo_departamento, td.nombre_departamento
      ),
      combo_departamento_principal AS (
        SELECT DISTINCT ON (id_combo)
          id_combo,
          id_tipo_departamento,
          nombre_departamento
        FROM combo_departamento_counts
        ORDER BY id_combo, total_componentes DESC, id_tipo_departamento ASC
      ),
      combo_departamentos AS (
        SELECT
          id_combo,
          ARRAY_AGG(id_tipo_departamento ORDER BY id_tipo_departamento) AS departamentos_ids,
          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'id_tipo_departamento', id_tipo_departamento,
              'nombre_tipo_departamento', nombre_departamento
            )
            ORDER BY id_tipo_departamento
          ) AS departamentos
        FROM combo_departamento_counts
        GROUP BY id_combo
      )
      SELECT DISTINCT
        c.id_combo,
        c.nombre_combo,
        c.descripcion,
        c.precio,
        c.estado,
        c.id_archivo,
        COALESCE(c.id_tipo_departamento, cdp.id_tipo_departamento) AS id_tipo_departamento,
        COALESCE(td.nombre_departamento, cdp.nombre_departamento) AS nombre_tipo_departamento,
        cdp.id_tipo_departamento AS id_tipo_departamento_principal,
        cdp.nombre_departamento AS nombre_tipo_departamento_principal,
        COALESCE(cd.departamentos_ids, ARRAY[]::int[]) AS departamentos_ids,
        COALESCE(cd.departamentos, '[]'::jsonb) AS departamentos,
        a.url_publica AS imagen_principal_url,
        COALESCE(
          NULLIF(TRIM(c.nombre_combo), ''),
          c.descripcion
        ) AS nombre_orden
      FROM combos c
      LEFT JOIN archivos a ON a.id_archivo = c.id_archivo AND (a.estado = true OR a.estado IS NULL)
      LEFT JOIN tipo_departamento td
        ON td.id_tipo_departamento = c.id_tipo_departamento
      LEFT JOIN combo_departamento_principal cdp
        ON cdp.id_combo = c.id_combo
      LEFT JOIN combo_departamentos cd
        ON cd.id_combo = c.id_combo
      ${joinClause}
      WHERE COALESCE(c.estado, true) = true ${whereClause}
      ORDER BY nombre_orden ASC, c.id_combo ASC
    `;

    const result = await pool.query(query, params);
    const comboRows = Array.isArray(result.rows) ? result.rows : [];
    const complementContext = await buildVentaComplementContext({
      client: pool,
      idSucursal,
      normalizedItems: comboRows.map((row) => ({
        kind: 'COMBO',
        id_combo: Number(row?.id_combo || 0),
        cantidad: 1,
        complementos: []
      }))
    });

    const data = comboRows.map((row) => {
      const { nombre_orden: _nombreOrden, ...publicRow } = row;
      const metadata = resolveComboComplementMetadata({
        combo: row,
        quantity: 1,
        components: complementContext.comboComponentsByCombo.get(Number(row?.id_combo || 0)) || [],
        saucesByRecipe: complementContext.saucesByRecipe,
        rulesByRecipe: complementContext.rulesByRecipe,
        fallbackSauces: complementContext.fallbackSauces
      });

      return {
        ...publicRow,
        imagen_principal_url: buildAbsolutePublicUrl(req, row.imagen_principal_url),
        requiere_complementos: Boolean(metadata.requiere_complementos),
        tipo_complemento: metadata.tipo_complemento || VENTA_COMPLEMENTO_TIPO_SALSAS,
        minimo_complementos: Number(metadata.minimo_complementos || 0),
        maximo_complementos: Number(metadata.maximo_complementos || 0),
        complementos_disponibles: (Array.isArray(metadata.complementos_disponibles) ? metadata.complementos_disponibles : []).map((entry) => ({
          id_complemento: Number(entry?.id_complemento || entry?.id_salsa || 0),
          nombre: String(entry?.nombre || 'Salsa').trim(),
          disponible: entry?.disponible !== false
        })).filter((entry) => entry.id_complemento > 0)
      };
    });

    res.status(200).json(data);
  } catch (err) {
    console.error('[ventas.catalogos.combos] error', {
      code: err?.code || null,
      message: err?.message || 'Error sin mensaje',
      id_sucursal: idSucursal || null
    });
    sendVentasInternalError(res);
  }
};

const fetchRecetasCatalogoData = async ({ req, idSucursal, idTipoDepartamento = null }) => {
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
      complementos_disponibles: (Array.isArray(metadata.complementos_disponibles) ? metadata.complementos_disponibles : []).map((entry) => ({
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

const fetchCajaBootstrapOperationalState = async ({ idUsuario, idSucursal = null, isSuperAdmin = false }) => {
  const result = await pool.query(
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
            OR $3::boolean = true
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
    [idUsuario, idSucursal, Boolean(isSuperAdmin)]
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
      idSucursal,
      isSuperAdmin: scope.isSuperAdmin
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
        idSucursal,
        isSuperAdmin: scope.isSuperAdmin
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
    logDescuentosCatalogError({ err, req, scope, idSucursal });
    sendVentasInternalError(res);
  }
};
