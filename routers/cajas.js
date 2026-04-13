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

const normalizeText = (value, maxLength = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const parseBooleanish = (value) =>
  value === true || value === 'true' || value === 1 || value === '1';

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
  const isAllowed = await requestHasAnyRole(req, ['ADMIN', 'SUPER_ADMIN']);
  if (!isAllowed) {
    throw createCajaError(403, 'VENTAS_CAJAS_ROLE_FORBIDDEN', 'Accion exclusiva para ADMIN o SUPER_ADMIN.');
  }
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
      SELECT cs.*, c.codigo_caja, c.nombre_caja, s.nombre_sucursal,
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

  if (allowAdminBypass && req && (await requestHasAnyRole(req, ['ADMIN', 'SUPER_ADMIN']))) {
    return null;
  }

  throw createCajaError(403, 'VENTAS_CAJAS_PARTICIPANT_REQUIRED', 'El usuario autenticado no participa activamente en la sesion de caja.');
};

const buildSessionDetailPayload = async (client, session) => {
  const [responsableResult, participantesResult, cobrosResult, arqueosResult, movimientosResult, incidenciasResult, cierreResult, resumenResult] =
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
          SELECT i.*, tipo.codigo AS tipo_codigo, tipo.nombre AS tipo_nombre,
                 estado.codigo AS estado_codigo, estado.nombre AS estado_nombre
          FROM public.cajas_incidencias i
          INNER JOIN public.cat_cajas_incidencias_tipos tipo ON tipo.id_tipo_incidencia_caja = i.id_tipo_incidencia_caja
          INNER JOIN public.cat_cajas_incidencias_estados estado ON estado.id_estado_incidencia_caja = i.id_estado_incidencia_caja
          WHERE i.id_sesion_caja = $1
          ORDER BY i.fecha_incidencia DESC, i.id_incidencia_caja DESC
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

  const cobrosPorUsuario = cobrosResult.rows;
  const totalResponsable = cobrosPorUsuario
    .filter((row) => Number(row.id_usuario_ejecutor) === Number(session.id_usuario_responsable))
    .reduce((sum, row) => sum + Number(row.total_cobrado || 0), 0);
  const totalAuxiliares = cobrosPorUsuario
    .filter((row) => Number(row.id_usuario_ejecutor) !== Number(session.id_usuario_responsable))
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
      responsabilidad_final_id_usuario: Number(session.id_usuario_responsable)
    },
    arqueos: arqueosResult.rows,
    movimientos: movimientosResult.rows,
    incidencias: incidenciasResult.rows,
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

    const [cajas, estados, roles, movimientos, metodosPago, resoluciones, tiposArqueo, tiposIncidencia, estadosIncidencia] =
      await Promise.all([
        pool.query(`SELECT id_caja, id_sucursal, codigo_caja, nombre_caja, estado FROM public.cajas c WHERE ${cajasFilters.join(' AND ')} ORDER BY c.id_sucursal ASC, c.nombre_caja ASC`, cajasParams),
        pool.query(`SELECT * FROM public.cat_cajas_sesiones_estados WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_roles_participacion WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_movimientos_tipos WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_metodos_pago WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_resoluciones_cierre WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_arqueos_tipos WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_incidencias_tipos WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`),
        pool.query(`SELECT * FROM public.cat_cajas_incidencias_estados WHERE COALESCE(estado, true) = true ORDER BY nombre ASC`)
      ]);

    return res.status(200).json({
      cajas: cajas.rows,
      estados_sesion: estados.rows,
      roles_participacion: roles.rows,
      tipos_movimiento: movimientos.rows,
      metodos_pago: metodosPago.rows,
      resoluciones_cierre: resoluciones.rows,
      tipos_arqueo: tiposArqueo.rows,
      incidencias_tipos: tiposIncidencia.rows,
      incidencias_estados: estadosIncidencia.rows
    });
  } catch (err) {
    return sendInternalError(res, err, 'VENTAS_CAJAS_CATALOGS_ERROR', 'No se pudieron obtener los catalogos de Gestion de cajas.');
  }
});

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

const openSessionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idCaja = parsePositiveInt(req.body.id_caja);
    const montoApertura = parseNonNegativeAmount(req.body.monto_apertura ?? 0);
    const observacionApertura = normalizeText(req.body.observacion_apertura, 500);
    const requestedResponsableId = parseNullablePositiveInt(req.body.id_usuario_responsable);
    if (!idCaja) throw createCajaError(400, 'VENTAS_CAJAS_CAJA_REQUIRED', 'Debe indicar una caja valida.');
    if (montoApertura === null) throw createCajaError(400, 'VENTAS_CAJAS_APERTURA_AMOUNT_INVALID', 'monto_apertura debe ser un numero mayor o igual a 0.');

    const scopeContext = await getScopeContext(req, client);
    const caja = await fetchCajaById(client, idCaja);
    if (!caja || !parseBooleanish(caja.estado)) throw createCajaError(404, 'VENTAS_CAJAS_CAJA_NOT_FOUND', 'La caja seleccionada no existe.');
    assertSucursalAllowed(scopeContext, caja.id_sucursal);

    const responsableId = requestedResponsableId || scopeContext.idUsuario;
    await assertCajaAuthorization(client, idCaja, responsableId, 'RESPONSABLE');

    const idEstadoAbierta = await getCatalogId(client, 'SESSION_STATES', 'ABIERTA');
    const openSessionResult = await client.query(
      `SELECT id_sesion_caja FROM public.cajas_sesiones WHERE id_caja = $1 AND id_estado_sesion_caja = $2 LIMIT 1 FOR UPDATE`,
      [idCaja, idEstadoAbierta]
    );
    if (openSessionResult.rowCount > 0) throw createCajaError(409, 'VENTAS_CAJAS_SESSION_ALREADY_OPEN', 'La caja ya tiene una sesion abierta.');

    const responsibleOpenSessionResult = await client.query(
      `SELECT cs.id_sesion_caja FROM public.cajas_sesiones cs WHERE cs.id_usuario_responsable = $1 AND cs.id_estado_sesion_caja = $2 LIMIT 1`,
      [responsableId, idEstadoAbierta]
    );
    if (responsibleOpenSessionResult.rowCount > 0) throw createCajaError(409, 'VENTAS_CAJAS_RESPONSABLE_BUSY', 'El responsable ya tiene una sesion de caja abierta.');

    const idRolResponsable = await getCatalogId(client, 'PARTICIPATION_ROLES', 'RESPONSABLE');
    const idTipoApertura = await getCatalogId(client, 'MOVEMENT_TYPES', 'APERTURA');
    const insertSession = await client.query(
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

    const idSesionCaja = Number(insertSession.rows[0].id_sesion_caja);
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
    const montoDeclaradoCierre = parseNonNegativeAmount(req.body.monto_declarado_cierre);
    const observacionCierre = normalizeText(req.body.observacion_cierre, 500);
    const idResolucion = parseNullablePositiveInt(req.body.id_resolucion_cierre_caja);
    const idArqueoFinal = parseNullablePositiveInt(req.body.id_arqueo_final);

    if (!idSesionCaja) throw createCajaError(400, 'VENTAS_CAJAS_SESSION_ID_INVALID', 'El id de sesion es invalido.');
    if (montoDeclaradoCierre === null) throw createCajaError(400, 'VENTAS_CAJAS_CLOSE_AMOUNT_INVALID', 'monto_declarado_cierre debe ser un numero mayor o igual a 0.');

    await ensureAdminOrSuperAdmin(req);
    const scopeContext = await getScopeContext(req, client, null, true);
    const session = await ensureOpenSession(client, idSesionCaja, { forUpdate: true });
    assertSucursalAllowed(scopeContext, session.id_sucursal);

    const resumenResult = await client.query(`SELECT * FROM public.vw_cajas_sesiones_resumen WHERE id_sesion_caja = $1 LIMIT 1`, [idSesionCaja]);
    const resumen = resumenResult.rows[0];
    if (!resumen) throw createCajaError(409, 'VENTAS_CAJAS_CLOSE_SUMMARY_ERROR', 'No se pudo calcular el resumen operativo de la sesion.');

    const montoTeorico = Number(resumen.efectivo_teorico || 0);
    const diferencia = Number((montoDeclaradoCierre - montoTeorico).toFixed(2));

    if (Math.abs(diferencia) > 0 && !idResolucion) {
      throw createCajaError(400, 'VENTAS_CAJAS_RESOLUTION_REQUIRED', 'Debe seleccionar una resolucion de cierre cuando existe diferencia.');
    }
    if (Math.abs(diferencia) > 0 && !(await requestHasAnyPermission(req, 'VENTAS_CAJAS_DIFERENCIA_RESOLVER'))) {
      throw createCajaError(403, 'VENTAS_CAJAS_DIFFERENCE_FORBIDDEN', 'No tiene permiso para resolver diferencias de cierre.');
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
        idResolucion, idArqueoFinal, Number(session.monto_apertura || 0), Number(resumen.ventas_efectivo || 0),
        Number(resumen.ventas_no_efectivo || 0), Number(resumen.ingresos_manuales || 0), Number(resumen.egresos_manuales || 0),
        montoTeorico, montoDeclaradoCierre, diferencia, observacionCierre
      ]
    );

    await client.query(
      `
        UPDATE public.cajas_sesiones
        SET id_estado_sesion_caja = $1, id_usuario_cierre = $2, fecha_cierre = NOW(),
            monto_teorico_cierre = $3, monto_declarado_cierre = $4, diferencia_cierre = $5,
            id_resolucion_cierre_caja = $6, observacion_cierre = $7, fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $8
      `,
      [idEstadoCerrada, scopeContext.idUsuario, montoTeorico, montoDeclaradoCierre, diferencia, idResolucion, observacionCierre, idSesionCaja]
    );

    await client.query(
      `
        UPDATE public.cajas_sesiones_participantes
        SET activo = false, fecha_fin = NOW(), fecha_actualizacion = NOW()
        WHERE id_sesion_caja = $1 AND COALESCE(activo, true) = true
      `,
      [idSesionCaja]
    );

    await client.query('COMMIT');
    return res.status(200).json({ message: 'Cierre de caja registrado correctamente.', id_cierre_caja: Number(closeResult.rows[0].id_cierre_caja), diferencia });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendInternalError(res, err, 'VENTAS_CAJAS_CLOSE_ERROR', 'No se pudo cerrar la sesion de caja.');
  } finally {
    client.release();
  }
};

router.patch('/ventas/cajas/sesiones/:id/cerrar', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), closeSessionHandler);
router.post('/ventas/cajas/sesiones/:id/cerrar', checkPermission(['VENTAS_CAJAS_SESION_CERRAR']), closeSessionHandler);

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
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_cierre.nombre, per_cierre.apellido)), ''), cierre.nombre_usuario) AS usuario_cierre_nombre
        FROM public.vw_cajas_cierres_resumen vw
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
    if (!(await requestHasAnyRole(req, ['ADMIN', 'SUPER_ADMIN'])) && Number(session.id_usuario_responsable) !== Number(scopeContext.idUsuario)) {
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
    if (!(await requestHasAnyRole(req, ['ADMIN', 'SUPER_ADMIN'])) && Number(session.id_usuario_responsable) !== Number(scopeContext.idUsuario)) {
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
