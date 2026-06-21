import { createHash } from 'node:crypto';

const CLIENT_CREATE_OPERATION = 'CLIENTE_FULL_CREATE';
const IDEMPOTENCY_KEY_MIN_LENGTH = 12;
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
};

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const getClienteCreateIdempotencyKey = (req) => {
  const raw = req?.headers?.['idempotency-key'] ?? req?.headers?.['x-idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim();
};

export const buildClienteCreateRequestHash = (payload = {}) => createHash('sha256')
  .update(JSON.stringify(canonicalize(payload)))
  .digest('hex');

export const reserveClienteCreateIdempotency = async ({
  client,
  key,
  requestHash,
  idUsuario = null,
  idSucursal = null
}) => {
  if (!key) return { enabled: false };
  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return { enabled: true, conflict: true, code: 'IDEMPOTENCY_KEY_INVALID' };
  }

  const inserted = await client.query(
    `
      INSERT INTO public.ventas_idempotency_keys (
        idempotency_key, operation, request_hash, id_usuario, id_sucursal, status
      )
      VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `,
    [key, CLIENT_CREATE_OPERATION, requestHash, parsePositiveInt(idUsuario), parsePositiveInt(idSucursal)]
  );

  if (inserted.rowCount > 0) {
    return { enabled: true, reserved: true, key, requestHash };
  }

  const existingResult = await client.query(
    `
      SELECT operation, request_hash, status, http_status, response_body
      FROM public.ventas_idempotency_keys
      WHERE idempotency_key = $1
      FOR UPDATE
    `,
    [key]
  );
  const existing = existingResult.rows?.[0];
  if (!existing) {
    return { enabled: true, conflict: true, code: 'IDEMPOTENCY_STATE_UNAVAILABLE' };
  }
  if (existing.operation !== CLIENT_CREATE_OPERATION || existing.request_hash !== requestHash) {
    return { enabled: true, conflict: true, code: 'IDEMPOTENCY_KEY_REUSED' };
  }
  if (existing.status === 'SUCCESS' && existing.response_body) {
    return {
      enabled: true,
      replay: true,
      httpStatus: Number(existing.http_status) || 200,
      responseBody: existing.response_body
    };
  }
  return { enabled: true, conflict: true, code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' };
};

export const saveClienteCreateIdempotencySuccess = async ({
  client,
  reservation,
  httpStatus,
  responseBody
}) => {
  if (!reservation?.enabled || !reservation?.reserved) return;
  await client.query(
    `
      UPDATE public.ventas_idempotency_keys
      SET status = 'SUCCESS',
          http_status = $4,
          response_body = $5::jsonb,
          error_code = NULL,
          updated_at = NOW()
      WHERE idempotency_key = $1
        AND operation = $2
        AND request_hash = $3
    `,
    [
      reservation.key,
      CLIENT_CREATE_OPERATION,
      reservation.requestHash,
      Number(httpStatus) || 200,
      JSON.stringify(responseBody)
    ]
  );
};

