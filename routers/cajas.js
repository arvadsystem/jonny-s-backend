import express from 'express';
import pool from '../config/db-connection.js';
import {
  checkPermission,
  requestHasAnyPermission,
  requestHasAnyRole
} from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const router = express.Router();
const CAJAS_SCOPE_PERMISSION = 'VENTAS_CAJAS_MULTISUCURSAL_VER';
const ADMIN_ROLE_CODES = ['ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN'];

const CATALOGS = Object.freeze({
  SESSION_STATES: { table: 'public.cat_cajas_sesiones_estados', id: 'id_estado_sesion_caja' },
  PARTICIPATION_ROLES: { table: 'public.cat_cajas_roles_participacion', id: 'id_rol_participacion_caja' },
  MOVEMENT_TYPES: { table: 'public.cat_cajas_movimientos_tipos', id: 'id_tipo_movimiento_caja' },
  RESOLUTIONS: { table: 'public.cat_cajas_resoluciones_cierre', id: 'id_resolucion_cierre_caja' },
  ARQUEO_TYPES: { table: 'public.cat_cajas_arqueos_tipos', id: 'id_tipo_arqueo_caja' },
  INCIDENT_TYPES: { table: 'public.cat_cajas_incidencias_tipos', id: 'id_tipo_incidencia_caja' },
  INCIDENT_STATES: { table: 'public.cat_cajas_incidencias_estados', id: 'id_estado_incidencia_caja' }
});

const USER_DISPLAY_SQL = `
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
    u.nombre_usuario
  )
`;
const ROLE_NORMALIZED_SQL = `UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g'))`;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseNullablePositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parsePositiveInt(value);
};

const parseNonNegativeAmount = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
};

const parseNullableNonNegativeAmount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parseNonNegativeAmount(value);
};

const normalizeText = (value, maxLength = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const parseBooleanish = (value) =>
  value === true || value === 'true' || value === 1 || value === '1';

const parseBooleanWithDefault = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  return parseBooleanish(value);
};

const normalizeCajaCode = (value, maxLength = 40) => {
  const normalized = normalizeText(value, maxLength);
  if (!normalized) return null;
  return normalized.toUpperCase();
};

const createCajaError = (httpStatus, code, publicMessage) => {
  const error = new Error(publicMessage);
  error.httpStatus = httpStatus;
  error.code = code;
  error.publicMessage = publicMessage;
  return error;
};

const sendInternalError = (
  res,
  err,
  defaultCode = 'VENTAS_CAJAS_INTERNAL_ERROR',
  defaultMessage = 'No se pudo procesar la solicitud de Gestion de cajas.'
) => {
  console.error('[cajas]', err);

  if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 500) {
    return res.status(err.httpStatus).json({
      error: true,
      code: err.code || defaultCode,
      message: err.publicMessage || defaultMessage
    });
  }

  return res.status(500).json({
    error: true,
    code: defaultCode,
    message: defaultMessage
  });
};

const getCatalogId = async (client, catalogKey, code) => {
  const catalog = CATALOGS[catalogKey];
  if (!catalog) {
    throw createCajaError(500, 'VENTAS_CAJAS_CATALOG_CONFIG_ERROR', 'No se pudo procesar la solicitud de Gestion de cajas.');
  }

  const result = await client.query(
    `SELECT ${catalog.id} AS id FROM ${catalog.table} WHERE UPPER(TRIM(codigo)) = UPPER($1) LIMIT 1`,
    [code]
  );

  return Number(result.rows?.[0]?.id || 0) || null;
};

const getCatalogCodeById = async (client, catalogKey, id) => {
  const catalog = CATALOGS[catalogKey];
  const safeId = parsePositiveInt(id);
  if (!catalog || !safeId) return null;
  const result = await client.query(
    `SELECT UPPER(TRIM(codigo)) AS codigo FROM ${catalog.table} WHERE ${catalog.id} = $1 LIMIT 1`,
    [safeId]
  );
  return String(result.rows?.[0]?.codigo || '').trim().toUpperCase() || null;
};

const ALLOWED_NEW_ARQUEO_CODES = new Set(['CIERRE', 'EXTRAORDINARIO']);

const getScopeContext = async (req, client, requestedSucursalId = null, allowGlobal = false) => {
  const scope = await resolveRequestUserSucursalScope(req, client);
  const idUsuario = parsePositiveInt(scope.idUsuario);
  if (!idUsuario) {
    throw createCajaError(401, 'VENTAS_CAJAS_UNAUTHORIZED', 'No autorizado.');
  }

  const userSucursalId = parsePositiveInt(scope.userSucursalId);
  const allowedSucursalIds = Array.isArray(scope.allowedSucursalIds)
    ? scope.allowedSucursalIds.map((value) => parsePositiveInt(value)).filter((value) => value !== null)
    : [];
  const hasMultisucursalAccess =
    Boolean(scope.isSuperAdmin) || (await requestHasAnyPermission(req, CAJAS_SCOPE_PERMISSION));

  let targetSucursalId = null;
  if (requestedSucursalId) {
    if (!scope.isSuperAdmin && !allowedSucursalIds.includes(requestedSucursalId)) {
      throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_FORBIDDEN', 'No tiene acceso a la sucursal solicitada.');
    }
    if (!scope.isSuperAdmin && requestedSucursalId !== userSucursalId && !hasMultisucursalAccess) {
      throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_FORBIDDEN', 'No tiene acceso a la sucursal solicitada.');
    }
    targetSucursalId = requestedSucursalId;
  } else if (allowGlobal && scope.isSuperAdmin && hasMultisucursalAccess) {
    targetSucursalId = null;
  } else if (userSucursalId) {
    targetSucursalId = userSucursalId;
  } else if (!scope.isSuperAdmin && allowedSucursalIds.length === 1) {
    targetSucursalId = allowedSucursalIds[0];
  } else if (!scope.isSuperAdmin) {
    throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'No se pudo resolver la sucursal operativa del usuario.');
  }

  return {
    idUsuario,
    isSuperAdmin: Boolean(scope.isSuperAdmin),
    userSucursalId,
    allowedSucursalIds,
    hasMultisucursalAccess,
    targetSucursalId
  };
};

const assertSucursalAllowed = (scopeContext, idSucursal) => {
  const target = parsePositiveInt(idSucursal);
  if (!target) {
    throw createCajaError(409, 'VENTAS_CAJAS_SCOPE_INVALID', 'No se pudo determinar la sucursal operativa.');
  }
  if (scopeContext.isSuperAdmin) return;
  if (!scopeContext.allowedSucursalIds.includes(target)) {
    throw createCajaError(403, 'VENTAS_CAJAS_SCOPE_FORBIDDEN', 'No tiene acceso a la sucursal solicitada.');
  }
};

const ensureAdminOrSuperAdmin = async (req) => {
  const isAllowed = await requestHasAnyRole(req, ADMIN_ROLE_CODES);
  if (!isAllowed) {
    throw createCajaError(403, 'VENTAS_CAJAS_ROLE_FORBIDDEN', 'Accion exclusiva para ADMIN o SUPER_ADMIN.');
  }
};

const ensureActiveAssignmentBusinessRules = async (
  client,
  {
    idCaja,
    idUsuario,
    idSucursal,
    puedeResponsable,
    targetRoleCodes = [],
    actorIsSuperAdmin = false,
    estado = true,
    excludeAssignmentId = null
  }
) => {
  if (!parseBooleanish(estado)) return;
  const normalizedTargetRoleCodes = new Set(
    (Array.isArray(targetRoleCodes) ? targetRoleCodes : [])
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  );
  const targetIsSuperAdmin = normalizedTargetRoleCodes.has('SUPER_ADMIN');

  if (!(actorIsSuperAdmin && targetIsSuperAdmin)) {
    const userConflictResult = await client.query(
      `
        SELECT
          cua.id_caja_usuario_autorizado,
          cua.id_caja,
          c.codigo_caja,
          c.nombre_caja,
          s.id_sucursal,
          s.nombre_sucursal
        FROM public.cajas_usuarios_autorizados cua
        INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        WHERE cua.id_usuario = $1
          AND cua.id_caja <> $2
          AND COALESCE(cua.estado, true) = true
          AND COALESCE(c.estado, true) = true
          AND ($3::int IS NULL OR cua.id_caja_usuario_autorizado <> $3)
        LIMIT 1
        FOR UPDATE
      `,
      [idUsuario, idCaja, excludeAssignmentId]
    );
    if (userConflictResult.rowCount > 0) {
      const conflict = userConflictResult.rows[0] || {};
      const codigoCaja = normalizeText(conflict.codigo_caja, 80);
      const nombreCaja = normalizeText(conflict.nombre_caja, 120);
      const nombreSucursal = normalizeText(conflict.nombre_sucursal, 120);
      const cajaLabel = [nombreCaja, codigoCaja ? `(${codigoCaja})` : null].filter(Boolean).join(' ');
      const ubicacionLabel = nombreSucursal ? ` en ${nombreSucursal}` : '';
      throw createCajaError(
        409,
        'VENTAS_CAJAS_ASSIGN_USER_ACTIVE_DUPLICATE',
        `El usuario ya tiene otra caja activa asignada${cajaLabel ? `: ${cajaLabel}` : ''}${ubicacionLabel}.`
      );
    }
  }

  if (!parseBooleanish(puedeResponsable)) return;

  const responsibleConflictResult = await client.query(
    `
      SELECT cua.id_caja_usuario_autorizado
      FROM public.cajas_usuarios_autorizados cua
      INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
      WHERE cua.id_caja = $1
        AND COALESCE(cua.estado, true) = true
        AND COALESCE(cua.puede_responsable, false) = true
        AND COALESCE(c.estado, true) = true
        AND e.id_sucursal = $2
        AND ($3::int IS NULL OR cua.id_caja_usuario_autorizado <> $3)
      LIMIT 1
      FOR UPDATE
    `,
    [idCaja, idSucursal, excludeAssignmentId]
  );
  if (responsibleConflictResult.rowCount > 0) {
    throw createCajaError(
      409,
      'VENTAS_CAJAS_ASSIGN_RESPONSABLE_DUPLICATE',
      'La caja ya tiene un responsable activo asignado.'
    );
  }
};

const fetchAssignableCajaUserById = async (client, idUsuario) => {
  const result = await client.query(
    `
      SELECT u.id_usuario, u.nombre_usuario, e.id_empleado, e.id_sucursal,
             COALESCE(
               NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
               u.nombre_usuario
             ) AS nombre_completo,
             ARRAY_AGG(DISTINCT ${ROLE_NORMALIZED_SQL}) AS roles_normalizados
      FROM public.usuarios u
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
      INNER JOIN public.roles r ON r.id_rol = ru.id_rol
      LEFT JOIN public.personas per ON per.id_persona = e.id_persona
      WHERE u.id_usuario = $1
        AND COALESCE(u.estado, true) = true
        AND COALESCE(e.estado, true) = true
      GROUP BY u.id_usuario, u.nombre_usuario, e.id_empleado, e.id_sucursal, per.nombre, per.apellido
      LIMIT 1
     `,
    [idUsuario]
  );
  const user = result.rows[0] || null;
  if (!user) return null;
  const roleCodes = Array.isArray(user.roles_normalizados)
    ? user.roles_normalizados.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
    : [];
  return {
    ...user,
    roles_normalizados: roleCodes
  };
};

const normalizeRoleCodes = (roleCodes) =>
  (Array.isArray(roleCodes) ? roleCodes : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);

const hasAnyRoleCode = (roleCodes, candidates) => {
  const normalizedRoles = new Set(normalizeRoleCodes(roleCodes));
  return (Array.isArray(candidates) ? candidates : []).some((candidate) =>
    normalizedRoles.has(String(candidate || '').trim().toUpperCase())
  );
};

const isCajaUserCajero = (roleCodes) => hasAnyRoleCode(roleCodes, ['CAJERO']);

const isCajaUserAdminLike = (roleCodes) =>
  hasAnyRoleCode(roleCodes, ['SUPER_ADMIN', 'ADMIN', 'ADMINISTRADOR']);

const requestIsSuperAdminReal = async (client, req) => {
  const idUsuario = parsePositiveInt(req?.user?.id_usuario);
  if (!idUsuario) return false;
  const result = await client.query(
    `
      SELECT 1
      FROM public.roles_usuarios ru
      INNER JOIN public.roles r ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = $1
        AND ${ROLE_NORMALIZED_SQL} = 'SUPER_ADMIN'
      LIMIT 1
    `,
    [idUsuario]
  );
  return result.rowCount > 0;
};

const findDetallePlanillaByUsuarioAndMonth = async ({
  client,
  idUsuario,
  idSucursal,
  fechaReferencia
}) => {
  const result = await client.query(
    `
      SELECT dp.id_detalle_planilla, dp.id_planilla
      FROM public.usuarios u
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      INNER JOIN public.detalle_planilla dp ON dp.id_empleado = e.id_empleado
      INNER JOIN public.planillas p ON p.id_planilla = dp.id_planilla
      WHERE u.id_usuario = $1
        AND p.id_sucursal = $2
        AND date_trunc('month', p.fecha_creacion) = date_trunc('month', $3::timestamp)
      ORDER BY p.fecha_creacion DESC, p.id_planilla DESC, dp.id_detalle_planilla DESC
      LIMIT 1
    `,
    [idUsuario, idSucursal, fechaReferencia]
  );
  return result.rows[0] || null;
};

