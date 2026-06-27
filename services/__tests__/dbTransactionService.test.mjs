import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.DB_POOL_MAX = '1';

const { withDbTransaction } = await import('../dbTransactionService.js');

const createPool = ({ rollbackError = null } = {}) => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql).trim());
      if (String(sql).trim() === 'ROLLBACK' && rollbackError) throw rollbackError;
      return { rows: [] };
    },
    release() {
      calls.push('release');
    }
  };
  return {
    calls,
    async connect() {
      calls.push('connect');
      return client;
    }
  };
};

describe('withDbTransaction', () => {
  it('configura timeouts locales, confirma y libera el cliente', async () => {
    const pool = createPool();
    const result = await withDbTransaction(
      async (client) => {
        await client.query('SELECT work');
        return 'ok';
      },
      { label: 'test_commit', poolOverride: pool }
    );

    assert.equal(result, 'ok');
    assert.equal(pool.calls[0], 'connect');
    assert.equal(pool.calls[1], 'BEGIN');
    assert.match(pool.calls[2], /set_config\('statement_timeout'/);
    assert.ok(pool.calls.includes('COMMIT'));
    assert.equal(pool.calls.at(-1), 'release');
  });

  it('hace rollback y libera en error', async () => {
    const pool = createPool();

    await assert.rejects(
      () => withDbTransaction(
        async () => {
          throw new Error('original');
        },
        { label: 'test_rollback', poolOverride: pool }
      ),
      /original/
    );

    assert.ok(pool.calls.includes('ROLLBACK'));
    assert.equal(pool.calls.at(-1), 'release');
  });

  it('no sustituye el error original si falla rollback', async () => {
    const pool = createPool({ rollbackError: new Error('rollback failed') });

    await assert.rejects(
      () => withDbTransaction(
        async () => {
          throw new Error('original failure');
        },
        { label: 'test_rollback_failure', poolOverride: pool }
      ),
      /original failure/
    );

    assert.ok(pool.calls.includes('ROLLBACK'));
    assert.equal(pool.calls.at(-1), 'release');
  });
});
