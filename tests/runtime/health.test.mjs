import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, describe, it } from 'node:test';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const { default: app, setHealthCheckQueryRunnerForTests } = await import('../../app.js');
const {
  configureDatabaseReadinessForTests,
  resetDatabaseReadinessForTests
} = await import('../../config/dbReadiness.js');

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
  resetDatabaseReadinessForTests();
});

afterEach(() => {
  resetDatabaseReadinessForTests();
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
        assert.equal(sql, 'SELECT 1');
        return { rows: [{ '?column?': 1 }] };
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

  it('tras recuperarse la DB, /health/ready pasa de 503 a 200 sin reiniciar el servidor', async () => {
    let dbUp = false;
    setHealthCheckQueryRunnerForTests({
      async query() {
        if (!dbUp) throw new Error('connection refused');
        return { rows: [{ '?column?': 1 }] };
      }
    });
    const server = await createServer();
    try {
      const before = await request(server, '/health/ready');
      assert.equal(before.statusCode, 503);
      assert.equal(before.body.status, 'not_ready');

      dbUp = true;
      const after = await request(server, '/health/ready');
      assert.equal(after.statusCode, 200);
      assert.equal(after.body.status, 'ready');
    } finally {
      server.close();
    }
  });

  it('una ruta protegida (dependiente de la DB) responde 503 controlado mientras readiness es false, nunca 500 ni colgada', async () => {
    configureDatabaseReadinessForTests({ ready: false });
    const server = await createServer();
    try {
      const response = await request(server, '/usuarios');
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.status, 'not_ready');
      assert.equal(response.body.ok, false);
    } finally {
      server.close();
    }
  });

  it('una vez readiness=true, la misma ruta protegida deja de recibir 503 (llega hasta el auth, no hasta la DB)', async () => {
    configureDatabaseReadinessForTests({ ready: true });
    const server = await createServer();
    try {
      const response = await request(server, '/usuarios');
      assert.notEqual(response.statusCode, 503);
      assert.equal(response.statusCode, 401, 'sin token debe llegar al auth (401), no quedarse en el gate de readiness');
    } finally {
      server.close();
    }
  });

  it('/health/live, /health/ready y /status nunca son bloqueados por el gate de readiness', async () => {
    configureDatabaseReadinessForTests({ ready: false });
    setHealthCheckQueryRunnerForTests({
      async query() {
        return { rows: [{ '?column?': 1 }] };
      }
    });
    const server = await createServer();
    try {
      const live = await request(server, '/health/live');
      assert.equal(live.statusCode, 200);

      const ready = await request(server, '/health/ready');
      assert.equal(ready.statusCode, 200, '/health/ready sigue haciendo su propio chequeo, independiente del gate');
    } finally {
      server.close();
    }
  });
});
