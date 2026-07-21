import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.NODE_ENV = 'test';
const {
  assignPersistedKdsTiming,
  resolveKdsRuleByActiveCount
} = await import('../routers/cocina.js');

const routerSource = fs.readFileSync(new URL('../routers/cocina.js', import.meta.url), 'utf8');
const migrationSource = fs.readFileSync(
  new URL('../sql/20260720_add_pedidos_en_preparacion_at.sql', import.meta.url),
  'utf8'
);

test('tablero de cocina devuelve y ordena por la marca propia de preparacion', () => {
  assert.match(routerSource, /p\.en_preparacion_at/);
  assert.match(
    routerSource,
    /WHEN[\s\S]*?EN_PREPARACION[\s\S]*?THEN COALESCE\([\s\S]*?p\.en_preparacion_at,[\s\S]*?p\.visible_en_cocina_at[\s\S]*?f\.fecha_hora_facturacion[\s\S]*?p\.fecha_hora_pedido/
  );
  assert.match(routerSource, /END ASC NULLS LAST,[\s\S]*?p\.id_pedido ASC/);
});

test('primera transicion a preparacion es idempotente', () => {
  assert.match(
    routerSource,
    /estadoDestino === 'EN_PREPARACION'[\s\S]*?en_preparacion_at = COALESCE\(en_preparacion_at, NOW\(\)\)/
  );
  assert.match(routerSource, /RETURNING[\s\S]*?en_preparacion_at/);
});

test('migracion es aditiva, timestamptz y no sobrescribe marcas existentes', () => {
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS en_preparacion_at timestamptz/);
  assert.match(migrationSource, /p\.en_preparacion_at IS NULL/);
  assert.match(migrationSource, /AT TIME ZONE 'America\/Tegucigalpa'/);
  assert.doesNotMatch(migrationSource, /DROP COLUMN/i);
});

const buildTimingClient = ({ activeCount = 0, existingTiming = null } = {}) => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });

      if (/SELECT\s+kds_started_at,[\s\S]*?FROM public\.pedidos[\s\S]*?WHERE id_pedido = \$1/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            kds_started_at: existingTiming?.kds_started_at || null,
            kds_expected_minutes: existingTiming?.kds_expected_minutes || null,
            kds_expected_rule: existingTiming?.kds_expected_rule || null,
            visible_en_cocina_at: '2026-07-20 10:00:00',
            fecha_hora_pedido: '2026-07-20 09:55:00'
          }]
        };
      }

      if (/COUNT\(DISTINCT p\.id_pedido\)/.test(sql)) {
        return { rowCount: 1, rows: [{ total: activeCount }] };
      }

      if (/UPDATE public\.pedidos/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            kds_started_at: '2026-07-20T16:00:00.000Z',
            kds_expected_minutes: params[1],
            kds_expected_rule: params[2]
          }]
        };
      }

      throw new Error(`SQL inesperado: ${sql}`);
    }
  };

  return { client, calls };
};

test('rangos KDS cambian exactamente al alcanzar 10, 16 y 26 pedidos activos', () => {
  const cases = [
    [9, 25, 'RANGO_0_9'],
    [10, 30, 'RANGO_10_15'],
    [15, 30, 'RANGO_10_15'],
    [16, 45, 'RANGO_16_25'],
    [25, 45, 'RANGO_16_25'],
    [26, 50, 'RANGO_26_PLUS']
  ];

  for (const [count, minutes, code] of cases) {
    assert.deepEqual(resolveKdsRuleByActiveCount(count), {
      code,
      min: count === 9 ? 0 : count === 10 ? 10 : count === 16 ? 16 : count === 26 ? 26 : code === 'RANGO_10_15' ? 10 : 16,
      max: code === 'RANGO_0_9' ? 9 : code === 'RANGO_10_15' ? 15 : code === 'RANGO_16_25' ? 25 : Number.POSITIVE_INFINITY,
      minutes
    });
  }
});

test('7 EN_COCINA mas 3 EN_PREPARACION asignan 30 minutos', async () => {
  const fixture = buildTimingClient({ activeCount: 10 });
  const result = await assignPersistedKdsTiming({
    client: fixture.client,
    pedidoId: 501,
    idSucursal: 4,
    activeEstadoIds: [2, 1],
    operationalDate: '2026-07-20T12:00:00.000Z'
  });

  const countCall = fixture.calls.find((call) => /COUNT\(DISTINCT p\.id_pedido\)/.test(call.sql));
  assert.deepEqual(countCall.params, [4, [2, 1], '2026-07-20']);
  assert.equal(result.kds_expected_minutes, 30);
  assert.equal(result.kds_expected_rule, 'RANGO_10_15');
});

test('conteo activo incluye pedidos sin factura o codigo y evita facturas duplicadas', async () => {
  const fixture = buildTimingClient({ activeCount: 10 });
  await assignPersistedKdsTiming({
    client: fixture.client,
    pedidoId: 502,
    idSucursal: 4,
    activeEstadoIds: [2, 1],
    operationalDate: '2026-07-20T12:00:00.000Z'
  });

  const countSql = fixture.calls.find((call) => /COUNT\(DISTINCT p\.id_pedido\)/.test(call.sql)).sql;
  assert.match(countSql, /LEFT JOIN LATERAL/);
  assert.match(countSql, /LIMIT 1/);
  assert.match(countSql, /COUNT\(DISTINCT p\.id_pedido\)/);
  assert.doesNotMatch(countSql, /INNER JOIN public\.facturas/);
  assert.doesNotMatch(countSql, /codigo_venta|estado_pago|pago/i);
});

test('conteo filtra sucursal, estados activos y mismo dia operativo del tablero', async () => {
  const fixture = buildTimingClient({ activeCount: 9 });
  await assignPersistedKdsTiming({
    client: fixture.client,
    pedidoId: 503,
    idSucursal: 8,
    activeEstadoIds: [2, 1],
    operationalDate: '2026-07-21T12:00:00.000Z'
  });

  const countCall = fixture.calls.find((call) => /COUNT\(DISTINCT p\.id_pedido\)/.test(call.sql));
  assert.match(countCall.sql, /p\.id_sucursal = \$1/);
  assert.match(countCall.sql, /p\.id_estado_pedido = ANY\(\$2::int\[\]\)/);
  assert.match(
    countCall.sql,
    /COALESCE\([\s\S]*?f\.fecha_operacion::date,[\s\S]*?p\.visible_en_cocina_at::date,[\s\S]*?p\.fecha_hora_pedido::date[\s\S]*?\) = \$3::date/
  );
  assert.deepEqual(countCall.params, [8, [2, 1], '2026-07-21']);
  const activeCodesMatch = routerSource.match(/const activeKdsEstadoIds = \[([^\]]+)\]/);
  assert.ok(activeCodesMatch);
  assert.deepEqual(
    [...activeCodesMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
    ['EN_COCINA', 'EN_PREPARACION']
  );
});

test('timing ya persistido conserva minutos y regla sin recalcular carga', async () => {
  const persisted = {
    kds_started_at: '2026-07-20T14:00:00.000Z',
    kds_expected_minutes: 25,
    kds_expected_rule: 'RANGO_0_10'
  };
  const fixture = buildTimingClient({ activeCount: 26, existingTiming: persisted });
  const result = await assignPersistedKdsTiming({
    client: fixture.client,
    pedidoId: 504,
    idSucursal: 4,
    activeEstadoIds: [2, 1],
    operationalDate: '2026-07-20T12:00:00.000Z'
  });

  assert.deepEqual(result, persisted);
  assert.equal(fixture.calls.length, 1);
});
