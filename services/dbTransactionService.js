import pool from '../config/db-connection.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const clampInt = (value, fallback, min, max) => {
  const parsed = parsePositiveInt(value, fallback);
  return Math.min(Math.max(parsed, min), max);
};

const TRANSACTION_TIMEOUTS = Object.freeze({
  statement: clampInt(process.env.DB_TRANSACTION_STATEMENT_TIMEOUT_MS, 15000, 1000, 60000),
  lock: clampInt(process.env.DB_TRANSACTION_LOCK_TIMEOUT_MS, 6000, 100, 30000),
  idle: clampInt(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 5000, 1000, 60000),
  slow: clampInt(process.env.DB_SLOW_TRANSACTION_MS, 3000, 100, 60000)
});

export const withDbTransaction = async (callback, { label = 'transaction', poolOverride = null } = {}) => {
  const transactionPool = poolOverride || pool;
  const totalStart = Date.now();
  const client = await transactionPool.connect();
  const poolWaitMs = Date.now() - totalStart;
  const transactionStart = Date.now();
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
    const transactionMs = Date.now() - transactionStart;
    const totalMs = Date.now() - totalStart;
    const poolState = {
      totalCount: transactionPool.totalCount,
      idleCount: transactionPool.idleCount,
      waitingCount: transactionPool.waitingCount
    };
    if (poolWaitMs > 0 || poolState.waitingCount > 0) {
      console.warn('[db_transaction] pool wait', {
        label,
        pool_wait_ms: poolWaitMs,
        ...poolState
      });
    }
    if (transactionMs >= TRANSACTION_TIMEOUTS.slow) {
      console.warn('[db_transaction] slow transaction', {
        label,
        pool_wait_ms: poolWaitMs,
        transaction_ms: transactionMs,
        total_ms: totalMs
      });
    }
    client.release();
  }
};
