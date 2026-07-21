import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('password y Google crean sesiones exclusivas solo para Cliente', async () => {
  const [clientSource, internalLoginSource] = await Promise.all([
    readSource('routers/public_cliente.js'),
    readSource('routers/login.js')
  ]);

  assert.equal((clientSource.match(/await createExclusiveClientSession\(/g) || []).length, 2);
  assert.doesNotMatch(clientSource, /await createSession\(/);
  assert.match(internalLoginSource, /import \{ createSession, closeSession \}/);
  assert.match(internalLoginSource, /await createSession\(/);
  assert.match(clientSource, /expiresIn:\s*'8h'/);
  assert.ok((clientSource.match(/maxAge:\s*1000 \* 60 \* 60 \* 8/g) || []).length >= 2);
});

test('/me valida sesion, renueva P_COCINA y actualiza ultima_actividad sin cambiar su respuesta', async () => {
  const [source, touchSource, sessionSource] = await Promise.all([
    readSource('routers/login.js'),
    readSource('middleware/touchSession.js'),
    readSource('utils/security/sessionService.js')
  ]);

  assert.match(
    source,
    /router\.get\('\/me', authRequired, requireActiveSession, refreshKitchenDisplaySession, requireSessionTouchMiddleware, async \(req, res\) =>/
  );
  assert.match(source, /issueCsrf\(req, res, \{ reuseIfPresent: true \}\)/);
  assert.match(touchSource, /const touched = await touchSession\(user\.sid\)/);
  assert.match(touchSource, /if \(touched !== 1\)/);
  assert.match(sessionSource, /return result\.rowCount \|\| 0/);
  assert.match(sessionSource, /make_interval\([\s\S]*mins => \(CASE[\s\S]*END\)::integer/);
});

test('la renovacion P_COCINA ocurre despues de auth y sesion activa', async () => {
  const source = await readSource('app.js');
  const authIndex = source.indexOf('app.use(authRequired)');
  const activeIndex = source.indexOf('app.use(requireActiveSession)');
  const refreshIndex = source.indexOf('app.use(refreshKitchenDisplaySession)');
  const passwordIndex = source.indexOf('app.use(requirePasswordChange)');
  const touchIndex = source.indexOf('app.use(touchSessionMiddleware)');
  const csrfIndex = source.indexOf('app.use(csrfProtect)');

  assert.ok(authIndex >= 0 && authIndex < activeIndex);
  assert.ok(activeIndex < refreshIndex);
  assert.ok(refreshIndex < passwordIndex);
  assert.ok(passwordIndex < touchIndex);
  assert.ok(touchIndex < csrfIndex);
});

test('pedidos publicos validan JWT, sesion activa, CSRF, Cliente y touch antes del negocio', async () => {
  const [middlewareSource, routerSource] = await Promise.all([
    readSource('routers/public_menu/publicMenuAuthMiddleware.js'),
    readSource('routers/public_menu/publicMenuOrderRouter.js')
  ]);

  const authChain = middlewareSource.slice(
    middlewareSource.indexOf('export const requireAuthenticatedPublicCustomer'),
    middlewareSource.indexOf('];', middlewareSource.indexOf('export const requireAuthenticatedPublicCustomer'))
  );
  const jwtIndex = authChain.indexOf('publicMenuAuthRequired');
  const activeIndex = authChain.indexOf('requireActiveSession');
  const csrfIndex = authChain.indexOf('publicMenuCsrfProtect');
  const roleIndex = authChain.indexOf("tipoUsuario !== 'CLIENTE'");
  const touchIndex = authChain.indexOf('touchSessionMiddleware');

  assert.ok(jwtIndex >= 0 && jwtIndex < activeIndex);
  assert.ok(activeIndex < csrfIndex);
  assert.ok(csrfIndex < roleIndex);
  assert.ok(roleIndex < touchIndex);
  assert.match(routerSource, /'\/pedidos',[\s\S]*requireAuthenticatedPublicCustomer[\s\S]*createPublicOrderController/);
});

test('el worker se registra una vez en arranque y participa en shutdown', async () => {
  const source = await readSource('server.js');

  assert.equal((source.match(/await startOperationalSessionCutoffWorker\(\)/g) || []).length, 1);
  assert.match(source, /stopOperationalSessionCutoffWorker\(\{ timeoutMs: 5000 \}\)/);
});
