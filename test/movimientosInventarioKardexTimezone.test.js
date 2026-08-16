import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const routerSource = fs.readFileSync(
  new URL('../routers/movimientos_inventario.js', import.meta.url),
  'utf8'
);

const toHondurasDate = (utcTimestamp) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Tegucigalpa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(`${utcTimestamp.replace(' ', 'T')}Z`));

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const isInsideHondurasDateRange = (utcTimestamp, desde, hasta) => {
  const localDate = toHondurasDate(utcTimestamp);
  return localDate >= desde && localDate <= hasta;
};

test('kardex convierte el reloj UTC sin zona al dia calendario de Honduras antes de filtrar', () => {
  const boundaryTimestamp = '2026-08-16 04:35:16';

  assert.equal(toHondurasDate(boundaryTimestamp), '2026-08-15');
  assert.equal(
    isInsideHondurasDateRange(boundaryTimestamp, '2026-08-15', '2026-08-15'),
    true
  );
  assert.equal(
    isInsideHondurasDateRange(boundaryTimestamp, '2026-08-16', '2026-08-16'),
    false
  );

  assert.match(
    routerSource,
    /\(\(fecha_mov AT TIME ZONE 'UTC'\) AT TIME ZONE 'America\/Tegucigalpa'\)::date >= \$6/
  );
  assert.match(
    routerSource,
    /\(\(fecha_mov AT TIME ZONE 'UTC'\) AT TIME ZONE 'America\/Tegucigalpa'\)::date <= \$7/
  );
});

test('kardex conserva correctamente un movimiento que no cruza medianoche en Honduras', () => {
  const daytimeTimestamp = '2026-08-15 18:00:00';

  assert.equal(toHondurasDate(daytimeTimestamp), '2026-08-15');
  assert.equal(
    isInsideHondurasDateRange(daytimeTimestamp, '2026-08-15', '2026-08-15'),
    true
  );
});

test('kardex conserva el orden cronologico descendente por fecha e id', () => {
  assert.match(
    routerSource,
    /ORDER BY fecha_mov DESC, id_movimiento DESC\s+LIMIT \$11 OFFSET \$12/
  );
});
