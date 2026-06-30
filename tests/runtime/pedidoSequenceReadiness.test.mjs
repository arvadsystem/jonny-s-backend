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

const runReady = async (rows) => {
  const queries = [];
  setHealthCheckQueryRunnerForTests({
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      assert.doesNotMatch(text, /nextval\s*\(/i);
      if (text === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (text.includes('id_pedido_trazabilidad')) return { rows: [{ is_generated: 'NEVER' }] };
      if (text.includes("pg_get_serial_sequence('public.pedidos'")) return { rows };
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
  sequence_last_value: 150,
  max_pedido_id: 100,
  max_inventory_order_ref: 123,
  ...overrides
});

after(() => {
  setHealthCheckQueryRunnerForTests();
});

describe('pedido sequence readiness', () => {
  it('acepta secuencia segura sin consumir IDs', async () => {
    const { response, queries } = await runReady([sequenceRow()]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'ready');
    assert.equal(queries.some((sql) => /nextval\s*\(/i.test(sql)), false);
  });

  it('rechaza secuencia debajo de MAX(pedidos.id_pedido)', async () => {
    const { response } = await runReady([sequenceRow({ sequence_last_value: 90, max_pedido_id: 100, max_inventory_order_ref: 80 })]);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_BELOW_INVENTORY_HISTORY');
    assert.equal(response.body.details.max_pedido_id, 100);
  });

  it('rechaza secuencia debajo del historial de movimientos_inventario.id_ref', async () => {
    const { response } = await runReady([sequenceRow({ sequence_last_value: 100, max_pedido_id: 90, max_inventory_order_ref: 123 })]);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_BELOW_INVENTORY_HISTORY');
    assert.equal(response.body.details.max_inventory_order_ref, 123);
  });

  it('rechaza secuencia inexistente', async () => {
    const { response } = await runReady([sequenceRow({ sequence_name: null, sequence_last_value: null })]);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_SEQUENCE_MISSING');
  });

  it('rechaza tabla pedidos inexistente', async () => {
    const { response } = await runReady([sequenceRow({ pedidos_exists: false })]);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'PEDIDOS_TABLE_MISSING');
  });

  it('rechaza tabla movimientos_inventario inexistente', async () => {
    const { response } = await runReady([sequenceRow({ inventory_exists: false })]);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'MOVIMIENTOS_INVENTARIO_TABLE_MISSING');
  });
});
