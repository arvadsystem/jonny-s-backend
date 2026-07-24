import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

// Prueba de regresion (texto de server.js): cubre el riesgo confirmado de que el arranque
// bloqueaba app.listen() con `await checkDatabaseReady()`, dejando el backend en 502 si
// PostgreSQL estaba lento o caido. La logica de retry/backoff/jitter en si se prueba en
// config/__tests__/dbReadiness.test.mjs; esto solo verifica que server.js este cableado
// correctamente: puerto primero, DB en segundo plano, workers solo tras onReady, shutdown
// cancela el retry.
const serverSource = readFileSync(resolve('server.js'), 'utf8');
const repoRoot = resolve('.');
const bootstrapPath = join(repoRoot, 'bootstrap.js');

const httpGetJson = (port, path) => new Promise((resolvePromise, reject) => {
  const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        resolvePromise({ statusCode: res.statusCode, body: JSON.parse(body) });
      } catch {
        resolvePromise({ statusCode: res.statusCode, body: null });
      }
    });
  });
  req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
  req.on('error', reject);
});

const waitForPort = async (port, path, timeoutMs = 8000, intervalMs = 150) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await httpGetJson(port, path);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastError || new Error('WAIT_FOR_PORT_TIMEOUT');
};

const waitForExit = (child, timeoutMs = 5000) => new Promise((resolvePromise) => {
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    resolvePromise(code);
  };
  child.once('exit', (code) => finish(code));
  setTimeout(() => finish(null), timeoutMs);
});

describe('server.js: el puerto abre sin esperar a PostgreSQL', () => {
  it('ya no bloquea el arranque esperando checkDatabaseReady() antes de escuchar', () => {
    assert.doesNotMatch(
      serverSource,
      /await\s+checkDatabaseReady\(\)/,
      'checkDatabaseReady() no debe volver a bloquear el arranque con un await previo a app.listen()'
    );
  });

  it('rastrea la disponibilidad de PostgreSQL en segundo plano via config/dbReadiness.js', () => {
    assert.match(serverSource, /from '\.\/config\/dbReadiness\.js'/);
    assert.match(serverSource, /startDatabaseReadinessLoop\(/);
  });

  it('startDatabaseReadinessLoop() se invoca dentro del callback de app.listen(), nunca antes', () => {
    const listenIndex = serverSource.indexOf('app.listen(PORT');
    const startIndex = serverSource.indexOf('startDatabaseReadinessLoop(');
    assert.ok(listenIndex >= 0, 'debe existir app.listen(PORT');
    assert.ok(startIndex >= 0, 'debe existir una llamada a startDatabaseReadinessLoop(');
    assert.ok(startIndex > listenIndex, 'startDatabaseReadinessLoop() debe aparecer despues de app.listen(PORT (dentro de su callback)');
    assert.doesNotMatch(
      serverSource,
      /await\s+startDatabaseReadinessLoop\(/,
      'startDatabaseReadinessLoop() no debe esperarse (await): es fire-and-forget, nunca bloquea el arranque'
    );
  });

  it('los workers arrancan unicamente dentro del callback onReady (una sola vez, tras confirmar la DB)', () => {
    const onReadyIndex = serverSource.indexOf('onReady:');
    const cajaStartIndex = serverSource.indexOf('startCajaCloseEmailOutboxWorker()');
    const cutoffStartIndex = serverSource.indexOf('startOperationalSessionCutoffWorker()');
    assert.ok(onReadyIndex >= 0, 'debe existir un callback onReady');
    assert.ok(cajaStartIndex > onReadyIndex, 'el worker de outbox debe arrancar dentro de onReady');
    assert.ok(cutoffStartIndex > onReadyIndex, 'el worker de corte operativo debe arrancar dentro de onReady');
    assert.match(serverSource, /startCajaCloseEmailOutboxWorker\(\)\.catch\(/);
    assert.match(serverSource, /startOperationalSessionCutoffWorker\(\)\.catch\(/);
  });

  it('el shutdown detiene el monitor de DB, espera el chequeo en vuelo (acotado) y solo entonces cierra HTTP/workers/pool', () => {
    const stopDbIndex = serverSource.indexOf('stopDatabaseReadinessLoop({ timeoutMs: 5000 })');
    const closeHttpIndex = serverSource.indexOf('closeHttpServer()');
    assert.ok(stopDbIndex >= 0, 'debe existir una llamada a stopDatabaseReadinessLoop({ timeoutMs: 5000 })');
    assert.ok(stopDbIndex < closeHttpIndex, 'debe detener/esperar el monitor de DB antes de cerrar el servidor HTTP');
    assert.match(
      serverSource,
      /stopDatabaseReadinessLoop\(\{ timeoutMs: 5000 \}\)\s*\n\s*\.then\(\(\)\s*=>\s*closeHttpServer\(\)\)/,
      'closeHttpServer() debe encadenarse DESPUES de que stopDatabaseReadinessLoop() resuelva (o venza su timeout), no en paralelo'
    );
    assert.match(serverSource, /stopCajaCloseEmailOutboxWorker\(\{ timeoutMs: 5000 \}\)/);
    assert.match(serverSource, /stopOperationalSessionCutoffWorker\(\{ timeoutMs: 5000 \}\)/);
    assert.match(serverSource, /closePool\(\)/);
  });
});

describe('server.js (proceso real): el puerto abre aunque PostgreSQL sea inalcanzable', () => {
  // Nota de plataforma: en Windows, child.kill('SIGTERM') termina el proceso hijo de forma
  // forzada -- Node no puede entregarle una senal real, asi que process.once('SIGTERM', ...)
  // del hijo nunca llega a ejecutarse (limitacion documentada de Node en Windows, no un bug
  // de server.js). Por eso este test no valida el shutdown limpio via una senal real; esa
  // cobertura (stopDatabaseReadinessLoop cancela el retry, etc.) vive en
  // config/__tests__/dbReadiness.test.mjs y en el bloque estructural de arriba. Aqui solo se
  // valida, con un proceso real, la parte que SI se puede probar de forma portable: el
  // puerto abre y responde aunque PostgreSQL sea inalcanzable.
  it('/health/live responde 200 y /health/ready responde 503 con un DB_HOST invalido', async () => {
    const port = 34599;
    const child = spawn(process.execPath, [bootstrapPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PROCESS_ROLE: 'web',
        PORT: String(port),
        // TEST-NET-1 (RFC 5737): direccion garantizada no enrutable. Nunca toca produccion
        // ni ningun host real; solo sirve para simular "PostgreSQL inalcanzable" de forma
        // deterministica y rapida (con el timeout acotado abajo).
        DB_HOST: '192.0.2.1',
        DB_CONNECTION_TIMEOUT_MS: '1000',
        DB_POOL_MAX: '2'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    try {
      const live = await waitForPort(port, '/health/live', 8000);
      assert.equal(live.statusCode, 200, `esperaba 200 en /health/live; stderr: ${stderr}`);
      assert.equal(live.body?.status, 'alive');

      const ready = await httpGetJson(port, '/health/ready');
      assert.equal(ready.statusCode, 503);
      assert.equal(ready.body?.status, 'not_ready');
    } finally {
      child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
      await waitForExit(child, 5000); // nunca dejar un proceso de prueba huerfano
    }
  });
});
