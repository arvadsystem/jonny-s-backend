import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import { attachImagenPrincipalUrls } from '../utils/uploads.js';
import {
  buildErrorBody,
  isValidDateOnly,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  unknownFieldsFromPayload
} from '../utils/security/personasHardening.js';
import {
  buildClienteEmpresaRelationSql,
  computeRedemptionPoints,
  createFidelizacionError,
  createPresentialFidelizacionCanje,
  getActiveFidelizacionConfig,
  insertFidelizacionAuditLog,
  normalizeText,
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber,
  resolveEffectiveAcumulacionHabilitada,
  resolveEffectiveLempirasPorPunto,
  resolveFidelizacionProductAssignments
} from '../services/fidelizacionService.js';

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 120;
const DEFAULT_CLIENTES_PAGE_SIZE = 9;
const MULTISUCURSAL_PERMISSION = 'fidelizacion_ver_multisucursal';
const TEGUCIGALPA_TIMEZONE = 'America/Tegucigalpa';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// page/limit deben llegar como enteros positivos "puros": Number.parseInt
// trunca decimales y se detiene en el primer caracter no numerico (p.ej.
// "1 OR 1=1" -> 1, "9;DROP TABLE clientes" -> 9), asi que aceptaria payloads
// maliciosos como validos. Este regex exige que TODO el valor sean digitos
// antes de pasarlo a parsePositiveInt.
const STRICT_POSITIVE_INTEGER_PATTERN = /^\d+$/;

const isStrictPositiveIntegerString = (value) => {
  // Un arreglo de un solo elemento (p.ej. id_sucursal[]=1, que Express/qs
  // entrega como ['1']) o un objeto (id_sucursal[valor]=1 -> {valor:'1'})
  // nunca son un identificador valido, pero String(['1']) === '1' pasaria
  // el regex si no se rechazan explicitamente antes de convertir a texto.
  if (value !== null && typeof value === 'object') return false;
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  return STRICT_POSITIVE_INTEGER_PATTERN.test(String(value ?? '').trim());
};

const parsePageParam = (value, fallback = 1) => {
  if (value === undefined) return fallback;
  if (!isStrictPositiveIntegerString(value)) return null;
  return parsePositiveInt(value);
};

const parseLimitParam = (value, fallback = 20) => {
  if (value === undefined) return fallback;
  if (!isStrictPositiveIntegerString(value)) return null;
  const parsed = parsePositiveInt(value);
  if (!parsed) return null;
  return Math.min(parsed, MAX_PAGE_SIZE);
};

// Usado para todo identificador entero opcional que llega en la peticion
// (id_sucursal, id_cliente, id_estado_canje; en query o en body): mismo
// contrato en los 10 puntos donde se usa este helper, por eso se endurece
// aqui en vez de duplicar un parser paralelo especifico. Number.parseInt
// (dentro de parsePositiveInt) trunca decimales y se detiene en el primer
// caracter no numerico ("1 OR 1=1" -> 1), asi que exige primero que el
// valor completo sean digitos antes de parsearlo.
const parseNullablePositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (!isStrictPositiveIntegerString(value)) return null;
  return parsePositiveInt(value);
};

const parseOptionalDateOnly = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim();
  return isValidDateOnly(normalized) ? normalized : null;
};

// % y _ son comodines de ILIKE aunque el valor viaje parametrizado ($n): un
// parametro evita SQL injection pero no evita que el usuario use un
// comodin arbitrario. Se escapan junto con la propia barra invertida (que
// es el caracter de escape) para que %, _ y \ se busquen como texto literal.
const escapeLikePattern = (value) => String(value).replace(/[\\%_]/g, (character) => `\\${character}`);

