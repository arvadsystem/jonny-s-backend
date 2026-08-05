// Resolucion y bloqueo de la sesion de caja ORIGINAL de una reversion de
// venta. Fase 2: la fuente de verdad deja de ser facturas.id_sesion_caja
// (columna denormalizada) y pasa a ser facturas_cobros.id_sesion_caja,
// siguiendo exactamente el mismo patron que ya usa
// services/cajaCloseFinancialSnapshotService.js para atribuir reversiones
// a una sesion de cierre.
import { lockCajaFinancialSessions } from '../../../services/cajaFinancialLockService.js';
import { parsePositiveInt } from '../utils/parseUtils.js';

const createReversionSessionError = (httpStatus, code, message) => {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  error.publicMessage = message;
  return error;
};

/**
 * Bloquea facturas_cobros de la factura y resuelve la UNICA sesion de caja
 * original valida. Nunca elige la primera sesion ni corrige datos.
 *
 * - 0 cobros o 0 sesiones no nulas -> VENTAS_REVERSION_SESSION_MISSING (409)
 * - 2+ sesiones distintas -> VENTAS_REVERSION_SESSION_AMBIGUOUS (409)
 * - la sesion unica no coincide con facturas.id_sesion_caja (si esta
 *   presente) -> VENTAS_REVERSION_SESSION_MISMATCH (409)
 */
export const resolveOriginalSessionFromCobros = async ({ client, idFactura, facturaIdSesionCaja = null }) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) {
    throw createReversionSessionError(400, 'VENTAS_REVERSION_PARAM_INVALIDO', 'Solicitud invalida.');
  }

  const cobrosResult = await client.query(
    `
      SELECT
        fc.id_factura_cobro,
        fc.id_sesion_caja,
        fc.id_metodo_pago,
        fc.monto,
        mp.codigo AS metodo_pago_codigo,
        mp.nombre AS metodo_pago_nombre,
        (mp.id_metodo_pago IS NOT NULL) AS metodo_pago_encontrado,
        (mp.id_metodo_pago IS NOT NULL AND COALESCE(mp.estado, true)) AS metodo_pago_activo,
        COALESCE(mp.afecta_efectivo, false) AS afecta_efectivo
      FROM public.facturas_cobros fc
      LEFT JOIN public.cat_metodos_pago mp
        ON mp.id_metodo_pago = fc.id_metodo_pago
      WHERE fc.id_factura = $1
      ORDER BY fc.id_factura_cobro
      FOR UPDATE OF fc
    `,
    [facturaId]
  );

  if (!cobrosResult.rowCount) {
    throw createReversionSessionError(
      409,
      'VENTAS_REVERSION_SESSION_MISSING',
      'La venta no tiene una sesión de caja original válida.'
    );
  }

  const distinctSessionIds = [...new Set(
    cobrosResult.rows
      .map((row) => parsePositiveInt(row.id_sesion_caja))
      .filter(Boolean)
  )];

  if (distinctSessionIds.length === 0) {
    throw createReversionSessionError(
      409,
      'VENTAS_REVERSION_SESSION_MISSING',
      'La venta no tiene una sesión de caja original válida.'
    );
  }

  if (distinctSessionIds.length > 1) {
    throw createReversionSessionError(
      409,
      'VENTAS_REVERSION_SESSION_AMBIGUOUS',
      'La venta tiene cobros asociados a más de una sesión de caja.'
    );
  }

  const idSesionCajaOriginal = distinctSessionIds[0];

  const facturaSessionId = parsePositiveInt(facturaIdSesionCaja);
  if (facturaSessionId && facturaSessionId !== idSesionCajaOriginal) {
    throw createReversionSessionError(
      409,
      'VENTAS_REVERSION_SESSION_MISMATCH',
      'La sesión financiera de la venta no coincide con sus cobros registrados.'
    );
  }

  return { id_sesion_caja: idSesionCajaOriginal, cobros: cobrosResult.rows };
};

/**
 * Bloquea (via el servicio financiero existente) y valida la sesion de
 * caja original resuelta desde facturas_cobros. Un unico codigo publico
 * (VENTAS_REVERSION_SESION_CERRADA) cubre todo el conjunto de condiciones
 * de la Fase 2: sesion inexistente, sucursal distinta, caja inactiva,
 * sesion no ABIERTA o ya con fecha_cierre. Nunca cae de vuelta a una
 * sesion "actualmente abierta" distinta de la original.
 */
export const lockAndValidateOriginalCajaSession = async ({ client, idSesionCaja, idSucursal }) => {
  const sesionId = parsePositiveInt(idSesionCaja);
  const sucursalId = parsePositiveInt(idSucursal);
  if (!sesionId || !sucursalId) {
    throw createReversionSessionError(
      409,
      'VENTAS_REVERSION_SESION_CERRADA',
      'La sesión original de caja ya fue cerrada.'
    );
  }

  await lockCajaFinancialSessions(client, [sesionId]);

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
    [sesionId]
  );

  const session = result.rows?.[0];
  const sessionValid = Boolean(session)
    && Number(session.id_sucursal) === sucursalId
    && Boolean(session.caja_activa)
    && session.estado_codigo === 'ABIERTA'
    && !session.fecha_cierre;

  if (!sessionValid) {
    throw createReversionSessionError(
      409,
      'VENTAS_REVERSION_SESION_CERRADA',
      'La sesión original de caja ya fue cerrada.'
    );
  }

  return {
    id_sesion_caja: Number(session.id_sesion_caja),
    id_caja: Number(session.id_caja),
    id_sucursal: Number(session.id_sucursal)
  };
};