const syncPayrollDeductionForClose = async ({
  client,
  idCierreCaja,
  idUsuarioResponsable,
  idSucursal,
  fechaCierre,
  diferencia,
  resolucionCodigo
}) => {
  const normalizedResolution = String(resolucionCodigo || '').trim().toUpperCase();
  const absDiferencia = Number(Math.abs(Number(diferencia || 0)).toFixed(2));

  const mappingResult = await client.query(
    `
      SELECT id_cierre_planilla_movimiento, id_movimiento_planilla, activo
      FROM public.cajas_cierres_planilla_movimientos
      WHERE id_cierre_caja = $1
      LIMIT 1
      FOR UPDATE
    `,
    [idCierreCaja]
  );
  const existing = mappingResult.rows[0] || null;

  const shouldApplyDeduction =
    normalizedResolution === 'DESCUENTO_EMPLEADO' && absDiferencia > 0;

  if (!shouldApplyDeduction) {
    if (existing?.id_movimiento_planilla) {
      await client.query(
        `
          UPDATE public.movimiento_planilla
          SET estado = false
          WHERE id_movimiento_planilla = $1
        `,
        [existing.id_movimiento_planilla]
      );
      await client.query(
        `
          UPDATE public.cajas_cierres_planilla_movimientos
          SET activo = false, fecha_actualizacion = NOW()
          WHERE id_cierre_planilla_movimiento = $1
        `,
        [existing.id_cierre_planilla_movimiento]
      );
    }
    return { synced: true, reason: 'NOT_REQUIRED' };
  }

  const detallePlanilla = await findDetallePlanillaByUsuarioAndMonth({
    client,
    idUsuario: idUsuarioResponsable,
    idSucursal,
    fechaReferencia: fechaCierre
  });

  if (!detallePlanilla?.id_detalle_planilla) {
    return { synced: false, reason: 'PLANILLA_DETAIL_NOT_FOUND' };
  }

  const concepto = `Descuento cierre caja #${idCierreCaja}`;
  const observacion = `Deduccion automatica por diferencia de cierre de caja.`;
  let idMovimientoPlanilla = parsePositiveInt(existing?.id_movimiento_planilla);

  if (idMovimientoPlanilla) {
    await client.query(
      `
        UPDATE public.movimiento_planilla
        SET tipo_movimiento = 'DEDUCCION',
            concepto = $1,
            monto = $2,
            observacion = $3,
            estado = true,
            fecha_registro = NOW()
        WHERE id_movimiento_planilla = $4
      `,
      [concepto, absDiferencia, observacion, idMovimientoPlanilla]
    );
  } else {
    const insertMovimiento = await client.query(
      `
        INSERT INTO public.movimiento_planilla (
          id_detalle_planilla, tipo_movimiento, concepto, monto, observacion, fecha_registro, estado
        )
        VALUES ($1, 'DEDUCCION', $2, $3, $4, NOW(), true)
        RETURNING id_movimiento_planilla
      `,
      [detallePlanilla.id_detalle_planilla, concepto, absDiferencia, observacion]
    );
    idMovimientoPlanilla = parsePositiveInt(insertMovimiento.rows?.[0]?.id_movimiento_planilla);
  }

  if (!idMovimientoPlanilla) {
    return { synced: false, reason: 'PLANILLA_MOVEMENT_NOT_CREATED' };
  }

  await client.query(
    `SELECT public.fn_recalcular_detalle_planilla($1)`,
    [detallePlanilla.id_detalle_planilla]
  );

  if (existing?.id_cierre_planilla_movimiento) {
    await client.query(
      `
        UPDATE public.cajas_cierres_planilla_movimientos
        SET id_movimiento_planilla = $1,
            id_planilla = $2,
            activo = true,
            fecha_actualizacion = NOW()
        WHERE id_cierre_planilla_movimiento = $3
      `,
      [idMovimientoPlanilla, detallePlanilla.id_planilla, existing.id_cierre_planilla_movimiento]
    );
  } else {
    await client.query(
      `
        INSERT INTO public.cajas_cierres_planilla_movimientos (
          id_cierre_caja, id_movimiento_planilla, id_planilla, activo, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1, $2, $3, true, NOW(), NOW())
      `,
      [idCierreCaja, idMovimientoPlanilla, detallePlanilla.id_planilla]
    );
  }

  return { synced: true, reason: 'UPDATED', id_movimiento_planilla: idMovimientoPlanilla };
};

const userBelongsToSucursal = async (client, idUsuario, idSucursal) => {
  const targetSucursal = parsePositiveInt(idSucursal);
  if (!targetSucursal) return false;

  const allowedIds = new Set();
  const appendRows = (rows) => {
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const parsed = parsePositiveInt(row?.id_sucursal);
      if (parsed) allowedIds.add(parsed);
    });
  };

  const baseResult = await client.query(
    `
      SELECT e.id_sucursal
      FROM public.usuarios u
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      WHERE u.id_usuario = $1
        AND e.id_sucursal IS NOT NULL
    `,
    [idUsuario]
  );
  appendRows(baseResult.rows);

  const optionalQueries = [
    {
      relation: 'public.v_usuarios_sucursales_scope',
      sql: `
        SELECT vus.id_sucursal
        FROM public.v_usuarios_sucursales_scope vus
        WHERE vus.id_usuario = $1
      `
    },
    {
      relation: 'public.empleados_sucursales',
      sql: `
        SELECT es.id_sucursal
        FROM public.usuarios u
        INNER JOIN public.empleados_sucursales es ON es.id_empleado = u.id_empleado
        WHERE u.id_usuario = $1
      `
    },
    {
      relation: 'public.usuarios_sucursales',
      sql: `
        SELECT us.id_sucursal
        FROM public.usuarios_sucursales us
        WHERE us.id_usuario = $1
      `
    }
  ];

  for (const queryDef of optionalQueries) {
    const relationResult = await client.query('SELECT to_regclass($1) AS relation_name', [queryDef.relation]);
    if (!relationResult.rows?.[0]?.relation_name) {
      continue;
    }

    const result = await client.query(queryDef.sql, [idUsuario]);
    appendRows(result.rows);
  }

  return allowedIds.has(targetSucursal);
};

const assertUserBelongsToSucursal = async (client, idUsuario, idSucursal) => {
  const belongs = await userBelongsToSucursal(client, idUsuario, idSucursal);
  if (!belongs) {
    throw createCajaError(
      409,
      'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
      'El usuario seleccionado no pertenece a la sucursal operativa de la caja.'
    );
  }
};

const upsertCajaAuthorization = async (
  client,
  {
    idCaja,
    idSucursal,
    idUsuario,
    puedeResponsable = true,
    puedeAuxiliar = true,
    observacion = null
  }
) => {
  const normalizedObservacion = normalizeText(observacion, 300);
  const activeResult = await client.query(
    `
      SELECT id_caja_usuario_autorizado
      FROM public.cajas_usuarios_autorizados
      WHERE id_caja = $1
        AND id_usuario = $2
        AND COALESCE(estado, true) = true
      LIMIT 1
      FOR UPDATE
    `,
    [idCaja, idUsuario]
  );

  const excludedAssignmentId = Number(activeResult.rows?.[0]?.id_caja_usuario_autorizado || 0) || null;
  await ensureActiveAssignmentBusinessRules(client, {
    idCaja,
    idUsuario,
    idSucursal,
    puedeResponsable,
    estado: true,
    excludeAssignmentId: excludedAssignmentId
  });

  if (activeResult.rowCount > 0) {
    const idAsignacion = Number(activeResult.rows[0].id_caja_usuario_autorizado);
    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET id_sucursal = $1,
            puede_responsable = $2,
            puede_auxiliar = $3,
            observacion = $4,
            fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $5
      `,
      [idSucursal, Boolean(puedeResponsable), Boolean(puedeAuxiliar), normalizedObservacion, idAsignacion]
    );
    return idAsignacion;
  }

  const inactiveResult = await client.query(
    `
      SELECT id_caja_usuario_autorizado
      FROM public.cajas_usuarios_autorizados
      WHERE id_caja = $1
        AND id_usuario = $2
        AND COALESCE(estado, true) = false
      ORDER BY id_caja_usuario_autorizado DESC
      LIMIT 1
      FOR UPDATE
    `,
    [idCaja, idUsuario]
  );

  if (inactiveResult.rowCount > 0) {
    const idAsignacion = Number(inactiveResult.rows[0].id_caja_usuario_autorizado);
    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET id_sucursal = $1,
            puede_responsable = $2,
            puede_auxiliar = $3,
            estado = true,
            observacion = $4,
            fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $5
      `,
      [idSucursal, Boolean(puedeResponsable), Boolean(puedeAuxiliar), normalizedObservacion, idAsignacion]
    );
    return idAsignacion;
  }

  const insertResult = await client.query(
    `
      INSERT INTO public.cajas_usuarios_autorizados (
        id_caja,
        id_sucursal,
        id_usuario,
        puede_responsable,
        puede_auxiliar,
        estado,
        observacion,
        fecha_creacion,
        fecha_actualizacion
      )
      VALUES ($1, $2, $3, $4, $5, true, $6, NOW(), NOW())
      RETURNING id_caja_usuario_autorizado
    `,
    [
      idCaja,
      idSucursal,
      idUsuario,
      Boolean(puedeResponsable),
      Boolean(puedeAuxiliar),
      normalizedObservacion
    ]
  );

  return Number(insertResult.rows?.[0]?.id_caja_usuario_autorizado || 0) || null;
};

const fetchCajaDefaultResponsible = async (client, idCaja, idSucursal) => {
  const result = await client.query(
    `
      SELECT cua.id_usuario
      FROM public.cajas_usuarios_autorizados cua
      INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
      INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
      WHERE cua.id_caja = $1
        AND cua.id_sucursal = $2
        AND COALESCE(cua.estado, true) = true
        AND COALESCE(cua.puede_responsable, false) = true
        AND COALESCE(u.estado, true) = true
        AND COALESCE(e.estado, true) = true
      ORDER BY cua.fecha_actualizacion DESC, cua.id_caja_usuario_autorizado DESC
      LIMIT 1
    `,
    [idCaja, idSucursal]
  );
  return Number(result.rows?.[0]?.id_usuario || 0) || null;
};

const fetchCajaById = async (client, idCaja) => {
  const result = await client.query(
    `
      SELECT id_caja, id_sucursal, codigo_caja, nombre_caja, COALESCE(estado, true) AS estado
      FROM public.cajas
      WHERE id_caja = $1
      LIMIT 1
    `,
    [idCaja]
  );
  return result.rows[0] || null;
};

const fetchCajaAuthorization = async (client, idCaja, idUsuario) => {
  const result = await client.query(
    `
      SELECT id_caja_usuario_autorizado, id_sucursal,
             COALESCE(puede_responsable, false) AS puede_responsable,
             COALESCE(puede_auxiliar, false) AS puede_auxiliar
      FROM public.cajas_usuarios_autorizados
      WHERE id_caja = $1
        AND id_usuario = $2
        AND COALESCE(estado, true) = true
      LIMIT 1
    `,
    [idCaja, idUsuario]
  );
  return result.rows[0] || null;
};

const assertCajaAuthorization = async (client, idCaja, idUsuario, roleCode) => {
  const authorization = await fetchCajaAuthorization(client, idCaja, idUsuario);
  if (!authorization) {
    throw createCajaError(403, 'VENTAS_CAJAS_USER_NOT_AUTHORIZED', 'El usuario no esta autorizado para operar esta caja.');
  }
  if (roleCode === 'RESPONSABLE' && !parseBooleanish(authorization.puede_responsable)) {
    throw createCajaError(403, 'VENTAS_CAJAS_RESPONSABLE_FORBIDDEN', 'El usuario no tiene autorizacion como responsable para esta caja.');
  }
  if (roleCode === 'AUXILIAR' && !parseBooleanish(authorization.puede_auxiliar)) {
    throw createCajaError(403, 'VENTAS_CAJAS_AUXILIAR_FORBIDDEN', 'El usuario no tiene autorizacion como auxiliar para esta caja.');
  }
  return authorization;
};

