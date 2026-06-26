import { parsePositiveBigIntId } from './cajaFinancialLockService.js';

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const createCajaSessionWriteError = (httpStatus, code, message) => {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  error.publicMessage = message;
  return error;
};

export const validateCajaSessionOpenForFinancialWrite = async ({
  client,
  idSesionCaja,
  idSucursal,
  idUsuario
}) => {
  const sessionId = parsePositiveBigIntId(idSesionCaja);
  const sucursalId = parsePositiveInt(idSucursal);
  const userId = parsePositiveInt(idUsuario);

  if (!sessionId || !sucursalId || !userId) {
    throw createCajaSessionWriteError(
      400,
      'VENTAS_CAJA_SESSION_CONTEXT_INVALID',
      'No se pudo validar la sesion de caja para registrar la operacion.'
    );
  }

  const result = await client.query(
    `
      WITH estado_abierta AS (
        SELECT id_estado_sesion_caja
        FROM public.cat_cajas_sesiones_estados
        WHERE UPPER(TRIM(codigo)) = 'ABIERTA'
        LIMIT 1
      )
      SELECT
        cs.id_caja,
        cs.id_sesion_caja,
        cs.id_sucursal,
        csp.id_participacion_caja,
        COALESCE(crp.codigo, CASE WHEN cs.id_usuario_responsable = $3 THEN 'RESPONSABLE' END) AS rol_participacion
      FROM public.cajas_sesiones cs
      INNER JOIN estado_abierta ea
        ON ea.id_estado_sesion_caja = cs.id_estado_sesion_caja
      INNER JOIN public.cajas c
        ON c.id_caja = cs.id_caja
       AND c.id_sucursal = cs.id_sucursal
       AND COALESCE(c.estado, true) = true
      LEFT JOIN public.cajas_sesiones_participantes csp
        ON csp.id_sesion_caja = cs.id_sesion_caja
       AND csp.id_usuario = $3
       AND COALESCE(csp.activo, true) = true
      LEFT JOIN public.cat_cajas_roles_participacion crp
        ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
      WHERE cs.id_sesion_caja = $1
        AND cs.id_sucursal = $2
        AND (
          cs.id_usuario_responsable = $3
          OR csp.id_participacion_caja IS NOT NULL
        )
      LIMIT 1
      FOR UPDATE OF cs
    `,
    [sessionId, sucursalId, userId]
  );

  if (result.rowCount > 0) {
    return result.rows[0];
  }

  const reasonResult = await client.query(
    `
      SELECT
        cs.id_sesion_caja,
        cs.id_sucursal,
        estado.codigo AS estado_codigo,
        COALESCE(c.estado, true) AS caja_activa,
        (cs.id_usuario_responsable = $2) AS is_responsible,
        EXISTS (
          SELECT 1
          FROM public.cajas_sesiones_participantes csp
          WHERE csp.id_sesion_caja = cs.id_sesion_caja
            AND csp.id_usuario = $2
            AND COALESCE(csp.activo, true) = true
        ) AS has_active_participation
      FROM public.cajas_sesiones cs
      LEFT JOIN public.cat_cajas_sesiones_estados estado
        ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
      LEFT JOIN public.cajas c
        ON c.id_caja = cs.id_caja
       AND c.id_sucursal = cs.id_sucursal
      WHERE cs.id_sesion_caja = $1
      LIMIT 1
      FOR UPDATE OF cs
    `,
    [sessionId, userId]
  );
  const session = reasonResult.rows?.[0] || null;

  if (!session) {
    throw createCajaSessionWriteError(
      404,
      'VENTAS_CAJA_SESSION_NOT_FOUND',
      'La sesion de caja seleccionada no existe.'
    );
  }

  if (Number(session.id_sucursal || 0) !== sucursalId) {
    throw createCajaSessionWriteError(
      409,
      'VENTAS_CAJA_SESSION_SCOPE_MISMATCH',
      'La sesion de caja no pertenece a la sucursal de la operacion.'
    );
  }

  if (String(session.estado_codigo || '').trim().toUpperCase() !== 'ABIERTA') {
    throw createCajaSessionWriteError(
      409,
      'VENTAS_CAJA_SESSION_CLOSED',
      'La sesion de caja fue cerrada antes de registrar la operacion.'
    );
  }

  if (!Boolean(session.caja_activa)) {
    throw createCajaSessionWriteError(
      409,
      'VENTAS_CAJA_NOT_ACTIVE',
      'La caja de la sesion no esta activa.'
    );
  }

  if (!Boolean(session.is_responsible) && !Boolean(session.has_active_participation)) {
    throw createCajaSessionWriteError(
      403,
      'VENTAS_CAJA_SESSION_PARTICIPATION_REQUIRED',
      'El usuario no participa activamente en la sesion de caja seleccionada.'
    );
  }

  throw createCajaSessionWriteError(
    403,
    'VENTAS_CAJA_SESSION_AUTHORIZATION_REQUIRED',
    'El usuario no esta autorizado para operar la sesion de caja seleccionada.'
  );
};
