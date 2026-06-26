const MIN_LOCK_TIMEOUT_MS = 100;
const MAX_LOCK_TIMEOUT_MS = 60000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export const parsePositiveBigIntId = (value) => {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  return text;
};

export const parseCajaFinancialLockTimeoutMs = (value = process.env.CAJAS_FINANCIAL_LOCK_TIMEOUT_MS) => {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_LOCK_TIMEOUT_MS;
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_LOCK_TIMEOUT_MS || parsed > MAX_LOCK_TIMEOUT_MS) {
    return null;
  }
  return parsed;
};

const createInvalidTimeoutError = () => {
  const error = new Error('CAJAS_FINANCIAL_LOCK_TIMEOUT_MS invalido.');
  error.httpStatus = 500;
  error.code = 'VENTAS_CAJA_FINANCIAL_LOCK_TIMEOUT_CONFIG_INVALID';
  error.publicMessage = 'Configuracion de bloqueo financiero invalida.';
  return error;
};

export const lockCajaFinancialSession = async (
  client,
  idSesionCaja,
  timeoutMs = parseCajaFinancialLockTimeoutMs()
) => {
  const parsedId = parsePositiveBigIntId(idSesionCaja);
  if (!parsedId) return null;
  if (!timeoutMs) throw createInvalidTimeoutError();

  await client.query(
    'SELECT public.fn_ventas_lock_caja_financial_session($1::bigint, $2::integer)',
    [parsedId, timeoutMs]
  );
  return parsedId;
};

export const lockCajaFinancialSessions = async (client, ids = []) => {
  const uniqueIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map(parsePositiveBigIntId)
      .filter(Boolean)
  )].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

  for (const id of uniqueIds) {
    await lockCajaFinancialSession(client, id);
  }

  return uniqueIds;
};

export const mapCajaFinancialLockError = (err) => {
  if (!['55P03', '40P01', 'VENTAS_CAJA_FINANCIAL_LOCK_TIMEOUT'].includes(err?.code)) return err;
  const mapped = new Error('Otra operacion financiera de caja esta en curso. Intente nuevamente.');
  mapped.httpStatus = 409;
  mapped.code = 'VENTAS_CAJAS_CONCURRENT_OPERATION_RETRY';
  mapped.publicMessage = 'Otra operacion financiera de caja esta en curso. Intente nuevamente.';
  return mapped;
};
