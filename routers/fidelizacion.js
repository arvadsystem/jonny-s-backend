import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import {
  buildErrorBody,
  isValidDateOnly,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  unknownFieldsFromPayload
} from '../utils/security/personasHardening.js';
import {
  computeRedemptionPoints,
  createFidelizacionError,
  createPresentialFidelizacionCanje,
  getActiveFidelizacionConfig,
  insertFidelizacionAuditLog,
  normalizeText,
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber
} from '../services/fidelizacionService.js';

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const MULTISUCURSAL_PERMISSION = 'fidelizacion_ver_multisucursal';
const CLIENT_ROLE_NAME = 'CLIENTE';
const TEGUCIGALPA_TIMEZONE = 'America/Tegucigalpa';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePageParam = (value, fallback = 1) => {
  if (value === undefined) return fallback;
  return parsePositiveInt(value);
};

const parseLimitParam = (value, fallback = 20) => {
  if (value === undefined) return fallback;
  const parsed = parsePositiveInt(value);
  if (!parsed) return null;
  return Math.min(parsed, MAX_PAGE_SIZE);
};

const parseNullablePositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parsePositiveInt(value);
};

const parseOptionalDateOnly = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim();
  return isValidDateOnly(normalized) ? normalized : null;
};

const buildLikeSearch = (value) => {
  const normalized = normalizeText(value);
  return normalized ? `%${normalized}%` : null;
};

const asyncHandler = (handler, { defaultCode, defaultMessage }) => async (req, res) => {
  try {
    const result = await handler(req, res);
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error(`[fidelizacion] ${req.method} ${req.originalUrl}:`, error);

    if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500) {
      return res.status(error.httpStatus).json(
        buildErrorBody({
          code: error.code || defaultCode,
          message: sanitizeApiErrorMessage(error.publicMessage || error.message, error.httpStatus)
        })
      );
    }

    const mapped = mapDbErrorToSafe(error, {
      defaultMessage: defaultMessage || 'No se pudo procesar la solicitud de fidelizacion.'
    });

    if (mapped) {
      return res.status(mapped.status).json(
        buildErrorBody({
          code: mapped.code || defaultCode,
          message: mapped.message
        })
      );
    }

    return res.status(500).json(
      buildErrorBody({
        code: defaultCode || 'FIDELIZACION_INTERNAL_ERROR',
        message: defaultMessage || 'No se pudo procesar la solicitud de fidelizacion.'
      })
    );
  }
};

const getSucursalById = async (client, idSucursal) => {
  const result = await client.query(
    `
      SELECT id_sucursal, nombre_sucursal, COALESCE(estado, true) AS estado
      FROM public.sucursales
      WHERE id_sucursal = $1
      LIMIT 1
    `,
    [idSucursal]
  );

  return result.rows[0] || null;
};

const resolveFidelizacionScope = async ({
  req,
  client,
  requestedSucursalId = null,
  allowAllBranches = false,
  requireOperationalSucursal = false
}) => {
  const scope = await resolveRequestUserSucursalScope(req, client);
  const idUsuario = parsePositiveInt(scope?.idUsuario);
  const userSucursalId = parsePositiveInt(scope?.userSucursalId);
  const allowedSucursalIds = Array.isArray(scope?.allowedSucursalIds)
    ? scope.allowedSucursalIds
        .map((value) => parsePositiveInt(value))
        .filter((value) => value !== null)
    : userSucursalId
    ? [userSucursalId]
    : [];

  if (!idUsuario) {
    throw createFidelizacionError(401, 'FIDELIZACION_UNAUTHORIZED', 'No autorizado.');
  }

  const hasMultisucursalAccess =
    Boolean(scope?.isSuperAdmin) ||
    (await requestHasAnyPermission(req, MULTISUCURSAL_PERMISSION));

  let targetSucursalId = null;
  if (requestedSucursalId) {
    if (!Boolean(scope?.isSuperAdmin)) {
      const isAllowedSucursal = allowedSucursalIds.includes(requestedSucursalId);
      const isOwnSucursal = requestedSucursalId === userSucursalId;
      if (!isAllowedSucursal || (!isOwnSucursal && !hasMultisucursalAccess)) {
        throw createFidelizacionError(
          403,
          'FIDELIZACION_SCOPE_FORBIDDEN',
          'No tiene permiso para operar la sucursal solicitada.'
        );
      }
    }

    const sucursal = await getSucursalById(client, requestedSucursalId);
    if (!sucursal || !Boolean(sucursal.estado)) {
      throw createFidelizacionError(
        404,
        'FIDELIZACION_SUCURSAL_NOT_FOUND',
        'La sucursal seleccionada no esta disponible.'
      );
    }

    targetSucursalId = requestedSucursalId;
  } else if (allowAllBranches && Boolean(scope?.isSuperAdmin) && hasMultisucursalAccess && !requireOperationalSucursal) {
    targetSucursalId = null;
  } else {
    if (!userSucursalId) {
      throw createFidelizacionError(
        403,
        'FIDELIZACION_SCOPE_UNAVAILABLE',
        'El usuario autenticado no tiene una sucursal operativa asignada.'
      );
    }
    targetSucursalId = userSucursalId;
  }

  return {
    idUsuario,
    userSucursalId,
    hasMultisucursalAccess,
    allowedSucursalIds,
    targetSucursalId
  };
};

const assertAllPermissions = async (req, permissions) => {
  for (const permission of permissions) {
    const hasPermission = await requestHasAnyPermission(req, permission);
    if (!hasPermission) {
      throw createFidelizacionError(
        403,
        'FIDELIZACION_PERMISSION_DENIED',
        'Acceso denegado: permisos insuficientes.'
      );
    }
  }
};

