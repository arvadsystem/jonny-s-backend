import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('routers/cajas.js'), 'utf8');
const closeHandlerSource = source.slice(
  source.indexOf('const closeSessionHandler = async'),
  source.indexOf("router.patch('/ventas/cajas/sesiones/:id/cerrar'")
);

describe('closeSessionHandler validation requirement', () => {
  it('rechaza cierres definitivos sin validacion persistida', () => {
    assert.match(closeHandlerSource, /VENTAS_CAJAS_CLOSE_VALIDATION_REQUIRED/);
    assert.doesNotMatch(closeHandlerSource, /else if \(!idValidacionCierre\)/);
    assert.doesNotMatch(closeHandlerSource, /monto_declarado_cierre\)/);
    assert.doesNotMatch(closeHandlerSource, /id_arqueo_final\)/);
  });
});