const fetchSessionBase = async (client, idSesionCaja, { forUpdate = false } = {}) => {
  const result = await client.query(
    `
      SELECT cs.*, c.codigo_caja, c.nombre_caja, COALESCE(c.estado, true) AS caja_estado, s.nombre_sucursal,
             estado.codigo AS estado_codigo, estado.nombre AS estado_nombre
      FROM public.cajas_sesiones cs
      INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
      INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
      INNER JOIN public.cat_cajas_sesiones_estados estado ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
      WHERE cs.id_sesion_caja = $1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [idSesionCaja]
  );
  return result.rows[0] || null;
};

const ensureOpenSession = async (client, idSesionCaja, options = {}) => {
  const session = await fetchSessionBase(client, idSesionCaja, options);
  if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  if (!idEstadoAbierta || Number(session.id_estado_sesion_caja) !== Number(idEstadoAbierta)) {
    throw createCajaError(409, 'VENTAS_CAJAS_SESSION_NOT_OPEN', 'La sesion de caja no se encuentra abierta.');
  }
  return session;
};

const ensureSessionParticipant = async (
  client,
  idSesionCaja,
  idUsuario,
  { allowAdminBypass = false, req = null, scopeContext = null } = {}
) => {
  const result = await client.query(
    `
      SELECT csp.id_participacion_caja, csp.id_usuario, crp.codigo AS rol_codigo, cs.id_caja, cs.id_sucursal
      FROM public.cajas_sesiones_participantes csp
      INNER JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = csp.id_sesion_caja
      INNER JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
      WHERE csp.id_sesion_caja = $1
        AND csp.id_usuario = $2
        AND COALESCE(csp.activo, true) = true
      LIMIT 1
    `,
    [idSesionCaja, idUsuario]
  );

  if (result.rowCount > 0) {
    const participant = result.rows[0];
    await assertCajaAuthorization(client, participant.id_caja, idUsuario, participant.rol_codigo);
    if (scopeContext) assertSucursalAllowed(scopeContext, participant.id_sucursal);
    return participant;
  }

  if (allowAdminBypass && req && (await requestHasAnyRole(req, ADMIN_ROLE_CODES))) {
    return null;
  }

  throw createCajaError(403, 'VENTAS_CAJAS_PARTICIPANT_REQUIRED', 'El usuario autenticado no participa activamente en la sesion de caja.');
};

const buildSessionDetailPayload = async (client, session) => {
  const [responsableResult, participantesResult, cobrosResult, arqueosResult, ultimoArqueoCierreResult, movimientosResult, cierreResult, resumenResult] =
    await Promise.all([
      client.query(
        `
          SELECT u.id_usuario, u.nombre_usuario, ${USER_DISPLAY_SQL} AS nombre_completo
          FROM public.usuarios u
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          WHERE u.id_usuario = $1
          LIMIT 1
        `,
        [session.id_usuario_responsable]
      ),
      client.query(
        `
          SELECT csp.*, crp.codigo AS rol_codigo, crp.nombre AS rol_nombre,
                 u.nombre_usuario, ${USER_DISPLAY_SQL} AS nombre_completo
          FROM public.cajas_sesiones_participantes csp
          INNER JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
          INNER JOIN public.usuarios u ON u.id_usuario = csp.id_usuario
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          WHERE csp.id_sesion_caja = $1
          ORDER BY csp.fecha_inicio ASC, csp.id_participacion_caja ASC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT vw.*, u.nombre_usuario, ${USER_DISPLAY_SQL} AS nombre_completo
          FROM public.vw_cajas_sesion_cobros_por_usuario vw
          INNER JOIN public.usuarios u ON u.id_usuario = vw.id_usuario_ejecutor
          LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per ON per.id_persona = e.id_persona
          WHERE vw.id_sesion_caja = $1
          ORDER BY vw.total_cobrado DESC, vw.id_usuario_ejecutor ASC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT a.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre
          FROM public.cajas_arqueos a
          INNER JOIN public.cat_cajas_arqueos_tipos tipo ON tipo.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja
          WHERE a.id_sesion_caja = $1
          ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT a.id_arqueo_caja, a.monto_contado, a.diferencia, a.fecha_arqueo
          FROM public.cajas_arqueos a
          INNER JOIN public.cat_cajas_arqueos_tipos t ON t.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja
          WHERE a.id_sesion_caja = $1
            AND UPPER(TRIM(t.codigo)) = 'CIERRE'
          ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC
          LIMIT 1
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT m.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre
          FROM public.cajas_movimientos m
          INNER JOIN public.cat_cajas_movimientos_tipos tipo ON tipo.id_tipo_movimiento_caja = m.id_tipo_movimiento_caja
          WHERE m.id_sesion_caja = $1
          ORDER BY m.fecha_movimiento DESC, m.id_movimiento_caja DESC
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT cc.*, resolucion.codigo AS resolucion_codigo, resolucion.nombre AS resolucion_nombre
          FROM public.cajas_cierres cc
          LEFT JOIN public.cat_cajas_resoluciones_cierre resolucion ON resolucion.id_resolucion_cierre_caja = cc.id_resolucion_cierre_caja
          WHERE cc.id_sesion_caja = $1
          ORDER BY cc.id_cierre_caja DESC
          LIMIT 1
        `,
        [session.id_sesion_caja]
      ),
      client.query(
        `
          SELECT *
          FROM public.vw_cajas_sesiones_resumen
          WHERE id_sesion_caja = $1
          LIMIT 1
        `,
        [session.id_sesion_caja]
      )
    ]);

  const participantsByUserId = new Map();
  for (const participante of participantesResult.rows) {
    const participantUserId = Number(participante?.id_usuario || 0);
    if (!participantUserId) continue;
    participantsByUserId.set(participantUserId, participante);
  }

  const cobrosPorUsuario = cobrosResult.rows
    .map((row) => {
      const idUsuarioEjecutor = Number(row?.id_usuario_ejecutor || 0);
      if (!idUsuarioEjecutor) return null;

      const participante = participantsByUserId.get(idUsuarioEjecutor) || null;
      const participantRoleCode = String(participante?.rol_codigo || '').trim().toUpperCase();
      const fallbackRoleCode =
        idUsuarioEjecutor === Number(session.id_usuario_responsable) ? 'RESPONSABLE' : 'EJECUTOR';
      const rolParticipacion = participantRoleCode || fallbackRoleCode;
      const esResponsable = rolParticipacion === 'RESPONSABLE';
      const esAuxiliar = rolParticipacion === 'AUXILIAR';

      return {
        ...row,
        id_usuario_ejecutor: idUsuarioEjecutor,
        cobros_registrados: Number(
          row?.cobros_registrados ?? row?.cantidad_cobros ?? row?.total_cobros ?? 0
        ),
        total_cobrado: Number(row?.total_cobrado || 0),
        total_efectivo: Number(row?.total_efectivo || 0),
        total_no_efectivo: Number(row?.total_no_efectivo || 0),
        rol_participacion: rolParticipacion,
        es_responsable: esResponsable,
        es_auxiliar: esAuxiliar
      };
    })
    .filter(Boolean);

  const totalResponsable = cobrosPorUsuario
    .filter((row) => row.es_responsable)
    .reduce((sum, row) => sum + Number(row.total_cobrado || 0), 0);
  const totalAuxiliares = cobrosPorUsuario
    .filter((row) => row.es_auxiliar || !row.es_responsable)
    .reduce((sum, row) => sum + Number(row.total_cobrado || 0), 0);

  return {
    sesion: session,
    responsable: responsableResult.rows[0] || null,
    participantes: participantesResult.rows,
    cobros_por_usuario: cobrosPorUsuario,
    resumen_operativo: {
      ...(resumenResult.rows[0] || {}),
      total_responsable: Number(totalResponsable.toFixed(2)),
      total_auxiliares: Number(totalAuxiliares.toFixed(2)),
      responsabilidad_final_id_usuario: Number(session.id_usuario_responsable),
      ultimo_arqueo_cierre: ultimoArqueoCierreResult.rows?.[0] || null
    },
    arqueos: arqueosResult.rows,
    movimientos: movimientosResult.rows,
    incidencias: [],
    cierre: cierreResult.rows[0] || null
  };
};

router.get('/ventas/cajas/sesion-activa', checkPermission(['VENTAS_CAJAS_MODULO_VER', 'VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const scopeContext = await getScopeContext(req, pool);
    const idEstadoAbierta = await getCatalogId(pool, 'SESSION_STATES', 'ABIERTA');
    const result = await pool.query(
      `
        SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.fecha_apertura, cs.monto_apertura,
               cs.id_usuario_responsable, c.codigo_caja, c.nombre_caja, s.nombre_sucursal, crp.codigo AS rol_codigo
        FROM public.cajas_sesiones cs
        INNER JOIN public.cajas_sesiones_participantes csp ON csp.id_sesion_caja = cs.id_sesion_caja
          AND csp.id_usuario = $1 AND COALESCE(csp.activo, true) = true
        INNER JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
        INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
        WHERE cs.id_estado_sesion_caja = $2
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
        LIMIT 1
      `,
      [scopeContext.idUsuario, idEstadoAbierta]
    );

    if (result.rowCount === 0) return res.status(200).json({ activa: false, session: null });
    assertSucursalAllowed(scopeContext, result.rows[0].id_sucursal);
    return res.status(200).json({ activa: true, session: result.rows[0] });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_ACTIVE_SESSION_ERROR', 'No se pudo obtener la sesion activa de caja.');
  }
});

router.get('/ventas/cajas/catalogos', checkPermission(['VENTAS_CAJAS_MODULO_VER', 'VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);

    const cajasParams = [];
    const cajasFilters = ['COALESCE(c.estado, true) = true'];
    if (scopeContext.targetSucursalId) {
      cajasParams.push(scopeContext.targetSucursalId);
      cajasFilters.push(`c.id_sucursal = $${cajasParams.length}`);
    } else if (!scopeContext.isSuperAdmin) {
      cajasParams.push(scopeContext.allowedSucursalIds);
      cajasFilters.push(`c.id_sucursal = ANY($${cajasParams.length}::int[])`);
    }

    const [cajas, estados, roles, movimientos, metodosPago, resoluciones, tiposArqueo] =
      await Promise.all([
        pool.query(`SELECT id_caja, id_sucursal, codigo_caja, nombre_caja, estado FROM public.cajas c WHERE ${cajasFilters.join(' AND ')} ORDER BY c.id_sucursal ASC, c.nombre_caja ASC`, cajasParams),
        pool.query(`SELECT * FROM public.cat_cajas_sesiones_estados WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_roles_participacion WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_movimientos_tipos WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_metodos_pago WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_resoluciones_cierre WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`
          SELECT *
          FROM public.cat_cajas_arqueos_tipos
          WHERE COALESCE(estado, true) = true
            AND UPPER(TRIM(codigo)) IN ('CIERRE', 'EXTRAORDINARIO')
          ORDER BY nombre ASC
        `)
      ]);

    return res.status(200).json({
      cajas: cajas.rows,
      estados_sesion: estados.rows,
      roles_participacion: roles.rows,
      tipos_movimiento: movimientos.rows,
      metodos_pago: metodosPago.rows,
      resoluciones_cierre: resoluciones.rows,
      tipos_arqueo: tiposArqueo.rows
    });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOGS_ERROR', 'No se pudieron obtener los catalogos de Gestion de cajas.');
  }
});

router.get('/ventas/cajas/usuarios', checkPermission(['VENTAS_CAJAS_LISTADO_VER', 'VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const targetSucursalId = parsePositiveInt(scopeContext.targetSucursalId || requestedSucursalId);

    if (!targetSucursalId) {
      throw createCajaError(400, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'Debe indicar una sucursal para listar usuarios.');
    }
    assertSucursalAllowed(scopeContext, targetSucursalId);

    const rolOperativo = String(req.query.rol_operativo || '').trim().toUpperCase();
    if (!['RESPONSABLE', 'AUXILIAR'].includes(rolOperativo)) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_ROLE_OPERATIVO_INVALID',
        'Debe indicar un rol operativo valido: RESPONSABLE o AUXILIAR.'
      );
    }

    const result = await pool.query(
      `
        SELECT u.id_usuario, u.nombre_usuario,
               COALESCE(
                 NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
                 u.nombre_usuario
               ) AS nombre_completo,
               ARRAY_AGG(DISTINCT ${ROLE_NORMALIZED_SQL}) AS roles_normalizados
        FROM public.usuarios u
        INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
        INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
        INNER JOIN public.roles r ON r.id_rol = ru.id_rol
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        WHERE COALESCE(u.estado, true) = true
          AND COALESCE(e.estado, true) = true
          AND (
            (
              $2 = 'AUXILIAR'
              AND EXISTS (
                  SELECT 1
                  FROM public.roles_usuarios ru_super
                  INNER JOIN public.roles r_super ON r_super.id_rol = ru_super.id_rol
                  WHERE ru_super.id_usuario = u.id_usuario
                  AND UPPER(REGEXP_REPLACE(TRIM(r_super.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN'
              )
            )
            OR
            e.id_sucursal = $1
            OR EXISTS (
              SELECT 1
              FROM public.v_usuarios_sucursales_scope vus
              WHERE vus.id_usuario = u.id_usuario
                AND COALESCE(vus.estado, true) = true
                AND vus.id_sucursal = $1
            )
            OR EXISTS (
              SELECT 1
              FROM public.empleados_sucursales es
              WHERE es.id_empleado = u.id_empleado
                AND COALESCE(es.estado, true) = true
                AND es.id_sucursal = $1
            )
            OR EXISTS (
              SELECT 1
              FROM public.usuarios_sucursales us
              WHERE us.id_usuario = u.id_usuario
                AND us.id_sucursal = $1
            )
          )
        GROUP BY u.id_usuario, u.nombre_usuario, per.nombre, per.apellido
        ORDER BY nombre_completo ASC
      `,
      [targetSucursalId, rolOperativo]
    );

    let rows = result.rows;
    if (rolOperativo === 'RESPONSABLE') {
      rows = rows.filter((row) => isCajaUserCajero(row.roles_normalizados));
    }
    return res.status(200).json(rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_USERS_LIST_ERROR', 'No se pudieron listar los usuarios disponibles.');
  }
});

router.get('/ventas/cajas/sesiones-abiertas', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.query.id_sucursal);
    if (!idSucursal) {
      throw createCajaError(400, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'Debe indicar id_sucursal.');
    }
    const scopeContext = await getScopeContext(req, pool, idSucursal, true);
    assertSucursalAllowed(scopeContext, idSucursal);
    if (!(await requestIsSuperAdminReal(pool, req))) {
      throw createCajaError(403, 'VENTAS_CAJAS_ROLE_FORBIDDEN', 'Accion exclusiva para SUPER_ADMIN.');
    }
    const idEstadoAbierta = await getCatalogId(pool, 'SESSION_STATES', 'ABIERTA');
    const result = await pool.query(
      `
        SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.fecha_apertura,
               c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               ${USER_DISPLAY_SQL} AS responsable_nombre
        FROM public.cajas_sesiones cs
        INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
        INNER JOIN public.usuarios u ON u.id_usuario = cs.id_usuario_responsable
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        WHERE cs.id_sucursal = $1
          AND cs.id_estado_sesion_caja = $2
          AND COALESCE(c.estado, true) = true
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
      `,
      [idSucursal, idEstadoAbierta]
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_OPEN_SESSIONS_LIST_ERROR', 'No se pudieron listar las sesiones abiertas.');
  }
});

router.get('/ventas/cajas/listado', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const includeInactive = parseBooleanWithDefault(req.query.incluir_inactivas, false);
    const search = normalizeText(req.query.search, 100)?.toUpperCase() || '';

    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) {
      pushFilter('c.id_sucursal = $IDX', scopeContext.targetSucursalId);
    } else if (!scopeContext.isSuperAdmin) {
      pushFilter('c.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    }

    if (!includeInactive) {
      filters.push('COALESCE(c.estado, true) = true');
    }
    if (search) {
      pushFilter(
        `(UPPER(COALESCE(c.codigo_caja, '')) LIKE '%' || $IDX || '%' OR UPPER(COALESCE(c.nombre_caja, '')) LIKE '%' || $IDX || '%')`,
        search
      );
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT c.id_caja, c.id_sucursal, c.codigo_caja, c.nombre_caja, c.observacion,
               COALESCE(c.permite_auxiliares, true) AS permite_auxiliares,
               COALESCE(c.estado, true) AS estado,
               c.fecha_actualizacion,
               s.nombre_sucursal,
               COALESCE(assign.asignaciones_activas, 0) AS asignaciones_activas,
               COALESCE(assign.responsables_activos, 0) AS responsables_activos,
               COALESCE(assign.auxiliares_activos, 0) AS auxiliares_activos
        FROM public.cajas c
        INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE COALESCE(cua.estado, true) = true) AS asignaciones_activas,
            COUNT(*) FILTER (
              WHERE COALESCE(cua.estado, true) = true
                AND COALESCE(cua.puede_responsable, false) = true
            ) AS responsables_activos,
            COUNT(*) FILTER (
              WHERE COALESCE(cua.estado, true) = true
                AND COALESCE(cua.puede_auxiliar, false) = true
            ) AS auxiliares_activos
          FROM public.cajas_usuarios_autorizados cua
          WHERE cua.id_caja = c.id_caja
        ) assign ON true
        ${whereClause}
        ORDER BY c.id_sucursal ASC, c.nombre_caja ASC, c.id_caja ASC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOG_LIST_ERROR', 'No se pudo listar el catalogo de cajas.');
  }
});

