import { roundMoney } from '../utils/moneyUtils.js';

const toCents = (value) => Math.round(roundMoney(value) * 100);
const fromCents = (value) => roundMoney(Number(value || 0) / 100);

const createAllocationError = (code, message) => {
  const error = new Error(message);
  error.httpStatus = 409;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const normalizeBoolean = (value) => value === true || value === 'true' || value === 1 || value === '1';

const normalizePaymentRows = (paymentRows) => (Array.isArray(paymentRows) ? paymentRows : [])
  .map((row) => ({
    id_factura_cobro: Number(row?.id_factura_cobro || 0),
    id_metodo_pago: Number(row?.id_metodo_pago || 0),
    metodo_pago_codigo: String(row?.metodo_pago_codigo || '').trim().toUpperCase(),
    metodo_pago_nombre: String(row?.metodo_pago_nombre || '').trim(),
    metodo_pago_encontrado: normalizeBoolean(row?.metodo_pago_encontrado),
    metodo_pago_activo: normalizeBoolean(row?.metodo_pago_activo),
    afecta_efectivo: normalizeBoolean(row?.afecta_efectivo),
    monto_cents: toCents(row?.monto)
  }))
  .sort((a, b) => a.id_factura_cobro - b.id_factura_cobro);

const allocateCumulativeCents = (payments, targetCents) => {
  let remaining = targetCents;
  return payments.map((payment) => {
    const allocatedCents = Math.min(payment.monto_cents, Math.max(remaining, 0));
    remaining -= allocatedCents;
    return allocatedCents;
  });
};

/**
 * Distribuye una reversion de forma acumulativa y determinista sobre los
 * cobros originales, ordenados por id_factura_cobro. La asignacion de esta
 * operacion es target(acumulado nuevo) - target(acumulado anterior), lo que
 * garantiza exactitud a centavos, monotonicidad y topes por cobro/metodo.
 */
export const buildReversionPaymentAllocation = ({
  paymentRows,
  facturaTotal,
  previouslyReversed,
  currentReversal
}) => {
  const payments = normalizePaymentRows(paymentRows);
  if (!payments.length || payments.some((row) => !row.id_factura_cobro || !row.id_metodo_pago || !row.metodo_pago_encontrado)) {
    throw createAllocationError(
      'VENTAS_REVERSION_METODO_PAGO_NO_ENCONTRADO',
      'No se pudo resolver el metodo de pago original de la venta.'
    );
  }
  if (payments.some((row) => !row.metodo_pago_activo)) {
    throw createAllocationError(
      'VENTAS_REVERSION_METODO_PAGO_INACTIVO',
      'La venta contiene un metodo de pago inactivo y no puede reversarse de forma segura.'
    );
  }
  if (payments.some((row) => row.monto_cents < 0)) {
    throw createAllocationError(
      'VENTAS_REVERSION_COBROS_TOTAL_MISMATCH',
      'El total de cobros originales no coincide con el total de la factura.'
    );
  }

  const facturaTotalCents = toCents(facturaTotal);
  const paymentTotalCents = payments.reduce((sum, row) => sum + row.monto_cents, 0);
  if (facturaTotalCents <= 0 || paymentTotalCents !== facturaTotalCents) {
    throw createAllocationError(
      'VENTAS_REVERSION_COBROS_TOTAL_MISMATCH',
      'El total de cobros originales no coincide con el total de la factura.'
    );
  }

  const previousCents = toCents(previouslyReversed);
  const currentCents = toCents(currentReversal);
  const nextCents = previousCents + currentCents;
  if (previousCents < 0 || currentCents <= 0 || nextCents > paymentTotalCents) {
    throw createAllocationError(
      'VENTAS_REVERSION_MONTO_EXCEDE_COBROS',
      'La reversion excede el saldo disponible de los cobros originales.'
    );
  }

  const before = allocateCumulativeCents(payments, previousCents);
  const after = allocateCumulativeCents(payments, nextCents);
  const allocations = payments.map((payment, index) => ({
    id_factura_cobro: payment.id_factura_cobro,
    id_metodo_pago: payment.id_metodo_pago,
    metodo_pago_codigo: payment.metodo_pago_codigo,
    metodo_pago_nombre: payment.metodo_pago_nombre,
    afecta_efectivo: payment.afecta_efectivo,
    monto_cobro: fromCents(payment.monto_cents),
    monto_reversado: fromCents(after[index] - before[index])
  })).filter((row) => row.monto_reversado > 0);

  const allocatedCents = allocations.reduce((sum, row) => sum + toCents(row.monto_reversado), 0);
  if (allocatedCents !== currentCents || allocations.some((row) => toCents(row.monto_reversado) < 0)) {
    throw createAllocationError(
      'VENTAS_REVERSION_DISTRIBUCION_INVALIDA',
      'La distribucion de la reversion por metodo de pago no coincide con el monto solicitado.'
    );
  }

  const effectiveCents = allocations
    .filter((row) => row.afecta_efectivo)
    .reduce((sum, row) => sum + toCents(row.monto_reversado), 0);

  return {
    total_cobrado: fromCents(paymentTotalCents),
    total_reversado_anterior: fromCents(previousCents),
    total_reversado_acumulado: fromCents(nextCents),
    monto_efectivo_reversado: fromCents(effectiveCents),
    asignaciones: allocations
  };
};

export const resolvePreviouslyReversedAmountForUpdate = async ({ client, idFactura }) => {
  const result = await client.query(
    `
      SELECT id_reversion, COALESCE(monto_reversado, 0)::numeric(12,2) AS monto_reversado
      FROM public.facturas_reversiones
      WHERE id_factura_original = $1
        AND UPPER(TRIM(COALESCE(estado, ''))) = 'APLICADA'
      ORDER BY id_reversion
      FOR UPDATE
    `,
    [idFactura]
  );
  return roundMoney((result.rows || []).reduce((sum, row) => sum + Number(row.monto_reversado || 0), 0));
};