const buildClienteBaseSql = () => `
  WITH eligible_clients AS (
    SELECT DISTINCT
      c.id_cliente,
      u.id_usuario AS id_usuario_cliente,
      u.nombre_usuario
    FROM public.clientes c
    INNER JOIN public.usuarios_clientes uc
      ON uc.id_cliente = c.id_cliente
     AND COALESCE(uc.estado, true) = true
    INNER JOIN public.usuarios u
      ON u.id_usuario = uc.id_usuario
     AND u.id_cliente = uc.id_cliente
     AND COALESCE(u.estado, false) = true
    INNER JOIN public.roles_usuarios ru
      ON ru.id_usuario = u.id_usuario
    INNER JOIN public.roles r
      ON r.id_rol = ru.id_rol
    WHERE COALESCE(c.estado, true) = true
      AND UPPER(TRIM(r.nombre)) = '${CLIENT_ROLE_NAME}'
  ),
  cliente_cards AS (
    SELECT
      c.id_cliente,
      ec.id_usuario_cliente,
      ec.nombre_usuario,
      COALESCE(
        NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''),
        NULLIF(TRIM(e.nombre_empresa), ''),
        CONCAT('Cliente #', c.id_cliente::text)
      ) AS nombre_principal,
      COALESCE(cor_p.direccion_correo, cor_e.direccion_correo, '') AS correo,
      COALESCE(tel_p.telefono, tel_e.telefono, '') AS telefono,
      COALESCE(p.dni::text, e.rtn::text, p.rtn::text, '') AS documento,
      COALESCE(fs.puntos_disponibles, c.puntos, 0)::int AS puntos_disponibles,
      COALESCE(fs.puntos_acumulados_total, 0)::int AS puntos_acumulados_total,
      COALESCE(fs.puntos_canjeados_total, 0)::int AS puntos_canjeados_total,
      COALESCE(latest_activity.fecha_ultima_actividad, NULL) AS fecha_ultima_actividad,
      latest_activity.id_sucursal_ultima_actividad,
      latest_activity.nombre_sucursal_ultima_actividad,
      CASE
        WHEN $1::int IS NULL THEN true
        WHEN activity_scope.id_cliente IS NOT NULL THEN true
        WHEN has_activity.id_cliente IS NULL THEN true
        ELSE false
      END AS visible_en_sucursal
    FROM public.clientes c
    INNER JOIN eligible_clients ec
      ON ec.id_cliente = c.id_cliente
    LEFT JOIN public.personas p
      ON p.id_persona = c.id_persona
    LEFT JOIN public.empresas e
      ON e.id_empresa = c.id_empresa
    LEFT JOIN public.telefonos tel_p
      ON tel_p.id_telefono = p.id_telefono
    LEFT JOIN public.telefonos tel_e
      ON tel_e.id_telefono = e.id_telefono
    LEFT JOIN public.correos cor_p
      ON cor_p.id_correo = p.id_correo
    LEFT JOIN public.correos cor_e
      ON cor_e.id_correo = e.id_correo
    LEFT JOIN public.fidelizacion_saldos_cliente fs
      ON fs.id_cliente = c.id_cliente
    LEFT JOIN LATERAL (
      SELECT
        src.fecha_evento AS fecha_ultima_actividad,
        src.id_sucursal AS id_sucursal_ultima_actividad,
        s.nombre_sucursal AS nombre_sucursal_ultima_actividad
      FROM (
        SELECT
          f.fecha_hora_facturacion AS fecha_evento,
          f.id_sucursal
        FROM public.facturas f
        WHERE f.id_cliente = c.id_cliente
          AND f.id_sucursal IS NOT NULL

        UNION ALL

        SELECT
          fc.fecha_creacion AS fecha_evento,
          fc.id_sucursal
        FROM public.fidelizacion_canjes fc
        WHERE fc.id_cliente = c.id_cliente
          AND fc.id_sucursal IS NOT NULL
      ) src
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = src.id_sucursal
      ORDER BY src.fecha_evento DESC NULLS LAST
      LIMIT 1
    ) latest_activity ON true
    LEFT JOIN LATERAL (
      SELECT x.id_cliente
      FROM (
        SELECT f.id_cliente
        FROM public.facturas f
        WHERE f.id_cliente = c.id_cliente

        UNION ALL

        SELECT fc.id_cliente
        FROM public.fidelizacion_canjes fc
        WHERE fc.id_cliente = c.id_cliente
      ) x
      LIMIT 1
    ) has_activity ON true
    LEFT JOIN LATERAL (
      SELECT x.id_cliente
      FROM (
        SELECT f.id_cliente
        FROM public.facturas f
        WHERE f.id_cliente = c.id_cliente
          AND f.id_sucursal = $1

        UNION ALL

        SELECT fc.id_cliente
        FROM public.fidelizacion_canjes fc
        WHERE fc.id_cliente = c.id_cliente
          AND fc.id_sucursal = $1
      ) x
      LIMIT 1
    ) activity_scope ON true
  )
`;

const buildClienteWhereClause = ({ searchParamRef }) => `
  FROM cliente_cards cc
  WHERE cc.visible_en_sucursal = true
    AND (
      ${searchParamRef}::text IS NULL
      OR cc.nombre_principal ILIKE ${searchParamRef}
      OR cc.correo ILIKE ${searchParamRef}
      OR cc.telefono ILIKE ${searchParamRef}
      OR cc.documento ILIKE ${searchParamRef}
      OR cc.nombre_usuario ILIKE ${searchParamRef}
      OR cc.id_cliente::text ILIKE ${searchParamRef}
    )
`;

const fetchClienteDetalleRow = async (client, idCliente, targetSucursalId = null) => {
  const result = await client.query(
    `
      ${buildClienteBaseSql()}
      SELECT *
      FROM cliente_cards
      WHERE id_cliente = $2
        AND visible_en_sucursal = true
      LIMIT 1
    `,
    [targetSucursalId, idCliente]
  );

  return result.rows[0] || null;
};

