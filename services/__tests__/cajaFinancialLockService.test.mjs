import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  lockCajaFinancialSession,
  mapCajaFinancialLockError,
  parseCajaFinancialLockTimeoutMs,
  parsePositiveBigIntId
} from '../cajaFinancialLockService.js';

const source = readFileSync(resolve('services/cajaFinancialLockService.js'), 'utf8');

describe('cajaFinancialLockService', () => {
  it('usa la funcion bigint de bloqueo financiero con timeout', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      }
    };

    const id = await lockCajaFinancialSession(client, '2147483648', 5000);

    assert.equal(id, '2147483648');
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /fn_ventas_lock_caja_financial_session\(\$1::bigint, \$2::integer\)/);
    assert.deepEqual(calls[0].params, ['2147483648', 5000]);
  });

  it('no conserva advisory lock financiero integer legacy', () => {
    assert.doesNotMatch(source, /pg_advisory_xact_lock\(\$1::integer, \$2::integer\)/);
    assert.doesNotMatch(source, /CAJA_FINANCIAL_LOCK_NAMESPACE/);
  });

  it('parsea ids bigint positivos como cadenas canonicas', () => {
    assert.equal(parsePositiveBigIntId('2147483648'), '2147483648');
    assert.equal(parsePositiveBigIntId('9223372036854775807'), '9223372036854775807');
    assert.equal(parsePositiveBigIntId('9223372036854775808'), null);
    assert.equal(parsePositiveBigIntId('001'), null);
    assert.equal(parsePositiveBigIntId('0'), null);
    assert.equal(parsePositiveBigIntId('1.2'), null);
    assert.equal(typeof parsePositiveBigIntId('2147483648'), 'string');
  });

  it('valida timeout configurado', () => {
    assert.equal(parseCajaFinancialLockTimeoutMs(undefined), 5000);
    assert.equal(parseCajaFinancialLockTimeoutMs('100'), 100);
    assert.equal(parseCajaFinancialLockTimeoutMs('60000'), 60000);
    assert.equal(parseCajaFinancialLockTimeoutMs('99'), null);
    assert.equal(parseCajaFinancialLockTimeoutMs('60001'), null);
    assert.equal(parseCajaFinancialLockTimeoutMs('abc'), null);
  });

  it('mapea conflictos de concurrencia a HTTP 409 estable', () => {
    for (const code of ['55P03', '40P01', 'VENTAS_CAJA_FINANCIAL_LOCK_TIMEOUT']) {
      const mapped = mapCajaFinancialLockError({ code });
      assert.equal(mapped.httpStatus, 409);
      assert.equal(mapped.code, 'VENTAS_CAJAS_CONCURRENT_OPERATION_RETRY');
    }
  });
});
