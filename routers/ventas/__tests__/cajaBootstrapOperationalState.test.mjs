import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchCajaBootstrapOperationalState } from '../handlers/catalogosHandlers.js';

const maxSqlPlaceholder = (sql) => {
  const matches = [...String(sql || '').matchAll(/\$(\d+)/g)];
  return matches.reduce((max, match) => Math.max(max, Number(match[1]) || 0), 0);
};

describe('fetchCajaBootstrapOperationalState', () => {
  it('ejecuta SQL con la misma cantidad de parametros que placeholders', async () => {
    const calls = [];
    const fakeDb = {
      async query(sql, params) {
        calls.push({ sql, params });
        assert.equal(params.length, maxSqlPlaceholder(sql));
        return { rows: [] };
      }
    };

    const result = await fetchCajaBootstrapOperationalState({
      idUsuario: 53,
      idSucursal: 6,
      db: fakeDb
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, [53, 6]);
  });
});
