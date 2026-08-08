import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

// Incidente: POST /ventas/pedidos-pendientes fallaba con HTTP 500 / Postgres 22001
// (valor excede longitud de columna) porque dos campos derivados no heredaban el
// cap que ya aplican sus fuentes:
//   - telefono_normalizado se calculaba desde el telefono crudo sin limite (columna
//     pedidos_contacto.telefono_normalizado es varchar(30)).
//   - descripcion_envio se armaba concatenando direccion_entrega + referencia_entrega
//     (cada uno ya acotado a <=250/300) sin recortar el resultado final (columna
//     pedidos.descripcion_envio es varchar(250)).
// Este archivo verifica, sobre el codigo fuente real, que ambos quedaron acotados
// y que el catch de la ruta distingue el rechazo definitivo (22001) de un 500 ambiguo.

const getVentasSource = async () => readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

describe('Fix: overflow 22001 en POST /ventas/pedidos-pendientes', () => {
  it('normalizeTelefonoDigits acota el resultado a un maxLength (default 30)', async () => {
    const source = await getVentasSource();
    assert.match(
      source,
      /const normalizeTelefonoDigits = \(value, maxLength = 30\) => \{\s*const digits = String\(value \?\? ''\)\.replace\(\/\\D\/g, ''\);\s*return digits \? digits\.slice\(0, maxLength\) : null;/,
      'normalizeTelefonoDigits debe recortar los digitos a maxLength en vez de devolverlos sin limite.'
    );
  });

  it('telefono_normalizado se calcula desde el telefono ya acotado y con cap explicito de 30', async () => {
    const source = await getVentasSource();
    assert.match(
      source,
      /const telefonoNormalizado = normalizeTelefonoDigits\(telefonoContacto, 30\);/,
      'telefono_normalizado debe pasar por normalizeTelefonoDigits con maxLength=30 (columna pedidos_contacto.telefono_normalizado es varchar(30)).'
    );
  });

  it('descripcion_envio se recorta a 250 caracteres tras concatenar direccion y referencia', async () => {
    const source = await getVentasSource();
    const idx = source.indexOf('descripcion_envio: modalidad === ');
    assert.notEqual(idx, -1, 'No se encontro la construccion de descripcion_envio.');
    const snippet = source.slice(idx, idx + 400);
    assert.match(
      snippet,
      /normalizePedidoText\(\s*\[delivery\.direccion_entrega, delivery\.referencia_entrega \? `Ref: \$\{delivery\.referencia_entrega\}` : null\]\s*\.filter\(Boolean\)\s*\.join\(' \| '\),\s*250\s*\)/,
      'descripcion_envio debe pasar el string concatenado por normalizePedidoText(..., 250) antes de asignarlo (columna pedidos.descripcion_envio es varchar(250)).'
    );
  });

  it('el catch de POST /ventas/pedidos-pendientes distingue 22001 como rechazo definitivo (422) en vez de 500 ambiguo', async () => {
    const source = await getVentasSource();
    const catchIdx = source.indexOf("originalPgErrorCode === '22001'");
    assert.notEqual(catchIdx, -1, 'No se encontro el catch de la ruta pedidos-pendientes.');
    const catchStart = Math.max(0, catchIdx - 400);
    const snippet = source.slice(catchStart, catchIdx + 1200);
    assert.match(
      snippet,
      /originalPgErrorCode === '22001' && !Number\.isInteger\(err\.httpStatus\)/,
      'El catch debe detectar explicitamente el SQLSTATE 22001.'
    );
    assert.match(snippet, /err\.httpStatus = 422;/, 'Un 22001 debe responder 422, no 500.');
    assert.match(
      snippet,
      /err\.code = 'PEDIDO_PENDIENTE_CAMPO_EXCEDE_LONGITUD';/,
      'Debe usar un codigo de negocio estable que el frontend pueda tratar como rechazo definitivo.'
    );
    assert.match(
      snippet,
      /errorCode: originalPgErrorCode/,
      'El registro de fallo idempotente debe conservar el SQLSTATE original (22001) para diagnostico, no el codigo de negocio reescrito.'
    );
  });
});
