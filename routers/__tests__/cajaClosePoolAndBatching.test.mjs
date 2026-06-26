import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('routers/cajas.js'), 'utf8');
const closeHandlerSource = source.slice(
  source.indexOf('const closeSessionHandler = async'),
  source.indexOf("router.patch('/ventas/cajas/sesiones/:id/cerrar'")
);
const validationAttemptSource = source.slice(
  source.indexOf('const persistCloseValidationAttempt = async'),
  source.indexOf('const buildCloseValidationResponse')
);

describe('caja close pool and batching guards', () => {
  it('no mantiene el advisory lock secundario 8152026', () => {
    assert.doesNotMatch(validationAttemptSource, /8152026/);
    assert.doesNotMatch(validationAttemptSource, /id_sesion_caja::integer/);
  });

  it('inserta metodos de validacion y cierre por lote', () => {
    assert.match(validationAttemptSource, /jsonb_to_recordset\(\$2::jsonb\)/);
    assert.match(closeHandlerSource, /jsonb_to_recordset\(\$5::jsonb\)/);
  });

  it('resuelve CAJA_CUADRA solo cuando no hay diferencias por metodo ni total', () => {
    assert.match(closeHandlerSource, /CAJA_CUADRA/);
    assert.match(closeHandlerSource, /hasMethodDifference/);
    assert.match(closeHandlerSource, /isBalancedClose/);
  });

  it('libera el cliente antes de encolar correo, PDF o SMTP', () => {
    const transactionIndex = closeHandlerSource.indexOf('await withDbTransaction');
    const transactionEndIndex = closeHandlerSource.indexOf("}, { label: 'caja_close_session' })", transactionIndex);
    const queueIndex = closeHandlerSource.indexOf('enqueueCajaCloseEmailNotification', transactionEndIndex);

    assert.ok(transactionIndex > 0);
    assert.ok(transactionEndIndex > transactionIndex);
    assert.ok(queueIndex > transactionEndIndex);
    assert.doesNotMatch(closeHandlerSource.slice(transactionIndex, transactionEndIndex), /sendCajaCierreEmail/);
    assert.doesNotMatch(closeHandlerSource.slice(transactionIndex, transactionEndIndex), /buildCajaCierrePdfBuffer/);
  });

  it('usa withDbTransaction en cierre y validacion', () => {
    assert.match(closeHandlerSource, /withDbTransaction\(async \(client\)/);
    const validationRouteSource = source.slice(
      source.indexOf("router.post('/ventas/cajas/sesiones/:id/cierre-validaciones'"),
      source.indexOf("router.post('/ventas/cajas/sesiones/:id/cierre-preview'")
    );
    assert.match(validationRouteSource, /withDbTransaction\(async \(client\)/);
    assert.doesNotMatch(validationRouteSource, /pool\.connect\(\)/);
    assert.doesNotMatch(validationRouteSource, /isCashierOnlyRequest\(req\)/);
  });
});