router.get('/ventas/cajas/listado/:id', checkPermission(['VENTAS_CAJAS_LISTADO_VER', 'VENTAS_CAJAS_DETALLE_VER']), async (req, res) => {
  try {
    const idCaja = parsePositiveInt(req.params.id);
    if (!idCaja) throw createCajaError(400, 'VENTAS_CAJAS_CAJA_ID_INVALID', 'El id de caja es invalido.');

    const scopeContext = await getScopeContext(req, pool, null, true);
    const caja = await pool.query(
      `
        SELECT c.id_caja, c.id_sucursal, c.codigo_caja, c.nombre_caja, c.observacion,
               COALESCE(c.permite_auxiliares, true) AS permite_auxiliares,
               COALESCE(c.estado, true) AS estado,
               c.fecha_actualizacion, s.nombre_sucursal
        FROM public.cajas c
        INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        WHERE c.id_caja = $1
        LIMIT 1
      `,
      [idCaja]
    );

    if (caja.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
    }

    const rowCaja = caja.rows[0];
    assertSucursalAllowed(scopeContext, rowCaja.id_sucursal);

    const asignaciones = await pool.query(
      `
        SELECT cua.id_caja_usuario_autorizado, cua.id_caja, cua.id_sucursal, cua.id_usuario,
               COALESCE(cua.puede_responsable, false) AS puede_responsable,
               COALESCE(cua.puede_auxiliar, false) AS puede_auxiliar,
               COALESCE(cua.estado, true) AS estado,
               cua.observacion, cua.fecha_creacion, cua.fecha_actualizacion,
               u.nombre_usuario,
               COALESCE(
                 NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
                 u.nombre_usuario
               ) AS nombre_completo
        FROM public.cajas_usuarios_autorizados cua
        INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        WHERE cua.id_caja = $1
        ORDER BY COALESCE(cua.estado, true) DESC, cua.fecha_actualizacion DESC, cua.id_caja_usuario_autorizado DESC
      `,
      [idCaja]
    );

    return res.status(200).json({ caja: rowCaja, asignaciones: asignaciones.rows });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOG_DETAIL_ERROR', 'No se pudo obtener el detalle de la caja.');
  }
});

router.post('/ventas/cajas/listado', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const requestedSucursalId = parseNullablePositiveInt(req.body.id_sucursal);
    const scopeContext = await getScopeContext(req, client, requestedSucursalId, true);
    const targetSucursalId = parsePositiveInt(scopeContext.targetSucursalId || requestedSucursalId);

    if (!targetSucursalId) {
      throw createCajaError(400, 'VENTAS_CAJAS_SCOPE_REQUIRED', 'Debe indicar la sucursal para crear la caja.');
    }
    assertSucursalAllowed(scopeContext, targetSucursalId);

    const nombreCaja = normalizeText(req.body.nombre_caja, 120);
    const codigoCaja = normalizeCajaCode(req.body.codigo_caja, 40);
    const observacion = normalizeText(req.body.observacion, 300);
    const permiteAuxiliares = parseBooleanWithDefault(req.body.permite_auxiliares, true);

    if (!nombreCaja) {
      throw createCajaError(400, 'VENTAS_CAJAS_NAME_REQUIRED', 'Debe indicar el nombre de la caja.');
    }

    if (codigoCaja) {
      const duplicateCode = await client.query(
        `
          SELECT id_caja
          FROM public.cajas
          WHERE id_sucursal = $1
            AND UPPER(TRIM(COALESCE(codigo_caja, ''))) = $2
          LIMIT 1
          FOR UPDATE
        `,
        [targetSucursalId, codigoCaja]
      );
      if (duplicateCode.rowCount > 0) {
        throw createCajaError(409, 'VENTAS_CAJAS_CODE_DUPLICATE', 'Ya existe una caja con ese codigo en la sucursal seleccionada.');
      }
    }

    const insertCajaResult = await client.query(
      `
        INSERT INTO public.cajas (
          id_sucursal, id_usuario, codigo_caja, nombre_caja, observacion,
          permite_auxiliares, estado, fecha_actualizacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
        RETURNING id_caja
      `,
      [targetSucursalId, scopeContext.idUsuario, codigoCaja, nombreCaja, observacion, permiteAuxiliares]
    );
    const idCaja = Number(insertCajaResult.rows?.[0]?.id_caja || 0) || null;
    if (!idCaja) {
      throw createCajaError(500, 'VENTAS_CAJAS_INSERT_ID_ERROR', 'No se pudo determinar el identificador de la caja creada.');
    }

    const asignacionInicial = req.body.asignacion_inicial && typeof req.body.asignacion_inicial === 'object'
      ? req.body.asignacion_inicial
      : {};
    const idUsuarioAsignado = parseNullablePositiveInt(asignacionInicial.id_usuario);

    let idCajaUsuarioAutorizado = null;
    if (idUsuarioAsignado) {
      const user = await fetchAssignableCajaUserById(client, idUsuarioAsignado);
      if (!user) {
        throw createCajaError(
          404,
          'VENTAS_CAJAS_ASSIGN_USER_NOT_FOUND',
          'El usuario indicado debe ser un empleado activo.'
        );
      }
      if (Number.parseInt(String(user.id_sucursal || ''), 10) !== targetSucursalId) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
          'El usuario seleccionado no pertenece a la sucursal operativa de la caja.'
        );
      }

      const puedeResponsable = parseBooleanWithDefault(asignacionInicial.puede_responsable, true);
      const puedeAuxiliar = parseBooleanWithDefault(asignacionInicial.puede_auxiliar, true);
      if ((puedeResponsable && puedeAuxiliar) || (!puedeResponsable && !puedeAuxiliar)) {
        throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_ROLE_EXCLUSIVE', 'Debe seleccionar solo un rol operativo: responsable o auxiliar.');
      }
      const actorIsSuperAdmin = await requestIsSuperAdminReal(client, req);
      const userRoles = Array.isArray(user.roles_normalizados) ? user.roles_normalizados : [];
      if (puedeResponsable && !isCajaUserCajero(userRoles)) {
        throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
      }
      if (puedeAuxiliar && !actorIsSuperAdmin && isCajaUserAdminLike(userRoles)) {
        throw createCajaError(403, 'VENTAS_CAJAS_ASSIGN_ROLE_FORBIDDEN', 'Solo super_admin puede asignar usuarios administradores como auxiliares.');
      }

      idCajaUsuarioAutorizado = await upsertCajaAuthorization(client, {
        idCaja,
        idSucursal: targetSucursalId,
        idUsuario: idUsuarioAsignado,
        puedeResponsable,
        puedeAuxiliar,
        observacion: asignacionInicial.observacion
      });
    }

    const abrirSesionPayload = req.body.abrir_sesion && typeof req.body.abrir_sesion === 'object'
      ? req.body.abrir_sesion
      : null;
    const shouldOpenSession = parseBooleanWithDefault(
      abrirSesionPayload ? abrirSesionPayload.habilitar : req.body.abrir_sesion,
      false
    );

    let idSesionCaja = null;
    if (shouldOpenSession) {
      const responsableId =
        parseNullablePositiveInt(abrirSesionPayload?.id_usuario_responsable)
        || idUsuarioAsignado
        || scopeContext.idUsuario;
      const montoApertura = parseNonNegativeAmount(abrirSesionPayload?.monto_apertura ?? 0);
      const observacionApertura = normalizeText(abrirSesionPayload?.observacion_apertura, 500);
      if (montoApertura === null) {
        throw createCajaError(400, 'VENTAS_CAJAS_APERTURA_AMOUNT_INVALID', 'monto_apertura debe ser un numero mayor o igual a 0.');
      }

      const responsableUser = await fetchAssignableCajaUserById(client, responsableId);
      if (!responsableUser) {
        throw createCajaError(
          404,
          'VENTAS_CAJAS_RESPONSABLE_NOT_FOUND',
          'El responsable indicado debe ser un empleado activo.'
        );
      }
      if (Number.parseInt(String(responsableUser.id_sucursal || ''), 10) !== targetSucursalId) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
          'El responsable seleccionado no pertenece a la sucursal operativa de la caja.'
        );
      }
      if (!isCajaUserCajero(responsableUser.roles_normalizados)) {
        throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
      }

      await upsertCajaAuthorization(client, {
        idCaja,
        idSucursal: targetSucursalId,
        idUsuario: responsableId,
        puedeResponsable: true,
        puedeAuxiliar: false,
        observacion: 'Asignacion automatica para apertura inicial'
      });

      idSesionCaja = await createOpenSessionTransaction({
        client,
        scopeContext,
        idCaja,
        responsableId,
        montoApertura,
        observacionApertura
      });
    }

    await client.query('COMMIT');
    return res.status(201).json({
      message: shouldOpenSession
        ? 'Caja creada, asignada y sesion abierta correctamente.'
        : 'Caja creada correctamente.',
      id_caja: idCaja,
      id_caja_usuario_autorizado: idCajaUsuarioAutorizado,
      id_sesion_caja: idSesionCaja
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 500) {
      return res.status(err.httpStatus).json({
        error: true,
        code: err.code || 'VENTAS_CAJAS_CATALOG_CREATE_ERROR',
        message: err.publicMessage || 'No se pudo crear la caja.'
      });
    }
    console.error('[cajas] create listado error:', err);
    return res.status(500).json({
      error: true,
      code: 'VENTAS_CAJAS_CATALOG_CREATE_ERROR',
      message: 'No se pudo crear la caja.'
    });
  } finally {
    client.release();
  }
});

