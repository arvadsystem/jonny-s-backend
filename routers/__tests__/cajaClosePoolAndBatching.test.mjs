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
    const commitIndex = closeHandlerSource.indexOf("await client.query('COMMIT')");
    const releaseIndex = closeHandlerSource.indexOf('client.release();', commitIndex);
    const queueIndex = closeHandlerSource.indexOf('enqueueCajaCloseEmailNotification', releaseIndex);

    assert.ok(commitIndex > 0);
    assert.ok(releaseIndex > commitIndex);
    assert.ok(queueIndex > releaseIndex);
    assert.doesNotMatch(closeHandlerSource.slice(0, releaseIndex), /sendCajaCierreEmail/);
    assert.doesNotMatch(closeHandlerSource.slice(0, releaseIndex), /buildCajaCierrePdfBuffer/);
  });
});