const buildLikeSearch = (value) => {
  const normalized = normalizeText(value);
  return normalized ? `%${escapeLikePattern(normalized)}%` : null;
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
  requireOperationalSucursal = false,
  requireExplicitSucursalForSuperAdmin = false
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
  } else if (requireExplicitSucursalForSuperAdmin && Boolean(scope?.isSuperAdmin)) {
    // El superadministrador no tiene una sucursal "propia" para el canje:
    // debe elegirla explicitamente en cada solicitud (nunca se usa
    // userSucursalId en silencio, aunque el usuario tenga una asignada).
    throw createFidelizacionError(
      400,
      'FIDELIZACION_SUCURSAL_REQUIRED',
      'Debe seleccionar la sucursal donde se realizara el canje.'
    );
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

// empresaRelationExpr: fragmento SQL resuelto por buildClienteEmpresaRelationSql
// (services/fidelizacionService.js) -- misma deteccion dinamica de
// clientes.id_empresa_cliente vs clientes.id_empresa que ya usa
// fetchClienteProfileForFidelizacion y listPaidInvoicesMissingAccumulation.
// No se duplica una tercera implementacion incompatible de esa relacion.
const buildClienteBaseSql = (empresaRelationExpr = 'c.id_empresa') => `
  WITH cliente_cards AS (
    SELECT
      c.id_cliente,
      u.id_usuario AS id_usuario_cliente,
      u.nombre_usuario,
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
    LEFT JOIN public.personas p
      ON p.id_persona = c.id_persona
    LEFT JOIN public.empresas e
      ON e.id_empresa = ${empresaRelationExpr}
    LEFT JOIN public.telefonos tel_p
      ON tel_p.id_telefono = p.id_telefono
    LEFT JOIN public.telefonos tel_e
      ON tel_e.id_telefono = e.id_telefono
    LEFT JOIN public.correos cor_p
      ON cor_p.id_correo = p.id_correo
    LEFT JOIN public.correos cor_e
      ON cor_e.id_correo = e.id_correo
    -- Datos de usuario opcionales (LEFT JOIN): un cliente puede acumular y
    -- aparecer en el panel sin tener cuenta de usuario ni rol CLIENTE
    -- (misma regla de perfil que la acumulacion, ver mas abajo).
    LEFT JOIN public.usuarios_clientes uc
      ON uc.id_cliente = c.id_cliente
     AND COALESCE(uc.estado, true) = true
    LEFT JOIN public.usuarios u
      ON u.id_usuario = uc.id_usuario
     AND u.id_cliente = uc.id_cliente
     AND COALESCE(u.estado, false) = true
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
    -- Misma regla de elegibilidad por perfil que usa la acumulacion
    -- (isClienteProfileComplete / fetchClienteProfileForFidelizacion en
    -- services/fidelizacionService.js): activo, con nombre (persona o
    -- empresa) y telefono con exactamente 8 digitos (criterio canonico de
    -- normalizePhoneHN). No se exige usuario, rol CLIENTE, correo, apellido
    -- ni credenciales de acceso.
    WHERE COALESCE(c.estado, true) = true
      -- Mismo criterio EXACTO que isClienteProfileComplete/fetchClienteProfileForFidelizacion
      -- (services/fidelizacionService.js): solo p.nombre, nunca CONCAT con
      -- apellido. Una persona sin nombre pero con apellido no debe pasar
      -- este filtro (el apellido si se sigue mostrando en nombre_principal,
      -- eso es solo visual).
      AND TRIM(COALESCE(
        CASE WHEN c.id_persona IS NOT NULL THEN p.nombre ELSE e.nombre_empresa END,
        ''
      )) <> ''
      AND length(regexp_replace(
        COALESCE(
          CASE WHEN c.id_persona IS NOT NULL THEN tel_p.telefono ELSE tel_e.telefono END,
          ''
        ),
        '\\D', '', 'g'
      )) = 8
  )
`;

// Sin busqueda: solo clientes con participacion real (acumulados o
// disponibles > 0), para no listar clientes en cero por defecto. Con
// busqueda: el filtro de puntos se desactiva por completo (para poder
// encontrar un cliente aunque tenga 0 en las tres columnas), y en su lugar
// debe coincidir con alguna columna permitida. searchParamRef es siempre una
// constante interna ($2), nunca un valor recibido de req.query.
const buildClienteWhereClause = ({ searchParamRef }) => `
  FROM cliente_cards cc
  WHERE cc.visible_en_sucursal = true
    AND (
      ${searchParamRef}::text IS NOT NULL
      OR COALESCE(cc.puntos_acumulados_total, 0) > 0
      OR COALESCE(cc.puntos_disponibles, 0) > 0
    )
    AND (
      ${searchParamRef}::text IS NULL
      OR cc.nombre_principal ILIKE ${searchParamRef} ESCAPE '\\'
      OR cc.correo ILIKE ${searchParamRef} ESCAPE '\\'
      OR cc.telefono ILIKE ${searchParamRef} ESCAPE '\\'
      OR cc.documento ILIKE ${searchParamRef} ESCAPE '\\'
      OR cc.nombre_usuario ILIKE ${searchParamRef} ESCAPE '\\'
      OR cc.id_cliente::text ILIKE ${searchParamRef} ESCAPE '\\'
    )
`;

const fetchClienteDetalleRow = async (client, idCliente, targetSucursalId = null) => {
  const empresaRelationExpr = await buildClienteEmpresaRelationSql(client, 'c');
  const result = await client.query(
    `
      ${buildClienteBaseSql(empresaRelationExpr)}
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

// Datos maestros (nombre/descripcion/precio/imagen) siempre vienen de
// productos: un producto configurado como canjeable debe seguir apareciendo
// en el listado administrativo aunque su asignacion local en esta sucursal
// se haya vuelto invalida (para que el admin pueda verlo y corregirlo), asi
// que el fetch de fps+productos NUNCA depende de resolveFidelizacionProductAssignments
// para existir -- solo se usa para completar stock/almacen local cuando hay
// una asignacion resoluble.
const getConfiguracionProducts = async (client, req, idSucursal, lempirasPorPunto = null) => {
  const sucursalId = parsePositiveInt(idSucursal);
  if (!sucursalId) return [];

  const fpsResult = await client.query(
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
        COALESCE(p.descripcion_producto, '') AS descripcion_producto,
        p.precio,
        p.id_archivo_imagen_principal,
        COALESCE(p.estado, true) AS producto_estado
      FROM public.fidelizacion_productos_canjeables_sucursal fps
      INNER JOIN public.productos p
        ON p.id_producto = fps.id_producto
      WHERE fps.id_sucursal = $1
      ORDER BY COALESCE(fps.estado, true) DESC, p.nombre_producto ASC, fps.id_registro ASC
    `,
    [sucursalId]
  );

  const assignments = await resolveFidelizacionProductAssignments({
    client,
    idSucursal: sucursalId,
    productIds: fpsResult.rows.map((row) => row.id_producto),
    lockForUpdate: false
  });

  const merged = fpsResult.rows.map((row) => {
    const assignment = assignments.get(Number(row.id_producto));
    const resolved = assignment?.status === 'OK';
    const cantidad = resolved ? assignment.cantidad : 0;
    const stockMinimo = resolved ? assignment.stock_minimo : 0;

    return {
      ...row,
      asignacion_local_estado: assignment?.status || 'SIN_ASIGNACION',
      id_almacen: resolved ? assignment.id_almacen : null,
      nombre_almacen: resolved ? assignment.nombre_almacen : null,
      cantidad,
      stock_minimo: stockMinimo,
      stock_disponible: Math.max(cantidad - stockMinimo, 0),
      puntos_requeridos_efectivos:
        parseNonNegativeInt(row.puntos_requeridos_override) ??
        computeRedemptionPoints(row.precio, lempirasPorPunto)
    };
  });

  return attachImagenPrincipalUrls(pool, req, merged);
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

    const empresaRelationExpr = await buildClienteEmpresaRelationSql(pool, 'c');

    const [config, aggregateResult, canjesHoyResult, canjesMesResult] = await Promise.all([
      scope.targetSucursalId ? getActiveFidelizacionConfig(pool, scope.targetSucursalId) : null,
      pool.query(
        `
          ${buildClienteBaseSql(empresaRelationExpr)}
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
    const limit = parseLimitParam(req.query.limit, DEFAULT_CLIENTES_PAGE_SIZE);
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

    const rawSearchInput = req.query.search !== undefined ? req.query.search : req.query.q;
    if (rawSearchInput !== undefined && normalizeText(rawSearchInput).length > MAX_SEARCH_LENGTH) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: `search no debe exceder ${MAX_SEARCH_LENGTH} caracteres.`
        })
      };
    }

    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      allowAllBranches: true
    });

    const search = buildLikeSearch(rawSearchInput);
    const offset = (page - 1) * limit;
    const empresaRelationExpr = await buildClienteEmpresaRelationSql(pool, 'c');

    const dataQuery = `
      ${buildClienteBaseSql(empresaRelationExpr)}
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
      ${buildClienteBaseSql(empresaRelationExpr)}
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

    // No superadmin: siempre su sucursal operativa autenticada (nunca un
    // id_sucursal arbitrario del navegador salvo que este dentro de su
    // alcance multisucursal ya autorizado, ver resolveFidelizacionScope).
    // Superadmin: debe elegir la sucursal explicitamente en cada solicitud
    // (requireExplicitSucursalForSuperAdmin) -- responde
    // FIDELIZACION_SUCURSAL_REQUIRED si no la envia.
    const scope = await resolveFidelizacionScope({
      req,
      client: pool,
      requestedSucursalId,
      requireOperationalSucursal: true,
      requireExplicitSucursalForSuperAdmin: true
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

    // Datos maestros (nombre/descripcion/precio/imagen) desde productos; el
    // stock/almacen local se resuelve aparte via
    // resolveFidelizacionProductAssignments (producto maestro + sucursal
    // operativa -> productos_almacenes), nunca con productos.id_almacen.
    const canjeablesResult = await pool.query(
      `
        SELECT
          fps.id_producto,
          p.nombre_producto,
          COALESCE(p.descripcion_producto, '') AS descripcion_producto,
          p.precio,
          p.id_archivo_imagen_principal,
          fps.puntos_requeridos_override
        FROM public.fidelizacion_productos_canjeables_sucursal fps
        INNER JOIN public.productos p
          ON p.id_producto = fps.id_producto
        WHERE fps.id_sucursal = $1
          AND COALESCE(fps.estado, true) = true
          AND COALESCE(p.estado, true) = true
        ORDER BY p.nombre_producto ASC
      `,
      [scope.targetSucursalId]
    );

    const assignments = await resolveFidelizacionProductAssignments({
      client: pool,
      idSucursal: scope.targetSucursalId,
      productIds: canjeablesResult.rows.map((row) => row.id_producto),
      lockForUpdate: false
    });

    const merged = canjeablesResult.rows
      .map((row) => {
        const assignment = assignments.get(Number(row.id_producto));
        if (assignment?.status !== 'OK') return null;
        if (assignment.stock_disponible <= 0) return null;

        return {
          id_producto: row.id_producto,
          nombre_producto: row.nombre_producto,
          descripcion_producto: row.descripcion_producto,
          id_archivo_imagen_principal: row.id_archivo_imagen_principal,
          precio: row.precio,
          id_sucursal: assignment.id_sucursal,
          id_almacen: assignment.id_almacen,
          nombre_almacen: assignment.nombre_almacen,
          cantidad: assignment.cantidad,
          stock_minimo: assignment.stock_minimo,
          stock_disponible: assignment.stock_disponible,
          puntos_requeridos_override: row.puntos_requeridos_override
        };
      })
      .filter((row) => row !== null);

    const withImagenes = await attachImagenPrincipalUrls(pool, req, merged);

    const data = withImagenes
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
      req,
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
                acumulacion_habilitada: Boolean(config.acumulacion_habilitada),
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
      'acumulacion_habilitada',
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

    // Booleano estricto: "true" (string) u otros tipos se rechazan. Si se
    // omite, el valor efectivo se resuelve mas abajo (tras leer la
    // configuracion previa dentro de la transaccion): conserva el valor
    // anterior si existe, y solo cae a false para la primera configuracion
    // de la sucursal (ver resolveEffectiveAcumulacionHabilitada).
    if (
      req.body.acumulacion_habilitada !== undefined &&
      typeof req.body.acumulacion_habilitada !== 'boolean'
    ) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'acumulacion_habilitada debe ser un booleano.'
        })
      };
    }
    const acumulacionHabilitadaProvided = req.body.acumulacion_habilitada !== undefined;
    const acumulacionHabilitadaInput = acumulacionHabilitadaProvided ? req.body.acumulacion_habilitada : null;

    // lempiras_por_punto tambien se usa para calcular canjes, asi que debe
    // seguir siendo > 0 en TODA configuracion guardada, sin importar el
    // switch. Si el payload trae el campo pero es invalido (0, negativo,
    // NaN, no numerico) se rechaza siempre, aunque el switch este apagado:
    // ya no se ignora en silencio. Si lo omite, se resuelve mas abajo
    // (conserva la tasa anterior o exige una nueva si es la primera
    // configuracion; ver resolveEffectiveLempirasPorPunto).
    const lempirasPorPuntoProvided = req.body.lempiras_por_punto !== undefined;
    const lempirasPorPuntoInput = parsePositiveNumber(req.body.lempiras_por_punto);
    if (lempirasPorPuntoProvided && !lempirasPorPuntoInput) {
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
            SELECT p.id_producto, p.nombre_producto, COALESCE(p.estado, true) AS estado
            FROM public.productos p
            WHERE p.id_producto = ANY($1::int[])
          `,
          [productIds]
        );
        const existingMap = new Map(productsResult.rows.map((row) => [Number(row.id_producto), row]));

        // Un producto maestro puede estar asignado a varias sucursales via
        // productos_almacenes: se valida la asignacion activa en la
        // sucursal solicitada, nunca con productos.id_almacen (legado, un
        // solo almacen por producto).
        const assignments = await resolveFidelizacionProductAssignments({
          client,
          idSucursal: scope.targetSucursalId,
          productIds,
          lockForUpdate: false
        });

        for (const idProducto of productIds) {
          const row = existingMap.get(idProducto);
          if (!row || !Boolean(row.estado)) {
            throw createFidelizacionError(
              404,
              'FIDELIZACION_PRODUCT_NOT_FOUND',
              'Uno o mas productos seleccionados no estan disponibles.'
            );
          }

          const assignment = assignments.get(idProducto);
          if (assignment?.status === 'AMBIGUA') {
            throw createFidelizacionError(
              409,
              'FIDELIZACION_PRODUCTO_ASIGNACION_AMBIGUA',
              `El producto ${row.nombre_producto || idProducto} tiene mas de una asignacion activa en esta sucursal.`
            );
          }
          if (assignment?.status !== 'OK') {
            throw createFidelizacionError(
              409,
              'FIDELIZACION_PRODUCTO_SIN_ASIGNACION',
              `El producto ${row.nombre_producto || idProducto} no tiene una asignacion de inventario activa en esta sucursal.`
            );
          }
        }
      }

      await client.query('BEGIN');
      await client.query('LOCK TABLE public.fidelizacion_configuracion_sucursal IN EXCLUSIVE MODE');

      const previousConfig = await getActiveFidelizacionConfig(client, scope.targetSucursalId);

      // Switch: booleano explicito del payload, o se conserva el de la
      // configuracion previa; solo cae a false si es la primera
      // configuracion de la sucursal.
      const acumulacionHabilitada = resolveEffectiveAcumulacionHabilitada({
        inputProvided: acumulacionHabilitadaProvided,
        inputValue: acumulacionHabilitadaInput,
        previousConfig
      });

      // Tasa: numero explicito del payload, o se conserva la tasa anterior
      // (nunca se pisa con 0). La primera configuracion de una sucursal
      // exige una tasa > 0 sin importar el switch: tambien la usa el canje.
      const lempirasResolution = resolveEffectiveLempirasPorPunto({
        inputProvided: lempirasPorPuntoProvided,
        inputValue: lempirasPorPuntoInput,
        previousConfig
      });
      if (!lempirasResolution.ok) {
        throw createFidelizacionError(
          400,
          'VALIDATION_ERROR',
          'lempiras_por_punto debe ser un numero mayor a 0 para la primera configuracion de la sucursal.'
        );
      }
      const lempirasPorPunto = lempirasResolution.value;

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
            acumulacion_habilitada,
            vigente_desde,
            vigente_hasta,
            estado,
            id_usuario_creador,
            fecha_creacion,
            fecha_actualizacion
          )
          VALUES ($1, $2, $3, NOW(), NULL, true, $4, NOW(), NOW())
          RETURNING id_configuracion
        `,
        [scope.targetSucursalId, lempirasPorPunto, acumulacionHabilitada, scope.idUsuario]
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
              lempiras_por_punto: Number(previousConfig.lempiras_por_punto),
              acumulacion_habilitada: Boolean(previousConfig.acumulacion_habilitada)
            }
          : null,
        datosDespues: {
          id_sucursal: scope.targetSucursalId,
          lempiras_por_punto: lempirasPorPunto,
          acumulacion_habilitada: acumulacionHabilitada,
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
            acumulacion_habilitada: acumulacionHabilitada,
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

    const allowedFields = new Set(['id_cliente', 'id_sucursal', 'items', 'observacion']);
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

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // No superadmin: sucursal operativa autenticada (id_sucursal enviado
      // solo se admite si esta dentro de su alcance ya autorizado). Superadmin:
      // debe enviar id_sucursal explicitamente (FIDELIZACION_SUCURSAL_REQUIRED
      // si falta) -- nunca se usa su userSucursalId en silencio.
      const scope = await resolveFidelizacionScope({
        req,
        client,
        requestedSucursalId,
        requireOperationalSucursal: true,
        requireExplicitSucursalForSuperAdmin: true
      });

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

// Estos helpers puros se exportan solo para pruebas (verificar la SQL real
// generada y la validacion/escape de listClientes sin depender de una base
// de datos).
export {
  fidelizacionService,
  buildClienteBaseSql,
  buildClienteWhereClause,
  escapeLikePattern,
  buildLikeSearch,
  parsePageParam,
  parseLimitParam,
  parseNullablePositiveInt,
  resolveFidelizacionScope,
  MAX_SEARCH_LENGTH,
  MAX_PAGE_SIZE,
  DEFAULT_CLIENTES_PAGE_SIZE
};
export default router;
