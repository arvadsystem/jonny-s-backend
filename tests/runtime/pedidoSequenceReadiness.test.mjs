import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const { default: app, setHealthCheckQueryRunnerForTests } = await import('../../app.js');

const request = (server, path) => new Promise((resolve, reject) => {
  const address = server.address();
  const req = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path,
    method: 'GET'
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
  });
  req.on('error', reject);
  req.end();
});

const createServer = () => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

const runReady = async (state = {}) => {
  const sequence = sequenceRow(state);
  const queries = [];
  setHealthCheckQueryRunnerForTests({
    async query(sql, params = []) {
      const text = String(sql);
      queries.push(text);
      assert.doesNotMatch(text, /nextval\s*\(/i);
      if (text === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (text.includes('id_pedido_trazabilidad')) return { rows: [{ is_generated: 'NEVER' }] };
      if (text.includes("pg_get_serial_sequence('public.pedidos'")) {
        return { rows: [sequence] };
      }
      if (text.includes('JOIN pg_sequence')) {
        assert.deepEqual(params, [sequence.sequence_name]);
        if (!sequence.sequence_name || sequence.sequence_missing_meta) return { rows: [] };
        return {
          rows: [{
            sequence_schema: 'public',
            sequence_relation: 'pedidos_id_pedido_seq',
            sequence_increment_by: sequence.sequence_increment_by,
            sequence_cycle: sequence.sequence_cycle,
            sequence_min_value: sequence.sequence_min_value,
            sequence_max_value: sequence.sequence_max_value
          }]
        };
      }
      if (text.includes('FROM "public"."pedidos_id_pedido_seq"')) {
        return {
          rows: [{
            sequence_last_value: sequence.sequence_last_value,
            sequence_is_called: sequence.sequence_is_called
          }]
        };
      }
      if (text.includes('MAX(id_pedido)')) {
        return {
          rows: [{
            max_pedido_id: sequence.max_pedido_id,
            max_inventory_order_ref: sequence.max_inventory_order_ref
          }]
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    }
  });
  const server = await createServer();
  try {
    const response = await request(server, '/health/ready');
    return { response, queries };
  } finally {
    server.close();
  }
};

const sequenceRow = (overrides = {}) => ({
  sequence_name: 'public.pedidos_id_pedido_seq',
  pedidos_exists: true,
  inventory_exists: true,
  sequence_last_value: 123,
  sequence_is_called: true,
  sequence_increment_by: 1,
  sequence_cycle: false,
  sequence_min_value: 1,
  sequence_max_value: 2147483647,
  max_pedido_id: 100,
  max_inventory_order_ref: 123,
  ...overrides
});

after(() => {
  setHealthCheckQueryRunnerForTests();
});

describe('pedido sequence readiness', () => {
  it('acepta secuencia segura sin consumir IDs', async () => {
    const { response, queries } = await runReady();
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'ready');
    assert.equal(queries.some((sql) => /nextval\s*\(/i.test(sql)), false);
  });

  it('acepta last_value 124 sin llamar cuando historial es 123', async () => {
    const { response } = await runReady({ sequence_last_value: 124, sequence_is_called: false });
    assert.equal(response.statusCode, 200);
  });

  it('rechaza last_value 123 sin llamar cuando historial es 123', async () => {
    const { response } = await runReady({ sequence_last_value: 123, sequence_is_called: false });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_BELOW_INVENTORY_HISTORY');
    assert.equal(response.body.details.sequence_next_candidate, 123);
    assert.equal(response.body.details.history_floor, 123);
  });

  it('rechaza secuencia debajo de MAX(pedidos.id_pedido)', async () => {
    const { response } = await runReady({ sequence_last_value: 90, max_pedido_id: 100, max_inventory_order_ref: 80 });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_BELOW_INVENTORY_HISTORY');
    assert.equal(response.body.details.max_pedido_id, 100);
  });

  it('rechaza secuencia debajo del historial de movimientos_inventario.id_ref', async () => {
    const { response } = await runReady({ sequence_last_value: 100, max_pedido_id: 90, max_inventory_order_ref: 123 });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_BELOW_INVENTORY_HISTORY');
    assert.equal(response.body.details.max_inventory_order_ref, 123);
  });

  it('rechaza incremento cero, negativo o invalido', async () => {
    for (const sequence_increment_by of [0, -1, null]) {
      const { response } = await runReady({ sequence_increment_by });
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_INVALID_INCREMENT');
    }
  });

  it('rechaza secuencia ciclica', async () => {
    const { response } = await runReady({ sequence_cycle: true });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_CYCLE_UNSAFE');
  });

  it('rechaza secuencia agotada', async () => {
    const { response } = await runReady({ sequence_last_value: 123, sequence_is_called: true, sequence_max_value: 123 });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_EXHAUSTED');
  });

  it('rechaza secuencia inexistente', async () => {
    const { response } = await runReady({ sequence_name: null, sequence_last_value: null });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_MISSING');
  });

  it('rechaza tabla pedidos inexistente', async () => {
    const { response } = await runReady({ pedidos_exists: false });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_TABLE_MISSING');
  });

  it('rechaza tabla movimientos_inventario inexistente', async () => {
    const { response } = await runReady({ inventory_exists: false });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'MOVIMIENTOS_INVENTARIO_TABLE_MISSING');
  });

  it('dos llamadas consecutivas no cambian last_value observado', async () => {
    const first = await runReady({ sequence_last_value: 123, sequence_is_called: true });
    const second = await runReady({ sequence_last_value: 123, sequence_is_called: true });
    assert.equal(first.response.statusCode, 200);
    assert.equal(second.response.statusCode, 200);
    assert.equal(first.queries.some((sql) => /nextval\s*\(/i.test(sql)), false);
    assert.equal(second.queries.some((sql) => /nextval\s*\(/i.test(sql)), false);
  });
});
