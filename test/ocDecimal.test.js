import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { multiplyQuantityByFactor, parsePositiveFactor } from '../utils/ocDecimal.js';

test('factor acepta hasta 18 decimales y rechaza formatos no decimales positivos', () => {
  for (const value of ['1', '12.000000000000000000', '0.041666666666666667', '33.814000000000000000']) {
    assert.ok(parsePositiveFactor(value), value);
  }
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e-3', '1.0000000000000000001', '', '1,5']) {
    assert.equal(parsePositiveFactor(value), null, value);
  }
});

test('multiplica cantidad por factor con BigInt y redondeo HALF-UP final a 6 decimales', () => {
  assert.equal(multiplyQuantityByFactor('24', '0.041666666666666667'), '1');
  assert.equal(multiplyQuantityByFactor('12', '0.083333333333333333'), '1');
  assert.equal(multiplyQuantityByFactor('1500', '0.000666666666666667'), '1');
  assert.equal(multiplyQuantityByFactor('1.25', '33.814000000000000000'), '42.2675');
  assert.equal(multiplyQuantityByFactor('2.5', '12.000000000000000000'), '30');
  assert.equal(multiplyQuantityByFactor('1', '0.000000500000000000'), '0.000001');
});

test('migracion amplia solo factor_conversion_snapshot a numeric(30,18)', async () => {
  const sql = await readFile(new URL('../docs/sql/2026-08-31-oc-factor-conversion-precision.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER COLUMN factor_conversion_snapshot TYPE numeric\(30,18\)/i);
  assert.match(sql, /USING factor_conversion_snapshot::numeric\(30,18\)/i);
  assert.doesNotMatch(sql, /ALTER COLUMN cantidad_/i);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|DROP|TRUNCATE)\b/i);
});