const getConfiguracionProducts = async (client, idSucursal, lempirasPorPunto = null) => {
  if (!parsePositiveInt(idSucursal)) return [];

  const result = await client.query(
    `
      SELECT
        fps.id_registro,
        fps.id_sucursal,
        fps.id_producto,
        fps.puntos_requeridos_override,
        COALESCE(fps.estado, true) AS estado,
        fps.id_usuario_creador,
        fps.fecha_creacion,
        fps.fecha_actualizacion,
        p.nombre_producto,
        p.precio,
        COALESCE(p.estado, true) AS producto_estado,
        p.id_almacen,
        COALESCE(p.cantidad, 0)::int AS cantidad,
        COALESCE(p.stock_minimo, 0)::int AS stock_minimo,
        a.id_sucursal AS id_sucursal_almacen,
        COALESCE(a.estado, true) AS almacen_estado
      FROM public.fidelizacion_productos_canjeables_sucursal fps
      INNER JOIN public.productos p
        ON p.id_producto = fps.id_producto
      LEFT JOIN public.almacenes a
        ON a.id_almacen = p.id_almacen
      WHERE fps.id_sucursal = $1
      ORDER BY COALESCE(fps.estado, true) DESC, p.nombre_producto ASC, fps.id_registro ASC
    `,
    [idSucursal]
  );

  return result.rows.map((row) => ({
    ...row,
    puntos_requeridos_efectivos:
      parseNonNegativeInt(row.puntos_requeridos_override) ??
      computeRedemptionPoints(row.precio, lempirasPorPunto),
    stock_disponible: Math.max(
      Number(row.cantidad || 0) - Number(row.stock_minimo || 0),
      0
    )
  }));
};

