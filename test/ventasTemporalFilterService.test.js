import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVentasTemporalFilter } from '../routers/ventas/services/ventasTemporalFilterService.js';

const NOW = new Date('2026-07-21T18:30:00.000Z'); // 12:30 en Tegucigalpa

test('aplica hoy de Tegucigalpa cuando no recibe fechas', () => {
  const result = resolveVentasTemporalFilter({}, { now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.filters, {
    fechaDesde: '2026-07-21',
    fechaHasta: '2026-07-21',
    horaDesde: null,
    horaHasta: null,
    timezone: 'America/Tegucigalpa'
  });
  assert.deepEqual(result.bounds, {
    startInclusive: '2026-07-21 00:00:00',
    endExclusive: '2026-07-22 00:00:00'
  });
});

test('hoy depende de Tegucigalpa cerca de medianoche UTC', () => {
  const result = resolveVentasTemporalFilter({}, { now: new Date('2026-07-21T03:30:00.000Z') });
  assert.equal(result.filters.fechaDesde, '2026-07-20');
  assert.equal(result.bounds.endExclusive, '2026-07-21 00:00:00');
});

test('un rango de horas incluye todo el minuto final con fin exclusivo', () => {
  const result = resolveVentasTemporalFilter({
    fechaDesde: '2026-07-20',
    fechaHasta: '2026-07-20',
    horaDesde: '08:00',
    horaHasta: '12:00'
  }, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.bounds.startInclusive, '2026-07-20 08:00:00');
  assert.equal(result.bounds.endExclusive, '2026-07-20 12:01:00');
});

test('23:59 usa medianoche del dia siguiente como fin exclusivo', () => {
  const result = resolveVentasTemporalFilter({
    fechaDesde: '2026-07-20', fechaHasta: '2026-07-20', horaDesde: '23:58', horaHasta: '23:59'
  }, { now: NOW });
  assert.equal(result.bounds.endExclusive, '2026-07-21 00:00:00');
});

test('rechaza fechas incompletas, imposibles, invertidas y futuras', () => {
  assert.equal(resolveVentasTemporalFilter({ fechaDesde: '2026-07-20' }, { now: NOW }).code, 'VENTAS_FECHAS_INCOMPLETAS');
  assert.equal(resolveVentasTemporalFilter({ fechaDesde: '2026-02-30', fechaHasta: '2026-02-30' }, { now: NOW }).code, 'VENTAS_FECHA_INVALIDA');
  assert.equal(resolveVentasTemporalFilter({ fechaDesde: '2026-07-20', fechaHasta: '2026-07-19' }, { now: NOW }).code, 'VENTAS_RANGO_FECHAS_INVALIDO');
  assert.equal(resolveVentasTemporalFilter({ fechaDesde: '2026-07-22', fechaHasta: '2026-07-22' }, { now: NOW }).code, 'VENTAS_FECHA_FUTURA');
});

test('rechaza horas incompletas, invalidas, no crecientes o en varios dias', () => {
  const sameDay = { fechaDesde: '2026-07-20', fechaHasta: '2026-07-20' };
  assert.equal(resolveVentasTemporalFilter({ ...sameDay, horaDesde: '08:00' }, { now: NOW }).code, 'VENTAS_HORAS_INCOMPLETAS');
  assert.equal(resolveVentasTemporalFilter({ ...sameDay, horaDesde: '25:00', horaHasta: '26:00' }, { now: NOW }).code, 'VENTAS_HORA_INVALIDA');
  assert.equal(resolveVentasTemporalFilter({ ...sameDay, horaDesde: '12:00', horaHasta: '12:00' }, { now: NOW }).code, 'VENTAS_RANGO_HORAS_INVALIDO');
  assert.equal(resolveVentasTemporalFilter({ fechaDesde: '2026-07-19', fechaHasta: '2026-07-20', horaDesde: '08:00', horaHasta: '09:00' }, { now: NOW }).code, 'VENTAS_HORAS_REQUIEREN_UN_DIA');
});

test('administrador puede consultar historia anterior a 72 horas', () => {
  const result = resolveVentasTemporalFilter({ fechaDesde: '2026-06-01', fechaHasta: '2026-06-02' }, { now: NOW });
  assert.equal(result.ok, true);
});

test('rol restringido permite inicio dentro de 72 horas y rechaza el anterior', () => {
  const allowed = resolveVentasTemporalFilter({
    fechaDesde: '2026-07-18', fechaHasta: '2026-07-18', horaDesde: '12:30', horaHasta: '13:00'
  }, { now: NOW, limitedToLast72Hours: true });
  const denied = resolveVentasTemporalFilter({
    fechaDesde: '2026-07-18', fechaHasta: '2026-07-18', horaDesde: '12:29', horaHasta: '13:00'
  }, { now: NOW, limitedToLast72Hours: true });
  assert.equal(allowed.ok, true);
  assert.equal(denied.code, 'VENTAS_RANGO_72H_EXCEDIDO');
  assert.equal(denied.status, 403);
});

test('redondea el corte de 72 horas al inicio del minuto', () => {
  for (const now of [
    '2026-07-21T18:30:00.000Z',
    '2026-07-21T18:30:01.000Z',
    '2026-07-21T18:30:45.000Z',
    '2026-07-21T18:30:59.999Z'
  ]) {
    const allowed = resolveVentasTemporalFilter({
      fechaDesde: '2026-07-18',
      fechaHasta: '2026-07-18',
      horaDesde: '12:30',
      horaHasta: '12:31'
    }, { now: new Date(now), limitedToLast72Hours: true });
    assert.equal(allowed.ok, true, now);
  }

  const denied = resolveVentasTemporalFilter({
    fechaDesde: '2026-07-18',
    fechaHasta: '2026-07-18',
    horaDesde: '12:29',
    horaHasta: '12:31'
  }, { now: new Date('2026-07-21T18:30:59.999Z'), limitedToLast72Hours: true });
  assert.equal(denied.code, 'VENTAS_RANGO_72H_EXCEDIDO');
});

test('calcula correctamente el corte entre dias, meses, anios y anio bisiesto', () => {
  const cases = [
    { now: '2026-07-22T05:05:45.000Z', date: '2026-07-18', from: '23:05', to: '23:06' },
    { now: '2026-03-01T06:15:45.000Z', date: '2026-02-26', from: '00:15', to: '00:16' },
    { now: '2026-01-01T06:15:45.000Z', date: '2025-12-29', from: '00:15', to: '00:16' },
    { now: '2024-03-01T06:15:45.000Z', date: '2024-02-27', from: '00:15', to: '00:16' }
  ];

  for (const item of cases) {
    const result = resolveVentasTemporalFilter({
      fechaDesde: item.date,
      fechaHasta: item.date,
      horaDesde: item.from,
      horaHasta: item.to
    }, { now: new Date(item.now), limitedToLast72Hours: true });
    assert.equal(result.ok, true, JSON.stringify(item));
  }
});

test('rango sin horas conserva dia completo y no relaja el limite del rol', () => {
  const today = resolveVentasTemporalFilter({
    fechaDesde: '2026-07-21',
    fechaHasta: '2026-07-21'
  }, { now: new Date('2026-07-21T18:30:59.999Z'), limitedToLast72Hours: true });
  const cutoffDay = resolveVentasTemporalFilter({
    fechaDesde: '2026-07-18',
    fechaHasta: '2026-07-18'
  }, { now: new Date('2026-07-21T18:30:59.999Z'), limitedToLast72Hours: true });

  assert.equal(today.ok, true);
  assert.equal(cutoffDay.code, 'VENTAS_RANGO_72H_EXCEDIDO');
});
