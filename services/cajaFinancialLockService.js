export const CAJA_FINANCIAL_LOCK_NAMESPACE = 8152028;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const lockCajaFinancialSession = async (client, idSesionCaja) => {
  const parsedId = parsePositiveInt(idSesionCaja);
  if (!parsedId) return null;
  await client.query(
    'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
    [CAJA_FINANCIAL_LOCK_NAMESPACE, parsedId]
  );
  return parsedId;
};

export const lockCajaFinancialSessions = async (client, ids = []) => {
  const uniqueIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map(parsePositiveInt)
      .filter(Boolean)
  )].sort((a, b) => a - b);

  for (const id of uniqueIds) {
    await lockCajaFinancialSession(client, id);
  }

  return uniqueIds;
};

export const mapCajaFinancialLockError = (err) => {
  if (err?.code !== '40P01') return err;
  const mapped = new Error('Otra operacion financiera de caja esta en curso. Intente nuevamente.');
  mapped.httpStatus = 409;
  mapped.code = 'VENTAS_CAJAS_CONCURRENT_OPERATION_RETRY';
  mapped.publicMessage = 'Otra operacion financiera de caja esta en curso. Intente nuevamente.';
  return mapped;
};