const fidelizacionService = {
  async panel(req) {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    if (req.query.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal debe ser un entero positivo.'
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: true
    });

    const [config, aggregateResult, canjesHoyResult, canjesMesResult] = await Promise.all([
      scope.targetSucursalId ? getActiveFidelizacionConfig(pool, scope.targetSucursalId) : null,
      pool.query(
        `
          ${buildClienteBaseSql()}
          SELECT
            COUNT(*) FILTER (WHERE COALESCE(puntos_disponibles, 0) > 0)::int AS clientes_con_puntos,
            COALESCE(SUM(COALESCE(puntos_disponibles, 0)), 0)::int AS puntos_disponibles_totales
          FROM cliente_cards
          WHERE visible_en_sucursal = true
        `,
        [scope.targetSucursalId]
      ),
      pool.query(
        `
          SELECT COUNT(*)::int AS total
          FROM public.fidelizacion_canjes fc
          WHERE ($1::int IS NULL OR fc.id_sucursal = $1)
            AND (fc.fecha_creacion AT TIME ZONE '${TEGUCIGALPA_TIMEZONE}')::date =
                (NOW() AT TIME ZONE '${TEGUCIGALPA_TIMEZONE}')::date
        `,
        [scope.targetSucursalId]
      ),
      pool.query(
        `
          SELECT COUNT(*)::int AS total
          FROM public.fidelizacion_canjes fc
          WHERE ($1::int IS NULL OR fc.id_sucursal = $1)
            AND date_trunc('month', fc.fecha_creacion AT TIME ZONE '${TEGUCIGALPA_TIMEZONE}') =
                date_trunc('month', NOW() AT TIME ZONE '${TEGUCIGALPA_TIMEZONE}')
        `,
        [scope.targetSucursalId]
      )
    ]);

    const aggregateRow = aggregateResult.rows[0] || {};

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          sucursal: scope.targetSucursalId,
          configuracion_activa: config
            ? {
                id_configuracion: Number(config.id_configuracion),
                lempiras_por_punto: Number(config.lempiras_por_punto),
                vigente_desde: config.vigente_desde,
                vigente_hasta: config.vigente_hasta
              }
            : null,
          resumen: {
            clientes_con_puntos: Number(aggregateRow.clientes_con_puntos || 0),
            puntos_disponibles_totales: Number(aggregateRow.puntos_disponibles_totales || 0),
            canjes_hoy: Number(canjesHoyResult.rows?.[0]?.total || 0),
            canjes_mes: Number(canjesMesResult.rows?.[0]?.total || 0)
          }
        }
      }
    };
  },

  async listClientes(req) {
    const page = parsePageParam(req.query.page, 1);
    const limit = parseLimitParam(req.query.limit, 20);
    if (!page || !limit) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'page y limit deben ser enteros positivos.'
        })
      };
    }

    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    if (req.query.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal debe ser un entero positivo.'
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: true
    });

    const search = buildLikeSearch(req.query.search || req.query.q);
    const offset = (page - 1) * limit;

    const dataQuery = `
      ${buildClienteBaseSql()}
      SELECT
        cc.id_cliente,
        cc.id_usuario_cliente,
        cc.nombre_usuario,
        cc.nombre_principal,
        cc.correo,
        cc.telefono,
        cc.documento,
        cc.puntos_disponibles,
        cc.puntos_acumulados_total,
        cc.puntos_canjeados_total,
        cc.fecha_ultima_actividad,
        cc.id_sucursal_ultima_actividad,
        cc.nombre_sucursal_ultima_actividad
      ${buildClienteWhereClause({ searchParamRef: '$2' })}
      ORDER BY cc.nombre_principal ASC, cc.id_cliente ASC
      LIMIT $3
      OFFSET $4
    `;

    const countQuery = `
      ${buildClienteBaseSql()}
      SELECT COUNT(*)::int AS total
      ${buildClienteWhereClause({ searchParamRef: '$2' })}
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, [scope.targetSucursalId, search, limit, offset]),
      pool.query(countQuery, [scope.targetSucursalId, search])
    ]);

    return {
      status: 200,
      body: {
        ok: true,
        data: dataResult.rows,
        total: Number(countResult.rows?.[0]?.total || 0),
        page,
        limit
      }
    };
  },

  async detalleCliente(req) {
    const idCliente = parsePositiveInt(req.params.id_cliente);
    if (!idCliente) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_cliente debe ser un entero positivo.'
        })
      };
    }

    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    if (req.query.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal debe ser un entero positivo.'
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: true
    });

    const cliente = await fetchClienteDetalleRow(pool, idCliente, scope.targetSucursalId);
    if (!cliente) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'FIDELIZACION_CLIENTE_NOT_FOUND',
          message: 'Cliente no encontrado.'
        })
      };
    }

    const [canjesResult, movimientosResult] = await Promise.all([
      pool.query(
        `
          SELECT
            fc.id_canje,
            fc.id_sucursal,
            s.nombre_sucursal,
            fc.total_puntos,
            fc.observacion,
            fc.fecha_creacion,
            fc.fecha_entrega,
            ec.codigo AS estado_codigo,
            ec.nombre AS estado_nombre
          FROM public.fidelizacion_canjes fc
          INNER JOIN public.cat_fidelizacion_estados_canje ec
            ON ec.id_estado_canje = fc.id_estado_canje
          LEFT JOIN public.sucursales s
            ON s.id_sucursal = fc.id_sucursal
          WHERE fc.id_cliente = $1
            AND ($2::int IS NULL OR fc.id_sucursal = $2)
          ORDER BY fc.fecha_creacion DESC, fc.id_canje DESC
          LIMIT 5
        `,
        [idCliente, scope.targetSucursalId]
      ),
      pool.query(
        `
          SELECT
            fm.id_movimiento,
            fm.id_sucursal,
            s.nombre_sucursal,
            fm.puntos_delta,
            fm.saldo_anterior,
            fm.saldo_nuevo,
            fm.id_factura,
            fm.id_canje,
            fm.fecha_creacion,
            tm.codigo AS tipo_codigo,
            tm.nombre AS tipo_nombre,
            om.codigo AS origen_codigo,
            om.nombre AS origen_nombre
          FROM public.fidelizacion_movimientos fm
          INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
            ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
          INNER JOIN public.cat_fidelizacion_origenes_movimiento om
            ON om.id_origen_movimiento = fm.id_origen_movimiento
          LEFT JOIN public.sucursales s
            ON s.id_sucursal = fm.id_sucursal
          WHERE fm.id_cliente = $1
            AND ($2::int IS NULL OR fm.id_sucursal = $2)
          ORDER BY fm.fecha_creacion DESC, fm.id_movimiento DESC
          LIMIT 10
        `,
        [idCliente, scope.targetSucursalId]
      )
    ]);

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          cliente,
          resumen: {
            puntos_disponibles: Number(cliente.puntos_disponibles || 0),
            puntos_acumulados_total: Number(cliente.puntos_acumulados_total || 0),
            puntos_canjeados_total: Number(cliente.puntos_canjeados_total || 0)
          },
          ultimos_canjes: canjesResult.rows,
          ultimos_movimientos: movimientosResult.rows
        }
      }
    };
  },

  async movimientosCliente(req) {
    const idCliente = parsePositiveInt(req.params.id_cliente);
    const page = parsePageParam(req.query.page, 1);
    const limit = parseLimitParam(req.query.limit, 20);
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    if (!idCliente || !page || !limit) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_cliente, page y limit deben ser validos.'
        })
      };
    }
    if (req.query.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal debe ser un entero positivo.'
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: true
    });

    const cliente = await fetchClienteDetalleRow(pool, idCliente, scope.targetSucursalId);
    if (!cliente) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'FIDELIZACION_CLIENTE_NOT_FOUND',
          message: 'Cliente no encontrado.'
        })
      };
    }

    const offset = (page - 1) * limit;
    const params = [idCliente, scope.targetSucursalId, limit, offset];
    const dataQuery = `
      SELECT
        fm.id_movimiento,
        fm.id_cliente,
        fm.id_sucursal,
        s.nombre_sucursal,
        fm.puntos_delta,
        fm.saldo_anterior,
        fm.saldo_nuevo,
        fm.id_factura,
        fm.id_pedido,
        fm.id_canje,
        fm.observacion,
        fm.id_usuario_ejecutor,
        ue.nombre_usuario AS usuario_ejecutor,
        fm.fecha_creacion,
        tm.codigo AS tipo_codigo,
        tm.nombre AS tipo_nombre,
        om.codigo AS origen_codigo,
        om.nombre AS origen_nombre
      FROM public.fidelizacion_movimientos fm
      INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
        ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
      INNER JOIN public.cat_fidelizacion_origenes_movimiento om
        ON om.id_origen_movimiento = fm.id_origen_movimiento
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = fm.id_sucursal
      LEFT JOIN public.usuarios ue
        ON ue.id_usuario = fm.id_usuario_ejecutor
      WHERE fm.id_cliente = $1
        AND ($2::int IS NULL OR fm.id_sucursal = $2)
      ORDER BY fm.fecha_creacion DESC, fm.id_movimiento DESC
      LIMIT $3
      OFFSET $4
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM public.fidelizacion_movimientos fm
      WHERE fm.id_cliente = $1
        AND ($2::int IS NULL OR fm.id_sucursal = $2)
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, params),
      pool.query(countQuery, params.slice(0, 2))
    ]);

    return {
      status: 200,
      body: {
        ok: true,
        data: dataResult.rows,
        total: Number(countResult.rows?.[0]?.total || 0),
        page,
        limit
      }
    };
  },

  async canjeablesCliente(req) {
    await assertAllPermissions(req, ['fidelizacion_ver_clientes', 'fidelizacion_canjear_presencial']);

    const idCliente = parsePositiveInt(req.params.id_cliente);
    if (!idCliente) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_cliente debe ser un entero positivo.'
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requireOperationalSucursal: true
    });

    const cliente = await fetchClienteDetalleRow(pool, idCliente, null);
    if (!cliente) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'FIDELIZACION_CLIENTE_NOT_FOUND',
          message: 'Cliente no encontrado.'
        })
      };
    }

    const saldoResult = await pool.query(
      `
        SELECT COALESCE(puntos_disponibles, 0)::int AS puntos_disponibles
        FROM public.fidelizacion_saldos_cliente
        WHERE id_cliente = $1
        LIMIT 1
      `,
      [idCliente]
    );
    const puntosDisponibles = Number(saldoResult.rows?.[0]?.puntos_disponibles || 0);

    const config = await getActiveFidelizacionConfig(pool, scope.targetSucursalId);
    if (!config) {
      return {
        status: 200,
        body: {
          ok: true,
          data: [],
          message: 'La sucursal operativa no tiene una configuracion vigente de fidelizacion.'
        }
      };
    }

    const result = await pool.query(
      `
        SELECT
          fps.id_producto,
          p.nombre_producto,
          p.descripcion_producto,
          p.precio,
          p.id_almacen,
          COALESCE(p.cantidad, 0)::int AS cantidad,
          COALESCE(p.stock_minimo, 0)::int AS stock_minimo,
          fps.puntos_requeridos_override,
          GREATEST(COALESCE(p.cantidad, 0) - COALESCE(p.stock_minimo, 0), 0)::int AS stock_disponible
        FROM public.fidelizacion_productos_canjeables_sucursal fps
        INNER JOIN public.productos p
          ON p.id_producto = fps.id_producto
        INNER JOIN public.almacenes a
          ON a.id_almacen = p.id_almacen
        WHERE fps.id_sucursal = $1
          AND COALESCE(fps.estado, true) = true
          AND COALESCE(p.estado, true) = true
          AND COALESCE(a.estado, true) = true
          AND a.id_sucursal = $1
          AND GREATEST(COALESCE(p.cantidad, 0) - COALESCE(p.stock_minimo, 0), 0) > 0
        ORDER BY p.nombre_producto ASC
      `,
      [scope.targetSucursalId]
    );

    const data = result.rows
      .map((row) => ({
        ...row,
        puntos_requeridos:
          parseNonNegativeInt(row.puntos_requeridos_override) ??
          computeRedemptionPoints(row.precio, config.lempiras_por_punto)
      }))
      .filter((row) => parsePositiveInt(row.puntos_requeridos) && row.puntos_requeridos <= puntosDisponibles)
      .sort((a, b) => {
        if (a.puntos_requeridos !== b.puntos_requeridos) {
          return a.puntos_requeridos - b.puntos_requeridos;
        }
        return String(a.nombre_producto || '').localeCompare(String(b.nombre_producto || ''), 'es', {
          sensitivity: 'base'
        });
      });

    return {
      status: 200,
      body: {
        ok: true,
        data,
        message:
          data.length > 0
            ? undefined
            : 'No hay productos elegibles para canje con el saldo actual del cliente en esta sucursal.',
        saldo_cliente: {
          id_cliente: idCliente,
          puntos_disponibles: puntosDisponibles
        }
      }
    };
  },

  async getConfiguracion(req) {
    await assertAllPermissions(req, [
      'fidelizacion_ver_panel',
      'fidelizacion_configurar_reglas',
      'fidelizacion_gestionar_productos_canjeables'
    ]);

    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    if (req.query.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal debe ser un entero positivo.'
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: false
    });

    const config = await getActiveFidelizacionConfig(pool, scope.targetSucursalId);
    const productos = await getConfiguracionProducts(
      pool,
      scope.targetSucursalId,
      config?.lempiras_por_punto || null
    );

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          id_sucursal: scope.targetSucursalId,
          configuracion: config
            ? {
                id_configuracion: Number(config.id_configuracion),
                lempiras_por_punto: Number(config.lempiras_por_punto),
                vigente_desde: config.vigente_desde,
                vigente_hasta: config.vigente_hasta,
                id_usuario_creador: Number(config.id_usuario_creador)
              }
            : null,
          productos_canjeables: productos
        }
      }
    };
  },

  async saveConfiguracion(req) {
    await assertAllPermissions(req, [
      'fidelizacion_configurar_reglas',
      'fidelizacion_gestionar_productos_canjeables'
    ]);

    if (!isPlainObject(req.body)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Debe enviar un objeto JSON valido.'
        })
      };
    }

    const allowedFields = new Set([
      'id_sucursal',
      'lempiras_por_punto',
      'productos',
      'productos_canjeables'
    ]);
    const unknownFields = unknownFieldsFromPayload(req.body, allowedFields);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const lempirasPorPunto = parsePositiveNumber(req.body.lempiras_por_punto);
    if (!lempirasPorPunto) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'lempiras_por_punto debe ser un numero mayor a 0.'
        })
      };
    }

    const requestedSucursalId = parseNullablePositiveInt(req.body.id_sucursal);
    if (req.body.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal debe ser un entero positivo.'
        })
      };
    }

    const rawItems = Array.isArray(req.body.productos_canjeables)
      ? req.body.productos_canjeables
      : Array.isArray(req.body.productos)
      ? req.body.productos
      : [];

    const productsMap = new Map();
    for (const item of rawItems) {
      if (!isPlainObject(item)) {
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'Cada producto canjeable debe ser un objeto valido.'
          })
        };
      }

      const itemUnknownFields = unknownFieldsFromPayload(
        item,
        new Set(['id_producto', 'puntos_requeridos_override'])
      );
      if (itemUnknownFields.length) {
        return {
          status: 400,
          body: buildErrorBody({
            code: 'UNKNOWN_FIELDS',
            message: 'Uno o mas productos contienen campos no permitidos.',
            details: { fields: itemUnknownFields }
          })
        };
      }

      const idProducto = parsePositiveInt(item.id_producto);
      if (!idProducto) {
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'Cada producto canjeable debe incluir id_producto valido.'
          })
        };
      }

      let puntosOverride = null;
      if (item.puntos_requeridos_override !== undefined && item.puntos_requeridos_override !== null && item.puntos_requeridos_override !== '') {
        puntosOverride = parsePositiveInt(item.puntos_requeridos_override);
        if (!puntosOverride) {
          return {
            status: 400,
            body: buildErrorBody({
              code: 'VALIDATION_ERROR',
              message: 'puntos_requeridos_override debe ser un entero mayor a 0.'
            })
          };
        }
      }

      productsMap.set(idProducto, {
        id_producto: idProducto,
        puntos_requeridos_override: puntosOverride
      });
    }

    const client = await pool.connect();
    try {
      const scope = await resolveFidelizacionScope({
        req,
        client,
        requestedSucursalId,
        allowAllBranches: false
      });

      const productIds = [...productsMap.keys()];
      if (productIds.length > 0) {
        const productsResult = await client.query(
          `
            SELECT
              p.id_producto,
              p.nombre_producto,
              COALESCE(p.estado, true) AS estado,
              p.id_almacen,
              a.id_sucursal AS id_sucursal_almacen,
              COALESCE(a.estado, true) AS almacen_estado
            FROM public.productos p
            LEFT JOIN public.almacenes a
              ON a.id_almacen = p.id_almacen
            WHERE p.id_producto = ANY($1::int[])
          `,
          [productIds]
        );
        const existingMap = new Map(productsResult.rows.map((row) => [Number(row.id_producto), row]));

        for (const idProducto of productIds) {
          const row = existingMap.get(idProducto);
          if (!row || !Boolean(row.estado)) {
            throw createFidelizacionError(
              404,
              'FIDELIZACION_PRODUCT_NOT_FOUND',
              'Uno o mas productos seleccionados no estan disponibles.'
            );
          }
          if (!row.id_almacen || !Boolean(row.almacen_estado) || Number(row.id_sucursal_almacen || 0) !== scope.targetSucursalId) {
            throw createFidelizacionError(
              409,
              'FIDELIZACION_PRODUCT_SCOPE_ERROR',
              'Uno o mas productos no pertenecen al inventario operativo de la sucursal.'
            );
          }
        }
      }

      await client.query('BEGIN');
      await client.query('LOCK TABLE public.fidelizacion_configuracion_sucursal IN EXCLUSIVE MODE');

      const previousConfig = await getActiveFidelizacionConfig(client, scope.targetSucursalId);
      await client.query(
        `
          UPDATE public.fidelizacion_configuracion_sucursal
          SET
            estado = false,
            vigente_hasta = NOW(),
            fecha_actualizacion = NOW()
          WHERE id_sucursal = $1
            AND COALESCE(estado, true) = true
            AND (vigente_hasta IS NULL OR vigente_hasta > NOW())
        `,
        [scope.targetSucursalId]
      );

      const configInsertResult = await client.query(
        `
          INSERT INTO public.fidelizacion_configuracion_sucursal (
            id_sucursal,
            lempiras_por_punto,
            vigente_desde,
            vigente_hasta,
            estado,
            id_usuario_creador,
            fecha_creacion,
            fecha_actualizacion
          )
          VALUES ($1, $2, NOW(), NULL, true, $3, NOW(), NOW())
          RETURNING id_configuracion
        `,
        [scope.targetSucursalId, lempirasPorPunto, scope.idUsuario]
      );
      const idConfiguracion = Number(configInsertResult.rows?.[0]?.id_configuracion || 0);

      await client.query('LOCK TABLE public.fidelizacion_productos_canjeables_sucursal IN EXCLUSIVE MODE');
      const existingConfigsResult = await client.query(
        `
          SELECT id_registro, id_producto
          FROM public.fidelizacion_productos_canjeables_sucursal
          WHERE id_sucursal = $1
          FOR UPDATE
        `,
        [scope.targetSucursalId]
      );
      const existingConfigsMap = new Map(
        existingConfigsResult.rows.map((row) => [Number(row.id_producto), Number(row.id_registro)])
      );

      for (const [idProducto, item] of productsMap.entries()) {
        const existingId = existingConfigsMap.get(idProducto);
        if (existingId) {
          await client.query(
            `
              UPDATE public.fidelizacion_productos_canjeables_sucursal
              SET
                puntos_requeridos_override = $1,
                estado = true,
                fecha_actualizacion = NOW()
              WHERE id_registro = $2
            `,
            [item.puntos_requeridos_override, existingId]
          );
          continue;
        }

        await client.query(
          `
            INSERT INTO public.fidelizacion_productos_canjeables_sucursal (
              id_sucursal,
              id_producto,
              puntos_requeridos_override,
              estado,
              id_usuario_creador,
              fecha_creacion,
              fecha_actualizacion
            )
            VALUES ($1, $2, $3, true, $4, NOW(), NOW())
          `,
          [
            scope.targetSucursalId,
            idProducto,
            item.puntos_requeridos_override,
            scope.idUsuario
          ]
        );
      }

      const idsToDeactivate = [...existingConfigsMap.entries()]
        .filter(([idProducto]) => !productsMap.has(idProducto))
        .map(([, idRegistro]) => idRegistro);

      if (idsToDeactivate.length > 0) {
        await client.query(
          `
            UPDATE public.fidelizacion_productos_canjeables_sucursal
            SET
              estado = false,
              fecha_actualizacion = NOW()
            WHERE id_registro = ANY($1::int[])
          `,
          [idsToDeactivate]
        );
      }

      await insertFidelizacionAuditLog({
        client,
        req,
        idUsuario: scope.idUsuario,
        accion: 'FIDELIZACION_CONFIG_GUARDAR',
        descripcion: `Configuracion de fidelizacion actualizada para sucursal ${scope.targetSucursalId}`,
        idRegistro: idConfiguracion,
        datosAntes: previousConfig
          ? {
              id_configuracion: Number(previousConfig.id_configuracion),
              lempiras_por_punto: Number(previousConfig.lempiras_por_punto)
            }
          : null,
        datosDespues: {
          id_sucursal: scope.targetSucursalId,
          lempiras_por_punto: lempirasPorPunto,
          productos_canjeables: [...productsMap.values()]
        }
      });

      await client.query('COMMIT');

      return {
        status: 200,
        body: {
          ok: true,
          message: 'Configuracion de fidelizacion guardada correctamente.',
          data: {
            id_sucursal: scope.targetSucursalId,
            lempiras_por_punto: lempirasPorPunto,
            total_productos_canjeables: productsMap.size
          }
        }
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // no-op
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async createCanje(req) {
    if (!isPlainObject(req.body)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Debe enviar un objeto JSON valido.'
        })
      };
    }

    const allowedFields = new Set(['id_cliente', 'items', 'observacion']);
    const unknownFields = unknownFieldsFromPayload(req.body, allowedFields);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idCliente = parsePositiveInt(req.body.id_cliente);
    if (!idCliente) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_cliente debe ser un entero positivo.'
        })
      };
    }

    const client = await pool.connect();
    try {
      const scope = await resolveFidelizacionScope({
        req,
        client,
        requireOperationalSucursal: true
      });

      await client.query('BEGIN');

      const result = await createPresentialFidelizacionCanje({
        client,
        req,
        idCliente,
        idSucursal: scope.targetSucursalId,
        idUsuarioEjecutor: scope.idUsuario,
        items: req.body.items,
        observacion: req.body.observacion
      });

      await client.query('COMMIT');

      return {
        status: 201,
        body: {
          ok: true,
          message: 'Canje registrado correctamente.',
          data: {
            id_canje: result.idCanje,
            total_puntos: result.totalPuntos,
            saldo_anterior: result.saldoAnterior,
            saldo_nuevo: result.saldoNuevo,
            id_sucursal: scope.targetSucursalId,
            items: result.items
          }
        }
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // no-op
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async listCanjes(req) {
    const page = parsePageParam(req.query.page, 1);
    const limit = parseLimitParam(req.query.limit, 20);
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const idCliente = parseNullablePositiveInt(req.query.id_cliente);
    const idEstadoCanje = parseNullablePositiveInt(req.query.id_estado_canje);
    const desde = parseOptionalDateOnly(req.query.desde);
    const hasta = parseOptionalDateOnly(req.query.hasta);

    if (!page || !limit) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'page y limit deben ser enteros positivos.'
        })
      };
    }
    if (req.query.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_sucursal debe ser valido.' })
      };
    }
    if (req.query.id_cliente !== undefined && !idCliente) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_cliente debe ser valido.' })
      };
    }
    if (req.query.id_estado_canje !== undefined && !idEstadoCanje) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_estado_canje debe ser valido.' })
      };
    }
    if ((req.query.desde !== undefined && !desde) || (req.query.hasta !== undefined && !hasta)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Las fechas deben tener formato YYYY-MM-DD.'
        })
      };
    }
    if (desde && hasta && desde > hasta) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'desde no puede ser mayor que hasta.'
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: true
    });
    const offset = (page - 1) * limit;

    const params = [
      scope.targetSucursalId,
      idCliente,
      idEstadoCanje,
      desde,
      hasta,
      limit,
      offset
    ];

    const dataQuery = `
      SELECT
        fc.id_canje,
        fc.id_cliente,
        fc.id_sucursal,
        s.nombre_sucursal,
        fc.id_estado_canje,
        ec.codigo AS estado_codigo,
        ec.nombre AS estado_nombre,
        fc.total_puntos,
        fc.observacion,
        fc.id_usuario_ejecutor,
        ue.nombre_usuario AS usuario_ejecutor,
        fc.fecha_creacion,
        fc.fecha_entrega,
        fc.fecha_anulacion,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''),
          NULLIF(TRIM(e.nombre_empresa), ''),
          CONCAT('Cliente #', fc.id_cliente::text)
        ) AS cliente_nombre
      FROM public.fidelizacion_canjes fc
      INNER JOIN public.cat_fidelizacion_estados_canje ec
        ON ec.id_estado_canje = fc.id_estado_canje
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = fc.id_sucursal
      LEFT JOIN public.usuarios ue
        ON ue.id_usuario = fc.id_usuario_ejecutor
      LEFT JOIN public.clientes c
        ON c.id_cliente = fc.id_cliente
      LEFT JOIN public.personas p
        ON p.id_persona = c.id_persona
      LEFT JOIN public.empresas e
        ON e.id_empresa = c.id_empresa
      WHERE ($1::int IS NULL OR fc.id_sucursal = $1)
        AND ($2::int IS NULL OR fc.id_cliente = $2)
        AND ($3::int IS NULL OR fc.id_estado_canje = $3)
        AND ($4::date IS NULL OR fc.fecha_creacion::date >= $4)
        AND ($5::date IS NULL OR fc.fecha_creacion::date <= $5)
      ORDER BY fc.fecha_creacion DESC, fc.id_canje DESC
      LIMIT $6
      OFFSET $7
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM public.fidelizacion_canjes fc
      WHERE ($1::int IS NULL OR fc.id_sucursal = $1)
        AND ($2::int IS NULL OR fc.id_cliente = $2)
        AND ($3::int IS NULL OR fc.id_estado_canje = $3)
        AND ($4::date IS NULL OR fc.fecha_creacion::date >= $4)
        AND ($5::date IS NULL OR fc.fecha_creacion::date <= $5)
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, params),
      pool.query(countQuery, params.slice(0, 5))
    ]);

    return {
      status: 200,
      body: {
        ok: true,
        data: dataResult.rows,
        total: Number(countResult.rows?.[0]?.total || 0),
        page,
        limit
      }
    };
  },

  async detalleCanje(req) {
    const idCanje = parsePositiveInt(req.params.id_canje);
    if (!idCanje) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_canje debe ser un entero positivo.'
        })
      };
    }

    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    if (req.query.id_sucursal !== undefined && !requestedSucursalId) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_sucursal debe ser valido.' })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: true
    });

    const headerResult = await pool.query(
      `
        SELECT
          fc.id_canje,
          fc.id_cliente,
          fc.id_sucursal,
          s.nombre_sucursal,
          fc.id_estado_canje,
          ec.codigo AS estado_codigo,
          ec.nombre AS estado_nombre,
          fc.total_puntos,
          fc.observacion,
          fc.id_usuario_ejecutor,
          ue.nombre_usuario AS usuario_ejecutor,
          fc.fecha_creacion,
          fc.fecha_entrega,
          fc.fecha_anulacion,
          COALESCE(
            NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''),
            NULLIF(TRIM(e.nombre_empresa), ''),
            CONCAT('Cliente #', fc.id_cliente::text)
          ) AS cliente_nombre
        FROM public.fidelizacion_canjes fc
        INNER JOIN public.cat_fidelizacion_estados_canje ec
          ON ec.id_estado_canje = fc.id_estado_canje
        LEFT JOIN public.sucursales s
          ON s.id_sucursal = fc.id_sucursal
        LEFT JOIN public.usuarios ue
          ON ue.id_usuario = fc.id_usuario_ejecutor
        LEFT JOIN public.clientes c
          ON c.id_cliente = fc.id_cliente
        LEFT JOIN public.personas p
          ON p.id_persona = c.id_persona
        LEFT JOIN public.empresas e
          ON e.id_empresa = c.id_empresa
        WHERE fc.id_canje = $1
          AND ($2::int IS NULL OR fc.id_sucursal = $2)
        LIMIT 1
      `,
      [idCanje, scope.targetSucursalId]
    );

    if (headerResult.rowCount === 0) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'FIDELIZACION_CANJE_NOT_FOUND',
          message: 'Canje no encontrado.'
        })
      };
    }

    const detailResult = await pool.query(
      `
        SELECT
          fcd.id_detalle_canje,
          fcd.id_producto,
          p.nombre_producto,
          fcd.cantidad,
          fcd.puntos_unitarios,
          fcd.subtotal_puntos,
          fcd.precio_referencia,
          fcd.fecha_creacion
        FROM public.fidelizacion_canjes_detalle fcd
        INNER JOIN public.productos p
          ON p.id_producto = fcd.id_producto
        WHERE fcd.id_canje = $1
        ORDER BY p.nombre_producto ASC, fcd.id_detalle_canje ASC
      `,
      [idCanje]
    );

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          ...headerResult.rows[0],
          items: detailResult.rows
        }
      }
    };
  }
};

router.get(
  '/fidelizacion/panel',
  checkPermission(['fidelizacion_ver_panel']),
  asyncHandler(fidelizacionService.panel, {
    defaultCode: 'FIDELIZACION_PANEL_ERROR',
    defaultMessage: 'No se pudo obtener el panel de fidelizacion.'
  })
);

router.get(
  '/fidelizacion/clientes',
  checkPermission(['fidelizacion_ver_clientes']),
  asyncHandler(fidelizacionService.listClientes, {
    defaultCode: 'FIDELIZACION_CLIENTES_LIST_ERROR',
    defaultMessage: 'No se pudo obtener el listado de clientes de fidelizacion.'
  })
);

router.get(
  '/fidelizacion/clientes/:id_cliente',
  checkPermission(['fidelizacion_ver_clientes']),
  asyncHandler(fidelizacionService.detalleCliente, {
    defaultCode: 'FIDELIZACION_CLIENTE_DETAIL_ERROR',
    defaultMessage: 'No se pudo obtener el detalle del cliente.'
  })
);

router.get(
  '/fidelizacion/clientes/:id_cliente/movimientos',
  checkPermission(['fidelizacion_ver_movimientos']),
  asyncHandler(fidelizacionService.movimientosCliente, {
    defaultCode: 'FIDELIZACION_MOVIMIENTOS_LIST_ERROR',
    defaultMessage: 'No se pudo obtener el historial de movimientos.'
  })
);

router.get(
  '/fidelizacion/clientes/:id_cliente/canjeables',
  checkPermission(['fidelizacion_ver_clientes', 'fidelizacion_canjear_presencial']),
  asyncHandler(fidelizacionService.canjeablesCliente, {
    defaultCode: 'FIDELIZACION_CANJEABLES_LIST_ERROR',
    defaultMessage: 'No se pudo obtener el catalogo de productos canjeables.'
  })
);

router.get(
  '/fidelizacion/configuracion',
  checkPermission([
    'fidelizacion_ver_panel',
    'fidelizacion_configurar_reglas',
    'fidelizacion_gestionar_productos_canjeables'
  ]),
  asyncHandler(fidelizacionService.getConfiguracion, {
    defaultCode: 'FIDELIZACION_CONFIG_GET_ERROR',
    defaultMessage: 'No se pudo obtener la configuracion de fidelizacion.'
  })
);

router.put(
  '/fidelizacion/configuracion',
  checkPermission(['fidelizacion_configurar_reglas', 'fidelizacion_gestionar_productos_canjeables']),
  asyncHandler(fidelizacionService.saveConfiguracion, {
    defaultCode: 'FIDELIZACION_CONFIG_SAVE_ERROR',
    defaultMessage: 'No se pudo guardar la configuracion de fidelizacion.'
  })
);

router.post(
  '/fidelizacion/canjes',
  checkPermission(['fidelizacion_canjear_presencial']),
  asyncHandler(fidelizacionService.createCanje, {
    defaultCode: 'FIDELIZACION_CANJE_CREATE_ERROR',
    defaultMessage: 'No se pudo registrar el canje de fidelizacion.'
  })
);

router.get(
  '/fidelizacion/canjes',
  checkPermission(['fidelizacion_ver_canjes']),
  asyncHandler(fidelizacionService.listCanjes, {
    defaultCode: 'FIDELIZACION_CANJES_LIST_ERROR',
    defaultMessage: 'No se pudo obtener el listado de canjes.'
  })
);

router.get(
  '/fidelizacion/canjes/:id_canje',
  checkPermission(['fidelizacion_ver_canjes']),
  asyncHandler(fidelizacionService.detalleCanje, {
    defaultCode: 'FIDELIZACION_CANJE_DETAIL_ERROR',
    defaultMessage: 'No se pudo obtener el detalle del canje.'
  })
);

export default router;
