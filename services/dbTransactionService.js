import pool from '../config/db-connection.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const TRANSACTION_TIMEOUTS = Object.freeze({
  statement: parsePositiveInt(process.env.DB_TRANSACTION_STATEMENT_TIMEOUT_MS, 15000),
  lock: parsePositiveInt(process.env.DB_TRANSACTION_LOCK_TIMEOUT_MS, 6000),
  idle: parsePositiveInt(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 5000),
  slow: parsePositiveInt(process.env.DB_SLOW_TRANSACTION_MS, 3000)
});

export const withDbTransaction = async (callback, { label = 'transaction' } = {}) => {
  const client = await pool.connect();
  const start = Date.now();
  let began = false;

  try {
    await client.query('BEGIN');
    began = true;
    await client.query(
      `
        SELECT
          set_config('statement_timeout', $1, true),
          set_config('lock_timeout', $2, true),
          set_config('idle_in_transaction_session_timeout', $3, true)
      `,
      [
        `${TRANSACTION_TIMEOUTS.statement}ms`,
        `${TRANSACTION_TIMEOUTS.lock}ms`,
        `${TRANSACTION_TIMEOUTS.idle}ms`
      ]
    );

    const result = await callback(client);
    await client.query('COMMIT');
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[db_transaction] rollback failed', {
          label,
          rollback_code: rollbackError?.code || null,
          rollback_message: rollbackError?.message || 'Rollback error',
          original_code: error?.code || null,
          original_message: error?.message || 'Original error'
        });
      }
    }
    throw error;
  } finally {
    const elapsedMs = Date.now() - start;
    if (elapsedMs >= TRANSACTION_TIMEOUTS.slow) {
      console.warn('[db_transaction] slow transaction', { label, elapsed_ms: elapsedMs });
    }
    client.release();
  }
};
