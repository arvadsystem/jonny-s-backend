import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('timestamp Postgres real es estable en render actual y reproduce el TZ del render legacy', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const script = `
    import crypto from 'node:crypto';
    import { buildComandaCocinaHtml } from './services/comandaCocinaHtmlService.js';
    const venta = {
      fecha_hora_pedido: '2026-07-18 14:38:55.232546',
      numero_pedido: 'PED-1',
      id_sucursal: 1,
      items: [{ tipo_item: 'PRODUCTO', nombre_item: 'Alitas', cantidad: 1 }]
    };
    const current = buildComandaCocinaHtml(venta, { widthMm: 80 });
    const legacy = buildComandaCocinaHtml(venta, { widthMm: 80, legacy: true });
    const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    console.log(JSON.stringify({
      currentHash: hash(current),
      legacyHash: hash(legacy),
      currentVisible: current.includes('18/07/2026 14:38'),
      legacyVisible: legacy.includes(process.env.EXPECTED_LEGACY)
    }));
  `;
  const expectedLegacy = {
    UTC: '18/7/26, 8:38 a. m.',
    'America/Tegucigalpa': '18/7/26, 2:38 p. m.',
    'Asia/Tokyo': '17/7/26, 11:38 p. m.'
  };
  const results = Object.entries(expectedLegacy).map(([tz, expected]) => JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      env: { ...process.env, TZ: tz, EXPECTED_LEGACY: expected },
      encoding: 'utf8'
    }).trim()
  ));

  assert.equal(new Set(results.map((result) => result.currentHash)).size, 1);
  assert.ok(results.every((result) => result.currentVisible));
  assert.equal(new Set(results.map((result) => result.legacyHash)).size, 3);
  assert.ok(results.every((result) => result.legacyVisible));
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
