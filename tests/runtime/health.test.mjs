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
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
    });
  });
  req.on('error', reject);
  req.end();
});

const createServer = () => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

after(() => {
  setHealthCheckQueryRunnerForTests();
});

describe('web health checks', () => {
  it('GET /health/live responde sin consultar DB', async () => {
    let queries = 0;
    setHealthCheckQueryRunnerForTests({
      async query() {
        queries += 1;
        return { rows: [] };
      }
    });
    const server = await createServer();
    try {
      const response = await request(server, '/health/live');
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, 'alive');
      assert.equal(response.body.role, 'web');
      assert.equal(queries, 0);
    } finally {
      server.close();
    }
  });

  it('GET /health/ready responde 200 cuando SELECT 1 funciona', async () => {
    setHealthCheckQueryRunnerForTests({
      async query(sql) {
        if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
        assert.match(sql, /information_schema\.columns/);
        return { rows: [{ is_generated: 'NEVER' }] };
      }
    });
    const server = await createServer();
    try {
      const response = await request(server, '/health/ready');
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, 'ready');
      assert.equal(response.body.database, 'ok');
      assert.equal(response.body.role, 'web');
    } finally {
      server.close();
    }
  });

  it('GET /health/ready responde 503 cuando id_pedido_trazabilidad sigue generado', async () => {
    setHealthCheckQueryRunnerForTests({
      async query(sql) {
        if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
        assert.match(sql, /information_schema\.columns/);
        return { rows: [{ is_generated: 'ALWAYS' }] };
      }
    });
    const server = await createServer();
    try {
      const response = await request(server, '/health/ready');
      const serialized = JSON.stringify(response.body);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.status, 'not_ready');
      assert.equal(response.body.database, 'error');
      assert.doesNotMatch(serialized, /password|host|user|connectionString|stack/i);
    } finally {
      server.close();
    }
  });

  it('GET /health/ready responde 503 cuando falta id_pedido_trazabilidad', async () => {
    setHealthCheckQueryRunnerForTests({
      async query(sql) {
        if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
        assert.match(sql, /information_schema\.columns/);
        return { rows: [] };
      }
    });
    const server = await createServer();
    try {
      const response = await request(server, '/health/ready');
      const serialized = JSON.stringify(response.body);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.status, 'not_ready');
      assert.equal(response.body.database, 'error');
      assert.doesNotMatch(serialized, /password|host|user|connectionString|stack/i);
    } finally {
      server.close();
    }
  });

  it('GET /health/ready responde 503 sin filtrar datos sensibles', async () => {
    setHealthCheckQueryRunnerForTests({
      async query() {
        throw new Error('password host user connectionString stack');
      }
    });
    const server = await createServer();
    try {
      const response = await request(server, '/health/ready');
      const serialized = JSON.stringify(response.body);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.status, 'not_ready');
      assert.equal(response.body.database, 'error');
      assert.doesNotMatch(serialized, /password|host|user|connectionString|stack/i);
    } finally {
      server.close();
    }
  });
});