router.patch('/ventas/cajas/listado/:id', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idCaja = parsePositiveInt(req.params.id);
    if (!idCaja) throw createCajaError(400, 'VENTAS_CAJAS_CAJA_ID_INVALID', 'El id de caja es invalido.');

    const cajaResult = await client.query(
      `
        SELECT id_caja, id_sucursal, codigo_caja, nombre_caja, observacion,
               COALESCE(estado, true) AS estado,
               COALESCE(permite_auxiliares, true) AS permite_auxiliares
        FROM public.cajas
        WHERE id_caja = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idCaja]
    );
    if (cajaResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
    }

    const currentCaja = cajaResult.rows[0];
    const requestedSucursalId = parseNullablePositiveInt(req.body.id_sucursal) || currentCaja.id_sucursal;
    const scopeContext = await getScopeContext(req, client, requestedSucursalId, true);
    assertSucursalAllowed(scopeContext, requestedSucursalId);

    const hasNombre = Object.prototype.hasOwnProperty.call(req.body, 'nombre_caja');
    const hasCodigo = Object.prototype.hasOwnProperty.call(req.body, 'codigo_caja');
    const hasEstado = Object.prototype.hasOwnProperty.call(req.body, 'estado');
    const hasObservacion = Object.prototype.hasOwnProperty.call(req.body, 'observacion');
    const hasPermiteAuxiliares = Object.prototype.hasOwnProperty.call(req.body, 'permite_auxiliares');
    const hasSucursal = Object.prototype.hasOwnProperty.call(req.body, 'id_sucursal');

    if (!hasNombre && !hasCodigo && !hasEstado && !hasObservacion && !hasPermiteAuxiliares && !hasSucursal) {
      throw createCajaError(400, 'VENTAS_CAJAS_UPDATE_EMPTY', 'Debe enviar al menos un campo para actualizar.');
    }

    const nombreCaja = hasNombre ? normalizeText(req.body.nombre_caja, 120) : currentCaja.nombre_caja;
    const codigoCaja = hasCodigo ? normalizeCajaCode(req.body.codigo_caja, 40) : currentCaja.codigo_caja;
    const observacion = hasObservacion ? normalizeText(req.body.observacion, 300) : currentCaja.observacion;
    const estado = hasEstado ? parseBooleanWithDefault(req.body.estado, true) : parseBooleanWithDefault(currentCaja.estado, true);
    const permiteAuxiliares = hasPermiteAuxiliares
      ? parseBooleanWithDefault(req.body.permite_auxiliares, true)
      : parseBooleanWithDefault(currentCaja.permite_auxiliares, true);

    if (!nombreCaja) {
      throw createCajaError(400, 'VENTAS_CAJAS_NAME_REQUIRED', 'Debe indicar el nombre de la caja.');
    }

    if (codigoCaja) {
      const duplicateCode = await client.query(
        `
          SELECT id_caja
          FROM public.cajas
          WHERE id_sucursal = $1
            AND UPPER(TRIM(COALESCE(codigo_caja, ''))) = $2
            AND id_caja <> $3
          LIMIT 1
          FOR UPDATE
        `,
        [requestedSucursalId, codigoCaja, idCaja]
      );
      if (duplicateCode.rowCount > 0) {
        throw createCajaError(409, 'VENTAS_CAJAS_CODE_DUPLICATE', 'Ya existe una caja con ese codigo en la sucursal seleccionada.');
      }
    }

    await client.query(
      `
        UPDATE public.cajas
        SET id_sucursal = $1,
            codigo_caja = $2,
            nombre_caja = $3,
            observacion = $4,
            estado = $5,
            permite_auxiliares = $6,
            fecha_actualizacion = NOW()
        WHERE id_caja = $7
      `,
      [requestedSucursalId, codigoCaja, nombreCaja, observacion, estado, permiteAuxiliares, idCaja]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Caja actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOG_UPDATE_ERROR', 'No se pudo actualizar la caja.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/asignaciones', checkPermission(['VENTAS_CAJAS_LISTADO_VER', 'VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    const includeInactive = parseBooleanWithDefault(req.query.incluir_inactivas, false);
    const includeInactiveCajas = parseBooleanWithDefault(req.query.incluir_cajas_inactivas, false);

    if (idCaja) {
      const caja = await fetchCajaById(pool, idCaja);
      if (!caja) throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
      assertSucursalAllowed(scopeContext, caja.id_sucursal);
    }

    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) {
      pushFilter('cua.id_sucursal = $IDX', scopeContext.targetSucursalId);
    } else if (!scopeContext.isSuperAdmin) {
      pushFilter('cua.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    }
    if (!includeInactive) {
      filters.push('COALESCE(cua.estado, true) = true');
    }
    if (!includeInactiveCajas) {
      filters.push('COALESCE(c.estado, true) = true');
    }
    if (idCaja) {
      pushFilter('cua.id_caja = $IDX', idCaja);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT cua.id_caja_usuario_autorizado, cua.id_caja, cua.id_sucursal, cua.id_usuario,
               COALESCE(cua.puede_responsable, false) AS puede_responsable,
               COALESCE(cua.puede_auxiliar, false) AS puede_auxiliar,
               COALESCE(cua.estado, true) AS estado,
               cua.observacion, cua.fecha_creacion, cua.fecha_actualizacion,
               c.codigo_caja, c.nombre_caja,
               s.nombre_sucursal,
               u.nombre_usuario,
               COALESCE(
                 NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
                 u.nombre_usuario
               ) AS nombre_completo
        FROM public.cajas_usuarios_autorizados cua
        INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cua.id_sucursal
        INNER JOIN public.usuarios u ON u.id_usuario = cua.id_usuario
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        ${whereClause}
        ORDER BY COALESCE(cua.estado, true) DESC, c.nombre_caja ASC, nombre_completo ASC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_ASSIGNMENTS_LIST_ERROR', 'No se pudieron listar las asignaciones de cajas.');
  }
});

router.post('/ventas/cajas/asignaciones', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idCaja = parsePositiveInt(req.body.id_caja);
    const idUsuario = parsePositiveInt(req.body.id_usuario);
    const puedeResponsable = parseBooleanWithDefault(req.body.puede_responsable, true);
    const puedeAuxiliar = parseBooleanWithDefault(req.body.puede_auxiliar, true);
    if (!idCaja || !idUsuario) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_DATA_INVALID', 'Debe indicar una caja y un usuario validos.');
    }
    if ((puedeResponsable && puedeAuxiliar) || (!puedeResponsable && !puedeAuxiliar)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_ROLE_EXCLUSIVE', 'Debe seleccionar solo un rol operativo: responsable o auxiliar.');
    }

    const caja = await fetchCajaById(client, idCaja);
    if (!caja) throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');

    const scopeContext = await getScopeContext(req, client, caja.id_sucursal, true);
    assertSucursalAllowed(scopeContext, caja.id_sucursal);

    const user = await fetchAssignableCajaUserById(client, idUsuario);
    if (!user) {
      throw createCajaError(
        404,
        'VENTAS_CAJAS_ASSIGN_USER_NOT_FOUND',
        'El usuario indicado debe ser un empleado activo.'
      );
    }
    const actorIsSuperAdmin = await requestIsSuperAdminReal(client, req);
    const userRoles = Array.isArray(user.roles_normalizados) ? user.roles_normalizados : [];
    const userIsSuperOrAdmin = isCajaUserAdminLike(userRoles);
    if (puedeResponsable && !isCajaUserCajero(userRoles)) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
    }
    if (puedeAuxiliar && !actorIsSuperAdmin && userIsSuperOrAdmin) {
      throw createCajaError(403, 'VENTAS_CAJAS_ASSIGN_ROLE_FORBIDDEN', 'Solo super_admin puede asignar usuarios administradores como auxiliares.');
    }
    if (Number.parseInt(String(user.id_sucursal || ''), 10) !== Number(caja.id_sucursal)) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_USER_SCOPE_MISMATCH',
        'El usuario seleccionado no pertenece a la sucursal operativa de la caja.'
      );
    }

    await ensureActiveAssignmentBusinessRules(client, {
      idCaja,
      idUsuario,
      idSucursal: caja.id_sucursal,
      puedeResponsable,
      targetRoleCodes: userRoles,
      actorIsSuperAdmin,
      estado: true,
      excludeAssignmentId: null
    });

    const idCajaUsuarioAutorizado = await upsertCajaAuthorization(client, {
      idCaja,
      idSucursal: caja.id_sucursal,
      idUsuario,
      puedeResponsable,
      puedeAuxiliar,
      observacion: req.body.observacion
    });

    await client.query('COMMIT');
    return res.status(201).json({
      message: 'Asignacion de caja registrada correctamente.',
      id_caja_usuario_autorizado: idCajaUsuarioAutorizado
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_ASSIGN_CREATE_ERROR', 'No se pudo registrar la asignacion de caja.');
  } finally {
    client.release();
  }
});

router.patch('/ventas/cajas/asignaciones/:id', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idAsignacion = parsePositiveInt(req.params.id);
    if (!idAsignacion) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGNMENT_ID_INVALID', 'El id de asignacion es invalido.');
    }

    const assignmentResult = await client.query(
      `
        SELECT id_caja_usuario_autorizado, id_caja, id_sucursal, id_usuario,
               COALESCE(puede_responsable, false) AS puede_responsable,
               COALESCE(puede_auxiliar, false) AS puede_auxiliar,
               COALESCE(estado, true) AS estado,
               observacion
        FROM public.cajas_usuarios_autorizados
        WHERE id_caja_usuario_autorizado = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idAsignacion]
    );
    if (assignmentResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_ASSIGNMENT_NOT_FOUND', 'La asignacion indicada no existe.');
    }

    const assignment = assignmentResult.rows[0];
    const scopeContext = await getScopeContext(req, client, assignment.id_sucursal, true);
    assertSucursalAllowed(scopeContext, assignment.id_sucursal);

    const hasPuedeResponsable = Object.prototype.hasOwnProperty.call(req.body, 'puede_responsable');
    const hasPuedeAuxiliar = Object.prototype.hasOwnProperty.call(req.body, 'puede_auxiliar');
    const hasEstado = Object.prototype.hasOwnProperty.call(req.body, 'estado');
    const hasObservacion = Object.prototype.hasOwnProperty.call(req.body, 'observacion');

    if (!hasPuedeResponsable && !hasPuedeAuxiliar && !hasEstado && !hasObservacion) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGNMENT_UPDATE_EMPTY', 'Debe enviar al menos un campo para actualizar.');
    }

    const puedeResponsable = hasPuedeResponsable
      ? parseBooleanWithDefault(req.body.puede_responsable, false)
      : parseBooleanWithDefault(assignment.puede_responsable, false);
    const puedeAuxiliar = hasPuedeAuxiliar
      ? parseBooleanWithDefault(req.body.puede_auxiliar, false)
      : parseBooleanWithDefault(assignment.puede_auxiliar, false);
    const estado = hasEstado
      ? parseBooleanWithDefault(req.body.estado, true)
      : parseBooleanWithDefault(assignment.estado, true);
    const observacion = hasObservacion ? normalizeText(req.body.observacion, 300) : assignment.observacion;

    if (estado && ((puedeResponsable && puedeAuxiliar) || (!puedeResponsable && !puedeAuxiliar))) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGN_ROLE_EXCLUSIVE', 'Debe seleccionar solo un rol operativo: responsable o auxiliar.');
    }
    const assignmentUser = await fetchAssignableCajaUserById(client, assignment.id_usuario);
    const actorIsSuperAdmin = await requestIsSuperAdminReal(client, req);
    const assignmentUserRoles = Array.isArray(assignmentUser?.roles_normalizados) ? assignmentUser.roles_normalizados : [];
    const assignmentIsSuperOrAdmin = isCajaUserAdminLike(assignmentUserRoles);
    if (estado && puedeResponsable && !isCajaUserCajero(assignmentUserRoles)) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESPONSABLE_ROLE_INVALID', 'El responsable de caja debe ser un usuario con rol cajero.');
    }
    if (estado && puedeAuxiliar && !actorIsSuperAdmin && assignmentIsSuperOrAdmin) {
      throw createCajaError(403, 'VENTAS_CAJAS_ASSIGN_ROLE_FORBIDDEN', 'Solo super_admin puede asignar usuarios administradores como auxiliares.');
    }

    await ensureActiveAssignmentBusinessRules(client, {
      idCaja: assignment.id_caja,
      idUsuario: assignment.id_usuario,
      idSucursal: assignment.id_sucursal,
      puedeResponsable,
      targetRoleCodes: assignmentUserRoles,
      actorIsSuperAdmin,
      estado,
      excludeAssignmentId: idAsignacion
    });

    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET puede_responsable = $1,
            puede_auxiliar = $2,
            estado = $3,
            observacion = $4,
            fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $5
      `,
      [puedeResponsable, puedeAuxiliar, estado, observacion, idAsignacion]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Asignacion de caja actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_ASSIGN_UPDATE_ERROR', 'No se pudo actualizar la asignacion de caja.');
  } finally {
    client.release();
  }
});

const deactivateAsignacionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idAsignacion = parsePositiveInt(req.params.id);
    if (!idAsignacion) {
      throw createCajaError(400, 'VENTAS_CAJAS_ASSIGNMENT_ID_INVALID', 'El id de asignacion es invalido.');
    }

    const assignmentResult = await client.query(
      `
        SELECT id_caja_usuario_autorizado, id_sucursal, COALESCE(estado, true) AS estado, observacion
        FROM public.cajas_usuarios_autorizados
        WHERE id_caja_usuario_autorizado = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idAsignacion]
    );
    if (assignmentResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_ASSIGNMENT_NOT_FOUND', 'La asignacion indicada no existe.');
    }

    const assignment = assignmentResult.rows[0];
    const scopeContext = await getScopeContext(req, client, assignment.id_sucursal, true);
    assertSucursalAllowed(scopeContext, assignment.id_sucursal);

    if (!parseBooleanish(assignment.estado)) {
      throw createCajaError(409, 'VENTAS_CAJAS_ASSIGNMENT_ALREADY_INACTIVE', 'La asignacion ya se encuentra inactiva.');
    }

    const nextObservation = normalizeText(
      assignment.observacion
        ? `${assignment.observacion}. Asignacion desactivada manualmente.`
        : 'Asignacion desactivada manualmente.',
      300
    );

    await client.query(
      `
        UPDATE public.cajas_usuarios_autorizados
        SET estado = false, observacion = $2, fecha_actualizacion = NOW()
        WHERE id_caja_usuario_autorizado = $1
      `,
      [idAsignacion, nextObservation]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Asignacion de caja inactivada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_ASSIGN_INACTIVATE_ERROR', 'No se pudo inactivar la asignacion de caja.');
  } finally {
    client.release();
  }
};

router.patch('/ventas/cajas/asignaciones/:id/inactivar', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), deactivateAsignacionHandler);
router.patch('/ventas/cajas/asignaciones/:id/desactivar', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), deactivateAsignacionHandler);

router.get('/ventas/cajas/sesiones', checkPermission(['VENTAS_CAJAS_LISTADO_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) pushFilter('cs.id_sucursal = $IDX', scopeContext.targetSucursalId);
    else if (!scopeContext.isSuperAdmin) pushFilter('cs.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);

    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    const idResponsable = parseNullablePositiveInt(req.query.id_usuario_responsable);
    const idEstadoSesion = parseNullablePositiveInt(req.query.id_estado_sesion_caja);
    const fechaDesde = normalizeText(req.query.fecha_desde, 20);
    const fechaHasta = normalizeText(req.query.fecha_hasta, 20);

    if (idCaja) pushFilter('cs.id_caja = $IDX', idCaja);
    if (idResponsable) pushFilter('cs.id_usuario_responsable = $IDX', idResponsable);
    if (idEstadoSesion) pushFilter('cs.id_estado_sesion_caja = $IDX', idEstadoSesion);
    if (fechaDesde) pushFilter('cs.fecha_apertura::date >= $IDX::date', fechaDesde);
    if (fechaHasta) pushFilter('COALESCE(cs.fecha_cierre, NOW())::date <= $IDX::date', fechaHasta);

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.id_usuario_responsable, cs.id_estado_sesion_caja,
               cs.fecha_apertura, cs.fecha_cierre, cs.monto_apertura,
               resumen.ventas_efectivo, resumen.ventas_no_efectivo, resumen.ingresos_manuales,
               resumen.egresos_manuales, resumen.efectivo_teorico, resumen.monto_declarado_cierre,
               resumen.diferencia_cierre, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               estado.codigo AS estado_codigo, estado.nombre AS estado_nombre,
               u.nombre_usuario AS responsable_usuario, ${USER_DISPLAY_SQL} AS responsable_nombre
        FROM public.cajas_sesiones cs
        INNER JOIN public.cajas c ON c.id_caja = cs.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = cs.id_sucursal
        INNER JOIN public.cat_cajas_sesiones_estados estado ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
        INNER JOIN public.usuarios u ON u.id_usuario = cs.id_usuario_responsable
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        LEFT JOIN public.vw_cajas_sesiones_resumen resumen ON resumen.id_sesion_caja = cs.id_sesion_caja
        ${whereClause}
        ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_SESIONES_LIST_ERROR', 'No se pudieron listar las sesiones de caja.');
  }
});

const sessionDetailHandler = async (req, res, defaultCode, defaultMessage) => {
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, pool, null, true);
    const session = await fetchSessionBase(pool, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    return res.status(200).json(await buildSessionDetailPayload(pool, session));
  } catch (err) {
    return sendInternalError(res, err, defaultCode, defaultMessage);
  }
};

router.get('/ventas/cajas/sesiones/:id', checkPermission(['VENTAS_CAJAS_DETALLE_VER']), async (req, res) =>
  sessionDetailHandler(req, res, 'VENTAS_CAJAS_SESION_DETAIL_ERROR', 'No se pudo obtener el detalle de la sesion de caja.')
);

router.get('/ventas/cajas/sesiones/:id/reporte', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) =>
  sessionDetailHandler(req, res, 'VENTAS_CAJAS_REPORTE_ERROR', 'No se pudo obtener el reporte de la sesion de caja.')
);

