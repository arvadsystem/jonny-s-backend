import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHondurasDate,
  formatHondurasDateTime,
  formatHondurasTime,
  resolveStableDocumentDate,
  toHondurasInstant
} from '../utils/hondurasDateTime.js';

test('timestamp sin zona (formato Postgres) se interpreta como hora Honduras', () => {
  assert.equal(formatHondurasDate('2026-07-19 17:39:35.02434'), '19/07/2026');
  assert.equal(formatHondurasTime('2026-07-19 17:39:35.02434'), '17:39');
});

test('ISO con Z (instante absoluto) se proyecta a hora Honduras', () => {
  assert.equal(formatHondurasTime('2026-07-19T23:39:35.024Z'), '17:39');
});

test('ISO sin zona y con offset explicito representan el mismo instante que el formato Postgres', () => {
  const reference = toHondurasInstant('2026-07-19 17:39:35.02434').getTime();
  assert.equal(toHondurasInstant('2026-07-19T17:39:35.024').getTime(), reference);
  assert.equal(toHondurasInstant('2026-07-19T17:39:35.024-06:00').getTime(), reference);
  assert.equal(toHondurasInstant(new Date('2026-07-19T23:39:35.024Z')).getTime(), reference);
});

test('el resultado no depende de process.env.TZ', () => {
  const originalTz = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/Tegucigalpa']) {
      process.env.TZ = tz;
      assert.equal(formatHondurasDate('2026-07-19 17:39:35.02434'), '19/07/2026');
      assert.equal(formatHondurasTime('2026-07-19 17:39:35.02434'), '17:39');
    }
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('medianoche no cambia de dia', () => {
  assert.equal(formatHondurasDateTime('2026-07-19 00:15:00'), '19/07/2026 00:15');
});

test('valores invalidos usan el fallback sin lanzar', () => {
  assert.equal(formatHondurasDate(null), '--');
  assert.equal(formatHondurasTime(undefined), '--');
  assert.equal(formatHondurasDateTime('no-es-una-fecha'), 'N/D');
});

test('fecha estable de documento es deterministica para reimpresiones', () => {
  const first = resolveStableDocumentDate('2026-07-19 17:39:35.02434');
  const second = resolveStableDocumentDate('2026-07-19T23:39:35.024Z');
  assert.equal(first.getTime(), second.getTime());
  assert.equal(resolveStableDocumentDate(null).toISOString(), '1970-01-01T00:00:00.000Z');
});
