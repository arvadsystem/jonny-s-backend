import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, describe, it } from 'node:test';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';

const { default: app } = await import('../../app.js');
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
  resetDatabaseReadinessForTests();
});

afterEach(() => {
  resetDatabaseReadinessForTests();
});

describe('web health checks', () => {
  it('GET /health/live responde 200 sin importar el estado de readiness, y nunca consulta la DB', async () => {
    let checkCalls = 0;
    configureDatabaseReadinessForTests({
      ready: false,
      checkDatabaseReady: async () => { checkCalls += 1; return true; }
    });
    const server = await createServer();
    try {
      const response = await request(server, '/health/live');
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, 'alive');
      assert.equal(response.body.role, 'web');
      assert.equal(checkCalls, 0, '/health/live nunca debe disparar un chequeo de DB');
    } finally {
      server.close();
    }
  });

  it('GET /health/ready responde 200 cuando el estado compartido de readiness es true', async () => {
    configureDatabaseReadinessForTests({ ready: true });
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

  it('GET /health/ready responde 503 cuando el estado compartido de readiness es false, sin exponer detalles internos', async () => {
    configureDatabaseReadinessForTests({ ready: false });
    const server = await createServer();
    try {
      const response = await request(server, '/health/ready');
      const serialized = JSON.stringify(response.body);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.status, 'not_ready');
      assert.equal(response.body.database, 'error');
      // La ruta ya no ejecuta ni observa el error real del chequeo (vive por completo en el
      // monitor de segundo plano, ver config/dbReadiness.js): no hay forma de que un mensaje
      // de error termine en la respuesta HTTP.
      assert.doesNotMatch(serialized, /password|host|user|connectionString|stack/i);
    } finally {
      server.close();
    }
  });

  it('tras recuperarse la DB, /health/ready pasa de 503 a 200 sin reiniciar el servidor', async () => {
    configureDatabaseReadinessForTests({ ready: false });
    const server = await createServer();
    try {
      const before = await request(server, '/health/ready');
      assert.equal(before.statusCode, 503);
      assert.equal(before.body.status, 'not_ready');

      configureDatabaseReadinessForTests({ ready: true });
      const after = await request(server, '/health/ready');
      assert.equal(after.statusCode, 200);
      assert.equal(after.body.status, 'ready');
    } finally {
      server.close();
    }
  });

  it('no existe un query/chequeo independiente por cada llamada a /health/ready', async () => {
    let checkCalls = 0;
    configureDatabaseReadinessForTests({
      ready: true,
      checkDatabaseReady: async () => { checkCalls += 1; return true; }
    });
    const server = await createServer();
    try {
      for (let i = 0; i < 5; i += 1) {
        const response = await request(server, '/health/ready');
        assert.equal(response.statusCode, 200);
      }
      assert.equal(checkCalls, 0, '/health/ready solo lee el estado ya calculado por el monitor, nunca dispara un chequeo propio');
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

  it('/health/ready y una ruta protegida siempre reflejan el mismo estado compartido de readiness', async () => {
    const server = await createServer();
    try {
      for (const ready of [false, true, false]) {
        configureDatabaseReadinessForTests({ ready });
        const healthReady = await request(server, '/health/ready');
        const protectedRoute = await request(server, '/usuarios');

        assert.equal(healthReady.statusCode === 200, ready, `/health/ready debe reflejar ready=${ready}`);
        assert.equal(protectedRoute.statusCode !== 503, ready, `la ruta protegida debe reflejar ready=${ready}`);
      }
    } finally {
      server.close();
    }
  });

  it('/health/live nunca es bloqueado por el gate de rutas de negocio, incluso con readiness=false', async () => {
    configureDatabaseReadinessForTests({ ready: false });
    const server = await createServer();
    try {
      const live = await request(server, '/health/live');
      assert.equal(live.statusCode, 200);
    } finally {
      server.close();
    }
  });
});