const createOpenSessionTransaction = async ({
  client,
  scopeContext,
  idCaja,
  responsableId,
  montoApertura,
  observacionApertura
}) => {
  const caja = await fetchCajaById(client, idCaja);
  if (!caja || !parseBooleanish(caja.estado)) {
    throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
  }

  assertSucursalAllowed(scopeContext, caja.id_sucursal);
  await assertCajaAuthorization(client, idCaja, responsableId, 'RESPONSABLE');

  const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
  const openSessionResult = await client.query(
    `SELECT id_sesion_caja FROM public.cajas_sesiones WHERE id_caja = $1 AND id_estado_sesion_caja = $2 LIMIT 1 FOR UPDATE`,
    [idCaja, idEstadoAbierta]
  );
  if (openSessionResult.rowCount > 0) {
    throw createCajaError(409, 'VENTAS_CAJAS_SESSION_ALREADY_OPEN', 'La caja ya tiene una sesion abierta.');
  }

  const responsibleOpenSessionResult = await client.query(
    `SELECT cs.id_sesion_caja FROM public.cajas_sesiones cs WHERE cs.id_usuario_responsable = $1 AND cs.id_estado_sesion_caja = $2 LIMIT 1`,
    [responsableId, idEstadoAbierta]
  );
  if (responsibleOpenSessionResult.rowCount > 0) {
    throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_BUSY', 'El responsable ya tiene una sesion de caja abierta.');
  }

  const idRolResponsable = await getCatalogId(client, 'PARTICIPATION_ROLES', 'RESPONSABLE');
  const idTipoApertura = await getCatalogId(client, 'MOVEMENT_TYPES', 'APERTURA');

  const sessionInsert = await client.query(
    `
      INSERT INTO public.cajas_sesiones (
        id_caja, id_sucursal, id_usuario_responsable, id_estado_sesion_caja, id_usuario_apertura,
        fecha_apertura, monto_apertura, observacion_apertura, fecha_creacion, fecha_actualizacion
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, NOW(), NOW())
      RETURNING id_sesion_caja
    `,
    [idCaja, caja.id_sucursal, responsableId, idEstadoAbierta, scopeContext.idUsuario, montoApertura, observacionApertura]
  );
  const idSesionCaja = Number(sessionInsert.rows?.[0]?.id_sesion_caja || 0) || null;
  if (!idSesionCaja) {
    throw createCajaError(500, 'VENTAS_CAJAS_SESSION_ID_ERROR', 'No se pudo determinar el identificador de la sesion abierta.');
  }

  await client.query(
    `
      INSERT INTO public.cajas_sesiones_participantes (
        id_sesion_caja, id_usuario, id_rol_participacion_caja, fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
      )
      VALUES ($1, $2, $3, NOW(), true, $4, NOW(), NOW())
    `,
    [idSesionCaja, responsableId, idRolResponsable, 'Responsable de apertura']
  );

  if (montoApertura > 0 && idTipoApertura) {
    await client.query(
      `
        INSERT INTO public.cajas_movimientos (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_movimiento_caja, id_usuario_ejecutor,
          monto, observacion, fecha_movimiento, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      `,
      [idSesionCaja, idCaja, caja.id_sucursal, idTipoApertura, scopeContext.idUsuario, montoApertura, observacionApertura || 'Apertura de sesion de caja']
    );
  }

  return idSesionCaja;
};

const openSessionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idCaja = parsePositiveInt(req.body.id_caja);
    const requestedSucursalId = parseNullablePositiveInt(req.body.id_sucursal);
    const montoApertura = parseNonNegativeAmount(req.body.monto_apertura ?? 0);
    const observacionApertura = normalizeText(req.body.observacion_apertura, 500);
    const requestedResponsableId = parseNullablePositiveInt(req.body.id_usuario_responsable);
    if (!idCaja) throw createCajaError(400, 'VENTAS_CAJAS_CAJA_REQUIRED', 'Debe indicar una caja valida.');
    if (montoApertura === null) throw createCajaError(400, 'VENTAS_CAJAS_APERTURA_AMOUNT_INVALID', 'monto_apertura debe ser un numero mayor o igual a 0.');

    const scopeContext = await getScopeContext(req, client, requestedSucursalId, true);
    let responsableId = requestedResponsableId || scopeContext.idUsuario;
    const caja = await fetchCajaById(client, idCaja);
    if (!caja) {
      throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
    }
    if (!requestedResponsableId) {
      const selfAuthorization = await fetchCajaAuthorization(client, idCaja, scopeContext.idUsuario);
      if (!parseBooleanish(selfAuthorization?.puede_responsable)) {
        const fallbackResponsable = await fetchCajaDefaultResponsible(client, idCaja, caja.id_sucursal);
        if (!fallbackResponsable) {
          throw createCajaError(
            409,
            'VENTAS_CAJAS_RESPONSABLE_REQUIRED',
            'La caja no tiene un responsable autorizado activo. Asigna un responsable antes de abrir sesion.'
          );
        }
        responsableId = fallbackResponsable;
      }
    }
    const idSesionCaja = await createOpenSessionTransaction({
      client,
      scopeContext,
      idCaja,
      responsableId,
      montoApertura,
      observacionApertura
    });

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Sesion de caja iniciada correctamente.', id_sesion_caja: idSesionCaja });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_OPEN_ERROR', 'No se pudo abrir la sesion de caja.');
  } finally {
    client.release();
  }
};

router.post('/ventas/cajas/sesiones', checkPermission(['VENTAS_CAJAS_SESION_ABRIR']), openSessionHandler);
router.post('/ventas/cajas/sesiones/abrir', checkPermission(['VENTAS_CAJAS_SESION_ABRIR']), openSessionHandler);

const closeSessionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    let montoDeclaradoCierre = parseNullableNonNegativeAmount(req.body.monto_declarado_cierre);
    const observacionCierre = normalizeText(req.body.observacion_cierre, 500);
    const idResolucion = parseNullablePositiveInt(req.body.id_resolucion_cierre_caja);
    const idArqueoFinal = parseNullablePositiveInt(req.body.id_arqueo_final);

    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    await ensureAdminOrSuperAdmin(req);
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);

    const resumenResult = await client.query(`SELECT * FROM public.vw_cajas_sesiones_resumen WHERE id_sesion_caja = $1 LIMIT 1`, [idSesionCaja]);
    const resumen = resumenResult.rows[0];
    if (!resumen) throw createCajaError(409, 'VENTAS_CAJAS_CLOSE_SUMMARY_ERROR', 'No se pudo calcular el resumen operativo de la sesion.');

    const montoTeorico = Number(resumen.efectivo_teorico || 0);
    let idArqueoFinalSelected = idArqueoFinal;

    if (montoDeclaradoCierre === null) {
      let arqueoFinal = null;
      if (idArqueoFinalSelected) {
        const arqueoResult = await client.query(
          `
            SELECT id_arqueo_caja, monto_contado
            FROM public.cajas_arqueos
            WHERE id_arqueo_caja = $1
              AND id_sesion_caja = $2
            LIMIT 1
          `,
          [idArqueoFinalSelected, idSesionCaja]
        );
        arqueoFinal = arqueoResult.rows[0] || null;
      } else {
        const arqueoResult = await client.query(
          `
            SELECT a.id_arqueo_caja, a.monto_contado
            FROM public.cajas_arqueos a
            INNER JOIN public.cat_cajas_arqueos_tipos t
              ON t.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja
            WHERE a.id_sesion_caja = $1
              AND UPPER(TRIM(t.codigo)) = 'CIERRE'
            ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC
            LIMIT 1
          `,
          [idSesionCaja]
        );
        arqueoFinal = arqueoResult.rows[0] || null;
      }

      if (arqueoFinal?.id_arqueo_caja) {
        idArqueoFinalSelected = Number(arqueoFinal.id_arqueo_caja);
        montoDeclaradoCierre = parseNullableNonNegativeAmount(arqueoFinal.monto_contado);
      }
    }

    if (montoDeclaradoCierre === null) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_CLOSE_AMOUNT_INVALID',
        'Debe indicar el monto declarado de cierre o registrar un arqueo de cierre.'
      );
    }

    const diferencia = Number((montoDeclaradoCierre - montoTeorico).toFixed(2));

    if (Math.abs(diferencia) > 0 && !idResolucion) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_REQUIRED', 'Debe seleccionar una resolucion de cierre cuando existe diferencia.');
    }
    if (Math.abs(diferencia) > 0 && !(await requestHasAnyPermission(req, 'VENTAS_CAJAS_DIFERENCIA_RESOLVER'))) {
      throw createCajaError(403, 'VENTAS_CAJAS_DIFFERENCE_FORBIDDEN', 'No tiene permiso para resolver diferencias de cierre.');
    }

    let idResolucionFinal = idResolucion;
    const idResolucionCajaCuadra = await getCatalogId(client, 'RESOLUTIONS', 'CAJA_CUADRA');

    if (Math.abs(diferencia) > 0 && idResolucionFinal) {
      const requestedResolutionCode = await getCatalogCodeById(client, 'RESOLUTIONS', idResolucionFinal);
      if (requestedResolutionCode === 'CAJA_CUADRA') {
        throw createCajaError(
          400,
          'VENTAS_CAJAS_RESOLUTION_INVALID',
          'Caja cuadra no es una resolucion manual cuando existe diferencia.'
        );
      }
    }

    if (!idResolucionFinal && Math.abs(diferencia) === 0) {
      idResolucionFinal = idResolucionCajaCuadra;
      if (!idResolucionFinal) {
        throw createCajaError(
          409,
          'VENTAS_CAJAS_RESOLUTION_DEFAULT_MISSING',
          'No se encontro la resolucion por defecto para cierres cuadrados.'
        );
      }
    } else if (Math.abs(diferencia) === 0 && idResolucionFinal && Number(idResolucionFinal) !== Number(idResolucionCajaCuadra)) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_RESOLUTION_NOT_REQUIRED',
        'Cuando la caja cuadra no se permite seleccionar otra resolucion.'
      );
    }

    const idEstadoCerrada = await getCatalogId(client, 'SESSION_STATES', 'CERRADA');
    const closeResult = await client.query(
      `
        INSERT INTO public.cajas_cierres (
          id_sesion_caja, id_caja, id_sucursal, id_usuario_responsable, id_usuario_cierre,
          id_resolucion_cierre_caja, id_arqueo_final, fecha_cierre, monto_apertura, monto_ventas_efectivo,
          monto_ventas_no_efectivo, monto_ingresos_manuales, monto_egresos_manuales, monto_teorico_cierre,
          monto_declarado_cierre, diferencia, observacion, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
        RETURNING id_cierre_caja
      `,
      [
        idSesionCaja, session.id_caja, session.id_sucursal, session.id_usuario_responsable, scopeContext.idUsuario,
        idResolucionFinal, idArqueoFinalSelected, Number(session.monto_apertura || 0), Number(resumen.ventas_efectivo || 0),
        Number(resumen.ventas_no_efectivo || 0), Number(resumen.ingresos_manuales || 0), Number(resumen.egresos_manuales || 0),
        montoTeorico, montoDeclaradoCierre, diferencia, observacionCierre
      ]
    );
    const idCierreCaja = Number(closeResult.rows?.[0]?.id_cierre_caja || 0) || null;

    await client.query(
      `
        UPDATE public.cajas_sesiones
        SET id_estado_sesion_caja = $1, id_usuario_cierre = $2, fecha_cierre = NOW(),
            monto_teorico_cierre = $3, monto_declarado_cierre = $4, diferencia_cierre = $5,
            id_resolucion_cierre_caja = $6, observacion_cierre = $7, fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $8
      `,
      [idEstadoCerrada, scopeContext.idUsuario, montoTeorico, montoDeclaradoCierre, diferencia, idResolucionFinal, observacionCierre, idSesionCaja]
    );

    await client.query(
      `
        UPDATE public.cajas_sesiones_participantes
        SET activo = false, fecha_fin = NOW(), fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $1 AND COALESCE(activo, true) = true
      `,
      [idSesionCaja]
    );

    const resolutionCode = await getCatalogCodeById(client, 'RESOLUTIONS', idResolucionFinal);
    const payrollSync = await syncPayrollDeductionForClose({
      client,
      idCierreCaja,
      idUsuarioResponsable: session.id_usuario_responsable,
      idSucursal: session.id_sucursal,
      fechaCierre: new Date().toISOString(),
      diferencia,
      resolucionCodigo: resolutionCode
    });

    await client.query('COMMIT');
    return res.status(200).json({
      message: 'Cierre de caja registrado correctamente.',
      id_cierre_caja: idCierreCaja,
      diferencia,
      id_arqueo_final: idArqueoFinalSelected,
      payroll_sync: payrollSync
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CLOSE_ERROR', 'No se pudo cerrar la sesion de caja.');
  } finally {
    client.release();
  }
};

router.patch('/ventas/cajas/sesiones/:id/cerrar', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), closeSessionHandler);
router.post('/ventas/cajas/sesiones/:id/cerrar', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), closeSessionHandler);

