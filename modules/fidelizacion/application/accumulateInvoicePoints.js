import { performance } from 'node:perf_hooks';
import {
  connectClient,
  lockFacturaForAccumulation,
  getFacturaAccumulationContext,
  hasExistingAccumulation,
  getActiveConfigForSucursal,
  persistAccumulation
} from '../infrastructure/fidelizacionRepository.js';
import { computeAccumulationPoints, isAccumulationWorthPersisting } from '../domain/pointsCalculator.js';

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

// Este es el sucesor de registerVentaFidelizacionAfterCommit (antes en
// routers/ventas.js): abre su propia conexion y transaccion, nunca la de la
// venta/pago que ya fue confirmada, y jamas propaga un error hacia quien la
// invoco (ver application/notifyPaidInvoice.js).
export const accumulateInvoicePoints = async ({ idFactura } = {}) => {
  const facturaId = parsePositiveInt(idFactura);
  const startedAt = performance.now();

  if (!facturaId) {
    const outcome = { created: false, reason: 'INVALID_INVOICE_ID' };
    logAccumulationOutcome({ id_factura: null, ...outcome, elapsed_ms: 0 });
    return outcome;
  }

  let client = null;
  let transactionStarted = false;

  try {
    client = await connectClient();
    await client.query('BEGIN');
    transactionStarted = true;
    await lockFacturaForAccumulation(client, facturaId);

    const alreadyRegisteredMovementId = await hasExistingAccumulation(client, facturaId);
    if (alreadyRegisteredMovementId) {
      await client.query('COMMIT');
      transactionStarted = false;
      const outcome = { created: false, reason: 'ALREADY_REGISTERED', idMovimiento: alreadyRegisteredMovementId };
      logAccumulationOutcome({
        id_factura: facturaId,
        ...outcome,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt))
      });
      return outcome;
    }

    const context = await getFacturaAccumulationContext(client, facturaId);
    const idCliente = parsePositiveInt(context?.id_cliente);
    const idSucursal = parsePositiveInt(context?.id_sucursal);
    if (!context || !idCliente || !idSucursal) {
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

    const activeConfig = await getActiveConfigForSucursal(client, idSucursal);
    const projectedPoints = computeAccumulationPoints(context.monto_factura, activeConfig?.lempiras_por_punto);
    if (!isAccumulationWorthPersisting(projectedPoints)) {
      await client.query('COMMIT');
      transactionStarted = false;
      const outcome = {
        created: false,
        reason: activeConfig ? 'POINTS_ROUND_DOWN_TO_ZERO' : 'CONFIG_NOT_FOUND'
      };
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
      idCliente,
      idSucursal,
      idUsuarioEjecutor: parsePositiveInt(context.id_usuario),
      montoFactura: context.monto_factura
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
    return { created: false, reason: 'ERROR' };
  } finally {
    if (client) client.release();
  }
};
