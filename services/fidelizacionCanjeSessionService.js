// Resolucion de sesion de caja para canjes presenciales de fidelizacion
// (Fase 4, seccion 3.8 del ticket). Todo canje presencial nuevo requiere
// id_sesion_caja obligatorio para auditoria -- nunca se infiere por fecha
// ni se deja NULL para canjes nuevos (los canjes historicos anteriores a
// esta fase siguen siendo legibles con NULL, ver
// sql/20260728_fidelizacion_canjes_sesion_caja_SAFE.sql).
//
// Cajero (sin acceso multisucursal): se resuelve su UNICA sesion ABIERTA
// en la sucursal, donde el sea responsable o participante activo. 0
// sesiones -> FIDELIZACION_CANJE_SESSION_REQUIRED. 2+ -> ambigua
// (FIDELIZACION_CANJE_SESSION_AMBIGUOUS): nunca se elige "la primera" por
// id o fecha.
//
// Administrador/Super Admin (con acceso multisucursal): puede enviar
// id_sesion_caja explicito (se valida que pertenezca a la sucursal
// seleccionada y este ABIERTA -> FIDELIZACION_CANJE_SESSION_INVALID si
// no). Si no lo envia: una sola sesion abierta en la sucursal -> se
// selecciona automaticamente; 2+ -> FIDELIZACION_CANJE_SESSION_SELECTION_REQUIRED
// (el frontend debe pedir que elija); 0 -> FIDELIZACION_CANJE_SESSION_REQUIRED.
const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const createCanjeSessionError = (status, code, message) => {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const OPEN_SESSION_JOIN = `
  FROM public.cajas_sesiones cs
  INNER JOIN public.cat_cajas_sesiones_estados cse
    ON cse.id_estado_sesion_caja = cs.id_estado_sesion_caja
  LEFT JOIN public.cajas c
    ON c.id_caja = cs.id_caja
   AND c.id_sucursal = cs.id_sucursal
  WHERE cs.id_sucursal = $1
    AND cs.fecha_cierre IS NULL
    AND UPPER(TRIM(cse.codigo)) = 'ABIERTA'
    AND COALESCE(c.estado, true) = true
`;

const fetchUserOpenSessionsAtSucursal = async (client, idSucursal, idUsuario) => {
  const result = await client.query(
    `
      SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal
      ${OPEN_SESSION_JOIN}
        AND (
          cs.id_usuario_responsable = $2
          OR EXISTS (
            SELECT 1 FROM public.cajas_sesiones_participantes csp
            WHERE csp.id_sesion_caja = cs.id_sesion_caja
              AND csp.id_usuario = $2
              AND COALESCE(csp.activo, true) = true
          )
        )
      ORDER BY cs.id_sesion_caja
    `,
    [idSucursal, idUsuario]
  );
  return result.rows;
};

const fetchAllOpenSessionsAtSucursal = async (client, idSucursal) => {
  const result = await client.query(
    `
      SELECT cs.id_sesion_caja, cs.id_caja, cs.id_sucursal
      ${OPEN_SESSION_JOIN}
      ORDER BY cs.id_sesion_caja
    `,
    [idSucursal]
  );
  return result.rows;
};

const fetchSessionById = async (client, idSesionCaja) => {
  const result = await client.query(
    `
      SELECT
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        cs.fecha_cierre,
        UPPER(TRIM(cse.codigo)) AS estado_codigo,
        COALESCE(c.estado, true) AS caja_activa
      FROM public.cajas_sesiones cs
      LEFT JOIN public.cat_cajas_sesiones_estados cse
        ON cse.id_estado_sesion_caja = cs.id_estado_sesion_caja
      LEFT JOIN public.cajas c
        ON c.id_caja = cs.id_caja
       AND c.id_sucursal = cs.id_sucursal
      WHERE cs.id_sesion_caja = $1
      LIMIT 1
    `,
    [idSesionCaja]
  );
  return result.rows?.[0] || null;
};

/**
 * Resuelve la sesion de caja obligatoria para un canje presencial nuevo.
 * `hasMultisucursalAccess` (ya resuelto por resolveFidelizacionScope en
 * routers/fidelizacion.js) es la señal de "Administrador o Super Admin"
 * usada en el resto de este router para decidir alcance de sucursal; se
 * reutiliza aqui con el mismo significado para decidir el camino de
 * resolucion de sesion.
 */
export const resolveCanjeSesionCaja = async ({
  client,
  idSucursal,
  idUsuario,
  hasMultisucursalAccess,
  requestedIdSesionCaja = null
}) => {
  const sucursalId = parsePositiveInt(idSucursal);
  const userId = parsePositiveInt(idUsuario);
  if (!sucursalId || !userId) {
    throw createCanjeSessionError(400, 'FIDELIZACION_CANJE_SESSION_INVALID', 'No se pudo resolver la sucursal o el usuario para la sesion de caja.');
  }

  if (hasMultisucursalAccess) {
    const requestedId = parsePositiveInt(requestedIdSesionCaja);
    if (requestedId) {
      const session = await fetchSessionById(client, requestedId);
      const valid = Boolean(session)
        && Number(session.id_sucursal) === sucursalId
        && Boolean(session.caja_activa)
        && session.estado_codigo === 'ABIERTA'
        && !session.fecha_cierre;
      if (!valid) {
        throw createCanjeSessionError(
          409,
          'FIDELIZACION_CANJE_SESSION_INVALID',
          'La sesión de caja indicada no es válida, no está abierta, o no pertenece a la sucursal seleccionada.'
        );
      }
      return { id_sesion_caja: Number(session.id_sesion_caja) };
    }

    const sessions = await fetchAllOpenSessionsAtSucursal(client, sucursalId);
    if (sessions.length === 0) {
      throw createCanjeSessionError(
        409,
        'FIDELIZACION_CANJE_SESSION_REQUIRED',
        'No hay ninguna sesión de caja abierta en esta sucursal para registrar el canje.'
      );
    }
    if (sessions.length > 1) {
      throw createCanjeSessionError(
        409,
        'FIDELIZACION_CANJE_SESSION_SELECTION_REQUIRED',
        'Hay varias sesiones de caja abiertas en esta sucursal; debe seleccionar una explícitamente.'
      );
    }
    return { id_sesion_caja: Number(sessions[0].id_sesion_caja) };
  }

  // Cajero: siempre su propia sesion, nunca la seleccion enviada (si
  // enviara una, se ignora -- solo Administrador/Super Admin puede elegir
  // sesion ajena).
  const sessions = await fetchUserOpenSessionsAtSucursal(client, sucursalId, userId);
  if (sessions.length === 0) {
    throw createCanjeSessionError(
      409,
      'FIDELIZACION_CANJE_SESSION_REQUIRED',
      'No tiene una sesión de caja abierta en esta sucursal para registrar el canje.'
    );
  }
  if (sessions.length > 1) {
    throw createCanjeSessionError(
      409,
      'FIDELIZACION_CANJE_SESSION_AMBIGUOUS',
      'Tiene más de una sesión de caja abierta en esta sucursal; no se puede determinar cuál usar de forma segura.'
    );
  }
  return { id_sesion_caja: Number(sessions[0].id_sesion_caja) };
};

export { createCanjeSessionError };