router.patch('/ventas/cajas/cierres/:id', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAdminOrSuperAdmin(req);

    const idCierreCaja = parsePositiveInt(req.params.id);
    const montoDeclarado = parseNullableNonNegativeAmount(req.body.monto_declarado_cierre);
    const observacion = normalizeText(req.body.observacion_cierre, 500);
    const motivoEdicion = normalizeText(req.body.motivo_edicion, 500);
    const idResolucion = parseNullablePositiveInt(req.body.id_resolucion_cierre_caja);
    const idArqueoFinal = parseNullablePositiveInt(req.body.id_arqueo_final);

    if (!idCierreCaja) {
      throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_ID_INVALID', 'El id de cierre es invalido.');
    }
    if (!motivoEdicion) {
      throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_EDIT_REASON_REQUIRED', 'Debe indicar el motivo de la edicion.');
    }

    const closeResult = await client.query(
      `
        SELECT cc.*, cs.id_estado_sesion_caja
        FROM public.cajas_cierres cc
        INNER JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = cc.id_sesion_caja
        WHERE cc.id_cierre_caja = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idCierreCaja]
    );
    if (closeResult.rowCount === 0) {
      throw createCajaError(404, 'VENTAS_CAJAS_CLOSE_NOT_FOUND', 'El cierre indicado no existe.');
    }

    const cierre = closeResult.rows[0];
    const scopeContext = await getScopeContext(req, client, cierre.id_sucursal, true);
    assertSucursalAllowed(scopeContext, cierre.id_sucursal);

    const fechaCreacion = new Date(cierre.fecha_creacion || cierre.fecha_cierre || 0);
    const elapsedMinutes = Math.floor((Date.now() - fechaCreacion.getTime()) / 60000);
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes > 30) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_CLOSE_EDIT_WINDOW_EXPIRED',
        'El cierre solo puede editarse durante los primeros 30 minutos.'
      );
    }

    let montoDeclaradoFinal = montoDeclarado;
    let idArqueoFinalSelected = idArqueoFinal ?? parseNullablePositiveInt(cierre.id_arqueo_final);
    if (montoDeclaradoFinal === null && idArqueoFinalSelected) {
      const arqueoResult = await client.query(
        `
          SELECT monto_contado
          FROM public.cajas_arqueos
          WHERE id_arqueo_caja = $1
            AND id_sesion_caja = $2
          LIMIT 1
        `,
        [idArqueoFinalSelected, cierre.id_sesion_caja]
      );
      montoDeclaradoFinal = parseNullableNonNegativeAmount(arqueoResult.rows?.[0]?.monto_contado);
    }
    if (montoDeclaradoFinal === null) {
      throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_AMOUNT_INVALID', 'Debe indicar un monto declarado valido.');
    }

    const summaryResult = await client.query(
      `SELECT * FROM public.vw_cajas_sesiones_resumen WHERE id_sesion_caja = $1 LIMIT 1`,
      [cierre.id_sesion_caja]
    );
    const summary = summaryResult.rows[0];
    if (!summary) {
      throw createCajaError(409, 'VENTAS_CAJAS_CLOSE_SUMMARY_ERROR', 'No se pudo calcular el resumen de la sesion.');
    }

    const montoTeorico = Number(summary.efectivo_teorico || 0);
    const diferencia = Number((montoDeclaradoFinal - montoTeorico).toFixed(2));
    const idResolucionCajaCuadra = await getCatalogId(client, 'RESOLUTIONS', 'CAJA_CUADRA');
    let idResolucionFinal = idResolucion ?? parseNullablePositiveInt(cierre.id_resolucion_cierre_caja);

    if (Math.abs(diferencia) === 0) {
      idResolucionFinal = idResolucionCajaCuadra;
    } else if (!idResolucionFinal) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_REQUIRED', 'Debe seleccionar una resolucion para diferencias.');
    }

    const resolutionCode = await getCatalogCodeById(client, 'RESOLUTIONS', idResolucionFinal);
    if (Math.abs(diferencia) > 0 && resolutionCode === 'CAJA_CUADRA') {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_RESOLUTION_INVALID',
        'Caja cuadra no aplica cuando existe diferencia.'
      );
    }

    await client.query(
      `
        UPDATE public.cajas_cierres
        SET id_resolucion_cierre_caja = $1,
            id_arqueo_final = $2,
            monto_teorico_cierre = $3,
            monto_declarado_cierre = $4,
            diferencia = $5,
            observacion = $6
        WHERE id_cierre_caja = $7
      `,
      [
        idResolucionFinal,
        idArqueoFinalSelected,
        montoTeorico,
        montoDeclaradoFinal,
        diferencia,
        observacion,
        idCierreCaja
      ]
    );

    await client.query(
      `
        UPDATE public.cajas_sesiones
        SET monto_teorico_cierre = $1,
            monto_declarado_cierre = $2,
            diferencia_cierre = $3,
            id_resolucion_cierre_caja = $4,
            observacion_cierre = $5,
            fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $6
      `,
      [montoTeorico, montoDeclaradoFinal, diferencia, idResolucionFinal, observacion, cierre.id_sesion_caja]
    );

    await client.query(
      `
        INSERT INTO public.cajas_cierres_auditoria (
          id_cierre_caja,
          id_usuario_accion,
          accion,
          motivo,
          snapshot_before,
          snapshot_after,
          fecha_creacion
        )
        VALUES ($1, $2, 'EDIT', $3, $4::jsonb, $5::jsonb, NOW())
      `,
      [
        idCierreCaja,
        scopeContext.idUsuario,
        motivoEdicion,
        JSON.stringify(cierre),
        JSON.stringify({
          ...cierre,
          id_resolucion_cierre_caja: idResolucionFinal,
          id_arqueo_final: idArqueoFinalSelected,
          monto_teorico_cierre: montoTeorico,
          monto_declarado_cierre: montoDeclaradoFinal,
          diferencia,
          observacion
        })
      ]
    );

    const payrollSync = await syncPayrollDeductionForClose({
      client,
      idCierreCaja,
      idUsuarioResponsable: cierre.id_usuario_responsable,
      idSucursal: cierre.id_sucursal,
      fechaCierre: cierre.fecha_cierre || new Date().toISOString(),
      diferencia,
      resolucionCodigo: resolutionCode
    });

    await client.query('COMMIT');
    return res.status(200).json({
      message: 'Cierre editado correctamente.',
      id_cierre_caja: idCierreCaja,
      diferencia,
      payroll_sync: payrollSync
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CLOSE_EDIT_ERROR', 'No se pudo editar el cierre de caja.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/reportes/resumen', checkPermission(['VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) pushFilter('vw.id_sucursal = $IDX', scopeContext.targetSucursalId);
    else if (!scopeContext.isSuperAdmin) pushFilter('vw.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    const idResponsable = parseNullablePositiveInt(req.query.id_usuario_responsable);
    if (idCaja) pushFilter('vw.id_caja = $IDX', idCaja);
    if (idResponsable) pushFilter('vw.id_usuario_responsable = $IDX', idResponsable);

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT vw.*, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               u.nombre_usuario AS responsable_usuario, ${USER_DISPLAY_SQL} AS responsable_nombre
        FROM public.vw_cajas_sesiones_resumen vw
        INNER JOIN public.cajas c ON c.id_caja = vw.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = vw.id_sucursal
        INNER JOIN public.usuarios u ON u.id_usuario = vw.id_usuario_responsable
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas per ON per.id_persona = e.id_persona
        ${whereClause}
        ORDER BY vw.fecha_apertura DESC, vw.id_sesion_caja DESC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_REPORT_SUMMARY_ERROR', 'No se pudo generar el resumen de cajas.');
  }
});

router.get('/ventas/cajas/reportes/cierres', checkPermission(['VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const requestedSucursalId = parseNullablePositiveInt(req.query.id_sucursal);
    const scopeContext = await getScopeContext(req, pool, requestedSucursalId, true);
    const filters = [];
    const params = [];
    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    if (scopeContext.targetSucursalId) pushFilter('vw.id_sucursal = $IDX', scopeContext.targetSucursalId);
    else if (!scopeContext.isSuperAdmin) pushFilter('vw.id_sucursal = ANY($IDX::int[])', scopeContext.allowedSucursalIds);
    const idCaja = parseNullablePositiveInt(req.query.id_caja);
    if (idCaja) pushFilter('vw.id_caja = $IDX', idCaja);

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT vw.*, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
               resp.nombre_usuario AS responsable_usuario,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_resp.nombre, per_resp.apellido)), ''), resp.nombre_usuario) AS responsable_nombre,
               cierre.nombre_usuario AS usuario_cierre,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_cierre.nombre, per_cierre.apellido)), ''), cierre.nombre_usuario) AS usuario_cierre_nombre,
               (cc.fecha_creacion + INTERVAL '30 minutes') AS editable_hasta,
               (NOW() <= (cc.fecha_creacion + INTERVAL '30 minutes')) AS editable_en_ventana
        FROM public.vw_cajas_cierres_resumen vw
        INNER JOIN public.cajas_cierres cc ON cc.id_cierre_caja = vw.id_cierre_caja
        INNER JOIN public.cajas c ON c.id_caja = vw.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = vw.id_sucursal
        INNER JOIN public.usuarios resp ON resp.id_usuario = vw.id_usuario_responsable
        LEFT JOIN public.empleados e_resp ON e_resp.id_empleado = resp.id_empleado
        LEFT JOIN public.personas per_resp ON per_resp.id_persona = e_resp.id_persona
        INNER JOIN public.usuarios cierre ON cierre.id_usuario = vw.id_usuario_cierre
        LEFT JOIN public.empleados e_cierre ON e_cierre.id_empleado = cierre.id_empleado
        LEFT JOIN public.personas per_cierre ON per_cierre.id_persona = e_cierre.id_persona
        ${whereClause}
        ORDER BY vw.fecha_cierre DESC, vw.id_cierre_caja DESC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_REPORT_CLOSES_ERROR', 'No se pudo generar el reporte de cierres.');
  }
});

router.post('/ventas/cajas/sesiones/:id/participantes', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idUsuarioParticipante = parsePositiveInt(req.body.id_usuario);
    const roleCode = normalizeText(req.body.rol_codigo || 'AUXILIAR', 30)?.toUpperCase();
    const observacion = normalizeText(req.body.observacion, 300);
    if (!idSesionCaja || !idUsuarioParticipante) throw createCajaError(400, 'VENTAS_CAJAS_PARTICIPANT_DATA_INVALID', 'Debe indicar una sesion y un usuario validos.');
    if (!['AUXILIAR', 'RESPONSABLE'].includes(roleCode)) throw createCajaError(400, 'VENTAS_CAJAS_PARTICIPANT_ROLE_INVALID', 'El rol de participacion es invalido.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    if (!(await requestHasAnyRole(req, ADMIN_ROLE_CODES)) && Number(session.id_usuario_responsable) !== Number(scopeContext.idUsuario)) {
      throw createCajaError(403, 'VENTAS_CAJAS_PARTICIPANT_ASSIGN_FORBIDDEN', 'Solo el responsable de la sesion o un administrador puede gestionar participantes.');
    }
    if (Number(session.id_usuario_responsable) === Number(idUsuarioParticipante) && roleCode !== 'RESPONSABLE') {
      throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_DUPLICATE', 'El responsable de la sesion no puede agregarse como auxiliar.');
    }
    if (roleCode === 'RESPONSABLE') {
      throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_ALREADY_DEFINED', 'La sesion ya tiene un responsable asignado.');
    }
    await assertCajaAuthorization(client, session.id_caja, idUsuarioParticipante, roleCode);

    const duplicateResult = await client.query(
      `SELECT id_participacion_caja FROM public.cajas_sesiones_participantes WHERE id_sesion_caja = $1 AND id_usuario = $2 AND COALESCE(activo, true) = true LIMIT 1`,
      [idSesionCaja, idUsuarioParticipante]
    );
    if (duplicateResult.rowCount > 0) throw createCajaError(409, 'VENTAS_CAJAS_PARTICIPANT_DUPLICATE', 'El usuario ya participa activamente en esta sesion.');

    const idRolParticipacion = await getCatalogId(client, 'PARTICIPATION_ROLES', roleCode);
    const insertResult = await client.query(
      `
        INSERT INTO public.cajas_sesiones_participantes (
          id_sesion_caja, id_usuario, id_rol_participacion_caja, fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1, $2, $3, NOW(), true, $4, NOW(), NOW())
        RETURNING id_participacion_caja
      `,
      [idSesionCaja, idUsuarioParticipante, idRolParticipacion, observacion]
    );

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Participante agregado correctamente a la sesion.', id_participacion_caja: Number(insertResult.rows[0].id_participacion_caja) });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_PARTICIPANT_CREATE_ERROR', 'No se pudo agregar el participante a la sesion.');
  } finally {
    client.release();
  }
});

router.post('/ventas/cajas/sesiones/:id/auto-auxiliar', checkPermission(['VENTAS_CREAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idSucursal = parsePositiveInt(req.body?.id_sucursal);
    if (!idSesionCaja || !idSucursal) {
      throw createCajaError(400, 'VENTAS_CAJAS_AUTO_AUXILIAR_DATA_INVALID', 'Debe indicar una sesion de caja e id_sucursal validos.');
    }
    if (!(await requestIsSuperAdminReal(client, req))) {
      throw createCajaError(403, 'VENTAS_CAJAS_ROLE_FORBIDDEN', 'Accion exclusiva para SUPER_ADMIN.');
    }

    const scopeContext = await getScopeContext(req, client, idSucursal, true);
    assertSucursalAllowed(scopeContext, idSucursal);
    const idUsuario = parsePositiveInt(scopeContext.idUsuario);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    if (!parseBooleanish(session.caja_estado)) {
      throw createCajaError(409, 'VENTAS_CAJAS_CAJA_INACTIVA', 'La caja de la sesion seleccionada no esta activa.');
    }
    if (Number(session.id_sucursal) !== Number(idSucursal)) {
      throw createCajaError(409, 'VENTAS_CAJAS_SCOPE_MISMATCH', 'La caja seleccionada no pertenece a la sucursal de la venta.');
    }

    const roleAuxiliarId = await getCatalogId(client, 'PARTICIPATION_ROLES', 'AUXILIAR');
    if (!roleAuxiliarId) {
      throw createCajaError(409, 'VENTAS_CAJAS_AUXILIAR_ROLE_NOT_FOUND', 'No se encontro el rol operativo AUXILIAR.');
    }

    const existingResult = await client.query(
      `
        SELECT csp.id_participacion_caja, csp.id_rol_participacion_caja, crp.codigo AS rol_codigo
        FROM public.cajas_sesiones_participantes csp
        INNER JOIN public.cat_cajas_roles_participacion crp ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
        WHERE csp.id_sesion_caja = $1
          AND csp.id_usuario = $2
          AND COALESCE(csp.activo, true) = true
        LIMIT 1
        FOR UPDATE
      `,
      [idSesionCaja, idUsuario]
    );

    if (existingResult.rowCount === 0) {
      const inactiveResult = await client.query(
        `
          SELECT id_participacion_caja
          FROM public.cajas_sesiones_participantes
          WHERE id_sesion_caja = $1
            AND id_usuario = $2
            AND COALESCE(activo, true) = false
          ORDER BY id_participacion_caja DESC
          LIMIT 1
          FOR UPDATE
        `,
        [idSesionCaja, idUsuario]
      );
      if (inactiveResult.rowCount > 0) {
        await client.query(
          `
            UPDATE public.cajas_sesiones_participantes
            SET id_rol_participacion_caja = $1,
                fecha_inicio = NOW(),
                fecha_fin = NULL,
                activo = true,
                observacion = $2,
                fecha_actualizacion = NOW()
            WHERE id_participacion_caja = $3
          `,
          [roleAuxiliarId, 'Autoasignacion operativa desde modulo de ventas para procesar venta.', inactiveResult.rows[0].id_participacion_caja]
        );
      } else {
        await client.query(
          `
            INSERT INTO public.cajas_sesiones_participantes (
              id_sesion_caja, id_usuario, id_rol_participacion_caja, fecha_inicio, activo, observacion, fecha_creacion, fecha_actualizacion
            )
            VALUES ($1, $2, $3, NOW(), true, $4, NOW(), NOW())
          `,
          [idSesionCaja, idUsuario, roleAuxiliarId, 'Autoasignacion operativa desde modulo de ventas para procesar venta.']
        );
      }
    }

    await client.query('COMMIT');
    return res.status(200).json({
      id_sesion_caja: session.id_sesion_caja,
      id_caja: session.id_caja,
      id_sucursal: session.id_sucursal,
      codigo_caja: session.codigo_caja,
      nombre_caja: session.nombre_caja,
      rol_codigo: 'AUXILIAR'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_AUTO_AUXILIAR_ERROR', 'No se pudo registrar la autoasignacion temporal.');
  } finally {
    client.release();
  }
});

const inactivateParticipantHandler = async ({ req, res, byUserId = false }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const targetId = byUserId ? parsePositiveInt(req.params.idUsuarioParticipante) : parsePositiveInt(req.params.id_participante);
    if (!idSesionCaja || !targetId) throw createCajaError(400, 'VENTAS_CAJAS_PARTICIPANT_ID_INVALID', 'El participante indicado no es valido.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    if (!(await requestHasAnyRole(req, ADMIN_ROLE_CODES)) && Number(session.id_usuario_responsable) !== Number(scopeContext.idUsuario)) {
      throw createCajaError(403, 'VENTAS_CAJAS_PARTICIPANT_REMOVE_FORBIDDEN', 'Solo el responsable de la sesion o un administrador puede inactivar participantes.');
    }

    const participantResult = await client.query(
      `
        SELECT id_participacion_caja, id_usuario, activo
        FROM public.cajas_sesiones_participantes
        WHERE id_sesion_caja = $1 AND ${byUserId ? 'id_usuario = $2' : 'id_participacion_caja = $2'}
        LIMIT 1 FOR UPDATE
      `,
      [idSesionCaja, targetId]
    );
    if (participantResult.rowCount === 0) throw createCajaError(404, 'VENTAS_CAJAS_PARTICIPANT_NOT_FOUND', 'El participante indicado no existe en la sesion.');

    const participant = participantResult.rows[0];
    if (!parseBooleanish(participant.activo)) throw createCajaError(409, 'VENTAS_CAJAS_PARTICIPANT_ALREADY_INACTIVE', 'El participante ya se encuentra inactivo.');
    if (Number(participant.id_usuario) === Number(session.id_usuario_responsable)) {
      throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_CANNOT_BE_REMOVED', 'No se puede inactivar al responsable de la sesion mientras permanezca abierta.');
    }

    await client.query(
      `UPDATE public.cajas_sesiones_participantes SET activo = false, fecha_fin = NOW(), fecha_actualizacion = NOW() WHERE id_participacion_caja = $1`,
      [participant.id_participacion_caja]
    );
    await client.query('COMMIT');
    return res.status(200).json({ message: 'Participante inactivado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_PARTICIPANT_INACTIVATE_ERROR', 'No se pudo inactivar el participante.');
  } finally {
    client.release();
  }
};

router.patch('/ventas/cajas/sesiones/:id/participantes/:id_participante/inactivar', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), (req, res) => inactivateParticipantHandler({ req, res, byUserId: false }));
router.put('/ventas/cajas/sesiones/:id/participantes/:idUsuarioParticipante', checkPermission(['VENTAS_CAJAS_PARTICIPANTES_GESTIONAR']), (req, res) => inactivateParticipantHandler({ req, res, byUserId: true }));

router.post('/ventas/cajas/sesiones/:id/arqueos', checkPermission(['VENTAS_CAJAS_ARQUEO_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idTipoArqueoCaja = parsePositiveInt(req.body.id_tipo_arqueo_caja);
    const montoContado = parseNonNegativeAmount(req.body.monto_contado);
    const observacion = normalizeText(req.body.observacion, 500);
    const detalleBilletes = Array.isArray(req.body.detalle_billetes) ? req.body.detalle_billetes : [];
    if (!idSesionCaja || !idTipoArqueoCaja) throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_DATA_INVALID', 'Debe indicar una sesion y un tipo de arqueo validos.');
    if (montoContado === null) throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_AMOUNT_INVALID', 'monto_contado debe ser un numero mayor o igual a 0.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja);
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });
    const tipoArqueoCode = await getCatalogCodeById(client, 'ARQUEO_TYPES', idTipoArqueoCaja);
    if (!ALLOWED_NEW_ARQUEO_CODES.has(tipoArqueoCode)) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_ARQUEO_TYPE_INVALID',
        'Solo se permiten arqueos de cierre o extraordinarios.'
      );
    }

    const resumenResult = await client.query(`SELECT efectivo_teorico FROM public.vw_cajas_sesiones_resumen WHERE id_sesion_caja = $1 LIMIT 1`, [idSesionCaja]);
    const montoTeorico = Number(resumenResult.rows?.[0]?.efectivo_teorico || 0);
    const diferencia = Number((montoContado - montoTeorico).toFixed(2));
    const insertArqueo = await client.query(
      `
        INSERT INTO public.cajas_arqueos (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_arqueo_caja, id_usuario_ejecutor,
          monto_teorico, monto_contado, diferencia, observacion, fecha_arqueo, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        RETURNING id_arqueo_caja
      `,
      [idSesionCaja, session.id_caja, session.id_sucursal, idTipoArqueoCaja, scopeContext.idUsuario, montoTeorico, montoContado, diferencia, observacion]
    );

    const idArqueoCaja = Number(insertArqueo.rows[0].id_arqueo_caja);
    for (const row of detalleBilletes) {
      const denominacion = Number(row?.denominacion);
      const cantidad = Number(row?.cantidad);
      if (!Number.isFinite(denominacion) || !Number.isFinite(cantidad) || cantidad < 0) continue;
      await client.query(
        `INSERT INTO public.cajas_arqueos_detalle (id_arqueo_caja, denominacion, cantidad, fecha_creacion) VALUES ($1, $2, $3, NOW())`,
        [idArqueoCaja, denominacion, cantidad]
      );
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Arqueo registrado correctamente.', id_arqueo_caja: idArqueoCaja });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_ARQUEO_CREATE_ERROR', 'No se pudo registrar el arqueo.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/sesiones/:id/arqueos', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, pool, null, true);
    const session = await fetchSessionBase(pool, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const result = await pool.query(`SELECT a.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre FROM public.cajas_arqueos a INNER JOIN public.cat_cajas_arqueos_tipos tipo ON tipo.id_tipo_arqueo_caja = a.id_tipo_arqueo_caja WHERE a.id_sesion_caja = $1 ORDER BY a.fecha_arqueo DESC, a.id_arqueo_caja DESC`, [idSesionCaja]);
    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_ARQUEO_LIST_ERROR', 'No se pudieron obtener los arqueos de la sesion.');
  }
});

router.post('/ventas/cajas/sesiones/:id/movimientos', checkPermission(['VENTAS_CAJAS_MOVIMIENTO_MANUAL_REGISTRAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idTipoMovimientoCaja = parsePositiveInt(req.body.id_tipo_movimiento_caja);
    const monto = parseNonNegativeAmount(req.body.monto);
    const observacion = normalizeText(req.body.observacion, 500);
    const referencia = normalizeText(req.body.referencia, 120);
    if (!idSesionCaja || !idTipoMovimientoCaja) throw createCajaError(400, 'VENTAS_CAJAS_MOVEMENT_DATA_INVALID', 'Debe indicar una sesion y un tipo de movimiento validos.');
    if (monto === null || monto <= 0) throw createCajaError(400, 'VENTAS_CAJAS_MOVEMENT_AMOUNT_INVALID', 'monto debe ser un numero mayor a 0.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja);
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });

    const insertResult = await client.query(
      `
        INSERT INTO public.cajas_movimientos (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_movimiento_caja,
          id_usuario_ejecutor, monto, observacion, referencia, fecha_movimiento, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING id_movimiento_caja
      `,
      [idSesionCaja, session.id_caja, session.id_sucursal, idTipoMovimientoCaja, scopeContext.idUsuario, monto, observacion, referencia]
    );

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Movimiento manual registrado correctamente.', id_movimiento_caja: Number(insertResult.rows[0].id_movimiento_caja) });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_MOVEMENT_CREATE_ERROR', 'No se pudo registrar el movimiento manual.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/sesiones/:id/movimientos', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, pool, null, true);
    const session = await fetchSessionBase(pool, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const result = await pool.query(`SELECT m.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre FROM public.cajas_movimientos m INNER JOIN public.cat_cajas_movimientos_tipos tipo ON tipo.id_tipo_movimiento_caja = m.id_tipo_movimiento_caja WHERE m.id_sesion_caja = $1 ORDER BY m.fecha_movimiento DESC, m.id_movimiento_caja DESC`, [idSesionCaja]);
    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_MOVEMENT_LIST_ERROR', 'No se pudieron obtener los movimientos de la sesion.');
  }
});

router.post('/ventas/cajas/sesiones/:id/incidencias', checkPermission(['VENTAS_CAJAS_INCIDENCIA_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idSesionCaja = parsePositiveInt(req.params.id);
    const idTipoIncidenciaCaja = parsePositiveInt(req.body.id_tipo_incidencia_caja);
    const montoRelacionado = parseNonNegativeAmount(req.body.monto_relacionado ?? 0);
    const descripcion = normalizeText(req.body.descripcion, 1000);
    if (!idSesionCaja || !idTipoIncidenciaCaja || !descripcion) throw createCajaError(400, 'VENTAS_CAJAS_INCIDENT_DATA_INVALID', 'Debe indicar una sesion, un tipo de incidencia y una descripcion valida.');

    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await fetchSessionBase(client, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    await ensureSessionParticipant(client, idSesionCaja, scopeContext.idUsuario, { allowAdminBypass: true, req, scopeContext });

    const idEstadoAbierta = await getCatalogId(client, 'INCIDENT_STATES', 'ABIERTA');
    const insertResult = await client.query(
      `
        INSERT INTO public.cajas_incidencias (
          id_sesion_caja, id_caja, id_sucursal, id_tipo_incidencia_caja, id_estado_incidencia_caja,
          id_usuario_reporta, id_usuario_responsable, monto_relacionado, descripcion,
          fecha_incidencia, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
        RETURNING id_incidencia_caja
      `,
      [idSesionCaja, session.id_caja, session.id_sucursal, idTipoIncidenciaCaja, idEstadoAbierta, scopeContext.idUsuario, session.id_usuario_responsable, montoRelacionado, descripcion]
    );

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Incidencia registrada correctamente.', id_incidencia_caja: Number(insertResult.rows[0].id_incidencia_caja) });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_INCIDENT_CREATE_ERROR', 'No se pudo registrar la incidencia.');
  } finally {
    client.release();
  }
});

router.get('/ventas/cajas/sesiones/:id/incidencias', checkPermission(['VENTAS_CAJAS_DETALLE_VER', 'VENTAS_CAJAS_REPORTE_VER']), async (req, res) => {
  try {
    const idSesionCaja = parsePositiveInt(req.params.id);
    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    const scopeContext = await getScopeContext(req, pool, null, true);
    const session = await fetchSessionBase(pool, idSesionCaja);
    if (!session) throw createCajaError(404, 'VENTAS_CAJAS_SESSION_NOT_FOUND', 'La sesion de caja no existe.');
    assertSucursalAllowed(scopeContext, session.id_sucursal);
    const result = await pool.query(`SELECT i.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre, estado.codigo AS estado_codigo, estado.nombre AS estado_nombre FROM public.cajas_incidencias i INNER JOIN public.cat_cajas_incidencias_tipos tipo ON tipo.id_tipo_incidencia_caja = i.id_tipo_incidencia_caja INNER JOIN public.cat_cajas_incidencias_estados estado ON estado.id_estado_incidencia_caja = i.id_estado_incidencia_caja WHERE i.id_sesion_caja = $1 ORDER BY i.fecha_incidencia DESC, i.id_incidencia_caja DESC`, [idSesionCaja]);
    return res.status(200).json(result.rows);
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_INCIDENT_LIST_ERROR', 'No se pudieron obtener las incidencias de la sesion.');
  }
});

router.patch('/ventas/cajas/incidencias/:id', checkPermission(['VENTAS_CAJAS_INCIDENCIA_GESTIONAR']), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idIncidenciaCaja = parsePositiveInt(req.params.id);
    const idEstadoIncidenciaCaja = parseNullablePositiveInt(req.body.id_estado_incidencia_caja);
    const resolucionTexto = normalizeText(req.body.resolucion_texto, 1000);
    if (!idIncidenciaCaja) throw createCajaError(400, 'VENTAS_CAJAS_INCIDENT_ID_INVALID', 'El id de incidencia es invalido.');
    if (!idEstadoIncidenciaCaja && !resolucionTexto) throw createCajaError(400, 'VENTAS_CAJAS_INCIDENT_UPDATE_EMPTY', 'Debe enviar al menos un cambio para la incidencia.');

    const incidentResult = await client.query(`SELECT id_incidencia_caja, id_sucursal FROM public.cajas_incidencias WHERE id_incidencia_caja = $1 LIMIT 1 FOR UPDATE`, [idIncidenciaCaja]);
    if (incidentResult.rowCount === 0) throw createCajaError(404, 'VENTAS_CAJAS_INCIDENT_NOT_FOUND', 'La incidencia indicada no existe.');

    const scopeContext = await getScopeContext(req, client, null, true);
    assertSucursalAllowed(scopeContext, incidentResult.rows[0].id_sucursal);

    const updates = [];
    const params = [];
    if (idEstadoIncidenciaCaja) {
      params.push(idEstadoIncidenciaCaja);
      updates.push(`id_estado_incidencia_caja = $${params.length}`);
    }
    if (resolucionTexto) {
      params.push(resolucionTexto);
      updates.push(`resolucion_texto = $${params.length}`);
      updates.push('fecha_resolucion = NOW()');
    }
    updates.push('fecha_actualizacion = NOW()');
    params.push(idIncidenciaCaja);

    await client.query(`UPDATE public.cajas_incidencias SET ${updates.join(', ')} WHERE id_incidencia_caja = $${params.length}`, params);
    await client.query('COMMIT');
    return res.status(200).json({ message: 'Incidencia actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_INCIDENT_UPDATE_ERROR', 'No se pudo actualizar la incidencia.');
  } finally {
    client.release();
  }
});

export default router;

