import { performance } from 'node:perf_hooks';
import {
  connectClient,
  lockFacturaForAccumulation,
  getFacturaAccumulationContext,
  isFacturaFullyPaid,
  persistAccumulation,
  recordAccumulationRetryableError
} from '../infrastructure/fidelizacionRepository.js';
import { ACCUMULATION_TRIGGER } from '../domain/accumulationState.js';

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const isFidelizacionLoggingEnabled = () =>
  ['true', '1', 'yes', 'on'].includes(String(process.env.VENTAS_PERF_LOGS || '').trim().toLowerCase());

const logAccumulationOutcome = (payload) => {
  if (!isFidelizacionLoggingEnabled()) return;
  console.info('[fidelizacion:accumulate]', payload);
};

const releaseClientSafely = (client) => {
  if (!client) return;
  try {
    client.release();
  } catch (releaseErr) {
    console.error('[fidelizacion:accumulate] error al liberar conexion:', {
      code: releaseErr?.code || releaseErr?.name || 'FIDELIZACION_RELEASE_ERROR'
    });
  }
};

// Sucesor de registerVentaFidelizacionAfterCommit: abre su propia conexion
// (pool dedicado, ver infrastructure/fidelizacionPool.js) y su propia
// transaccion, nunca la de la venta/pago que ya fue confirmada, y jamas
// propaga un error hacia quien la invoco (ver application/notifyPaidInvoice.js).
//
// Unica capa que decide y persiste los puntos: resuelve contexto y estado de
// pago aqui, pero el calculo de puntos, la config vigente EN LA FECHA de pago
// y la escritura viven en un solo lugar (infrastructure/fidelizacionRepository.js
// -> services/fidelizacionService.js::registerFacturaLoyaltyAccumulation).
// No se repite esa consulta ni ese calculo en esta capa.
export const accumulateInvoicePoints = async ({ idFactura, trigger = ACCUMULATION_TRIGGER.LIVE } = {}) => {
  const facturaId = parsePositiveInt(idFactura);
  const startedAt = performance.now();

  if (!facturaId) {
    const outcome = { created: false, reason: 'INVALID_INVOICE_ID' };
    logAccumulationOutcome({ id_factura: null, ...outcome, elapsed_ms: 0 });
    return outcome;
  }

  let client = null;
  let transactionStarted = false;
  let context = null;

  try {
    client = await connectClient();
    await client.query('BEGIN');
    transactionStarted = true;
    await lockFacturaForAccumulation(client, facturaId);

    context = await getFacturaAccumulationContext(client, facturaId);

    // No se exige idCliente/idSucursal aqui: el snapshot durable (resuelto
    // dentro de persistAccumulation) puede rellenar exactamente esos huecos
    // -ver resolveEffectiveAccumulationContext-. Cortar antes de leer el
    // estado durable le negaba esa posibilidad: una reserva PENDING con
    // cliente/sucursal validos nunca llegaba a consultarse solo porque el
    // contexto ACTUAL de la factura (que pudo cambiar, o nunca los tuvo)
    // los trae NULL. Solo la existencia de la factura es indispensable aqui.
    if (!context) {
      await client.query('COMMIT');
      transactionStarted = false;
      const outcome = { created: false, reason: 'MISSING_REQUIRED_DATA' };
      logAccumulationOutcome({
        id_factura: facturaId,
        ...outcome,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt))
      });
      return outcome;
    }

    if (!isFacturaFullyPaid(context)) {
      await client.query('COMMIT');
      transactionStarted = false;
      const outcome = { created: false, reason: 'INVOICE_NOT_FULLY_PAID' };
      logAccumulationOutcome({
        id_factura: facturaId,
        ...outcome,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt))
      });
      return outcome;
    }

    const result = await persistAccumulation({
      client,
      idFactura: facturaId,
      idPedido: context.id_pedido,
      // Puede ser null: persistAccumulation resuelve el contexto EFECTIVO
      // (snapshot durable si existe, contexto actual si no) antes de decidir
      // si de verdad faltan datos.
      idCliente: parsePositiveInt(context.id_cliente),
      idSucursal: parsePositiveInt(context.id_sucursal),
      idUsuarioEjecutor: parsePositiveInt(context.id_usuario),
      montoFactura: context.monto_factura,
      referenceDate: context.fecha_referencia_config,
      trigger
    });

    await client.query('COMMIT');
    transactionStarted = false;

    logAccumulationOutcome({
      id_factura: facturaId,
      created: Boolean(result?.created),
      reason: result?.reason || null,
      elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt))
    });

    return result;
  } catch (err) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // La venta/pago ya fue confirmado; este rollback solo protege el trabajo diferido.
      }
    }
    console.error('[fidelizacion:accumulate] error:', {
      id_factura: facturaId,
      code: err?.code || err?.name || 'FIDELIZACION_ACCUMULATE_ERROR'
    });

    // Best-effort: deja la factura en RETRYABLE_ERROR (no un skip terminal
    // de negocio) para que la reconciliacion pueda reintentarla. La
    // transaccion de arriba ya hizo ROLLBACK; esto es una escritura nueva,
    // separada, sobre la misma conexion. Si tambien falla (p.ej. la
    // conexion en si esta caida), se ignora: nunca cambia el resultado ya
    // decidido ni el 201 de la venta, que ya se respondio antes de que
    // cualquiera de esto se ejecute.
    if (client) {
      // err.eligibilitySnapshot: persistAccumulation lo adjunta cuando ya
      // habia resuelto el snapshot ANTES de que fallara el registro. El
      // ROLLBACK de arriba deshizo cualquier escritura de este intento, asi
      // que esta es la unica oportunidad de no perder esa evidencia historica.
      await recordAccumulationRetryableError(client, facturaId, {
        fechaReferencia: context?.fecha_referencia_config ?? null,
        error: err,
        snapshot: err?.eligibilitySnapshot ?? null
      });
    }

    return { created: false, reason: 'ERROR' };
  } finally {
    releaseClientSafely(client);
  }
};
