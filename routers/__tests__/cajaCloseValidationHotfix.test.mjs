import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const routerSource = readFileSync(new URL('../cajas.js', import.meta.url), 'utf8');
const routeStart = routerSource.indexOf(
  "router.post('/ventas/cajas/sesiones/:id/cierre-validaciones'"
);
const routeEnd = routerSource.indexOf(
  "router.post('/ventas/cajas/sesiones/:id/cierre-preview'",
  routeStart
);
const routeSource = routerSource.slice(routeStart, routeEnd);
const persistStart = routerSource.indexOf('const persistCloseValidationAttempt = async');
const persistEnd = routerSource.indexOf('const buildCloseValidationResponse', persistStart);
const persistSource = routerSource.slice(persistStart, persistEnd);

test('cierre-validaciones exige observaciones antes de persistir y conserva el lock transaccional', () => {
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(routeSource, /withDbTransaction/);
  assert.match(routeSource, /await lockCajaFinancialSession\(client, idSesionCaja\)/);
  assert.match(routeSource, /ensureOpenSession\(client, idSesionCaja, \{ forUpdate: true \}\)/);
  assert.match(routeSource, /requireObservacionOnDifference: true/);
  assert.ok(
    routeSource.indexOf('requireObservacionOnDifference: true')
      < routeSource.indexOf('persistCloseValidationAttempt')
  );
});

test('persistencia reutiliza la ultima validacion no vinculada antes del insert', () => {
  assert.match(persistSource, /AND v\.id_cierre_caja IS NULL/);
  assert.match(persistSource, /ORDER BY v\.numero_intento DESC/);
  assert.match(persistSource, /FOR UPDATE OF v/);
  assert.match(persistSource, /isReusableCloseValidation/);
  assert.match(persistSource, /reutilizada: true/);
  assert.match(persistSource, /reutilizada: false/);
  assert.ok(
    persistSource.indexOf('isReusableCloseValidation')
      < persistSource.indexOf('INSERT INTO public.cajas_cierres_validaciones')
  );
});
