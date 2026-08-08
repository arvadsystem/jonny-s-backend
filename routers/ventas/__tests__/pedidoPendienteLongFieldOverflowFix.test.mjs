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
// Este archivo verifica, sobre el codigo fuente real, que:
//   1. descripcion_envio (resumen derivado, no canonico) queda acotado sin tocar los
//      campos canonicos direccion_entrega/referencia_entrega que van integros a
//      pedidos_delivery.
//   2. telefono_normalizado (RONDA 2) ya NO se trunca en silencio: si excede el limite
//      de la columna se rechaza explicitamente con 422, preservando el dato canonico
//      telefono_contacto tal como lo escribio el usuario.
//   3. el catch de la ruta distingue el rechazo definitivo (22001) de un 500 ambiguo.

const getVentasSource = async () => readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

describe('Fix: overflow 22001 en POST /ventas/pedidos-pendientes', () => {
  it('RONDA 2: telefono_normalizado ya no trunca en silencio -- se valida explicitamente contra el limite de columna (422)', async () => {
    const source = await getVentasSource();
    assert.match(
      source,
      /const PEDIDO_PENDIENTE_TELEFONO_NORMALIZADO_MAX_LENGTH = 30;/,
      'Debe existir una constante explicita para el limite de columna de telefono_normalizado.'
    );
    assert.match(
      source,
      /const validatePedidoPendienteTelefonoNormalizado = \(telefonoContacto\) => \{/,
      'Debe existir un validador dedicado (no un slice silencioso) para telefono_normalizado.'
    );
    assert.doesNotMatch(
      source,
      /telefonoNormalizadoValidation[\s\S]{0,5}=[\s\S]{0,5}normalizeTelefonoDigits/,
      'telefono_normalizado no debe seguir calculandose via normalizeTelefonoDigits (que trunca en silencio) dentro de buildPedidoPendientePayload.'
    );
  });

  it('validatePedidoPendienteTelefonoNormalizado rechaza (422, codigo estable) en vez de truncar cuando excede 30 digitos', async () => {
    const source = await getVentasSource();
    const idx = source.indexOf('const validatePedidoPendienteTelefonoNormalizado = (telefonoContacto) => {');
    assert.notEqual(idx, -1);
    const snippet = source.slice(idx, idx + 700);
    assert.match(snippet, /digits\.length > PEDIDO_PENDIENTE_TELEFONO_NORMALIZADO_MAX_LENGTH/);
    assert.match(snippet, /status: 422/);
    assert.match(snippet, /code: 'PEDIDO_PENDIENTE_TELEFONO_INVALIDO'/);
  });

  it('buildPedidoPendientePayload propaga el rechazo de telefono_normalizado antes de construir el resto del payload', async () => {
    const source = await getVentasSource();
    assert.match(
      source,
      /const telefonoNormalizadoValidation = validatePedidoPendienteTelefonoNormalizado\(telefonoContacto\);\s*\n\s*if \(!telefonoNormalizadoValidation\.ok\) return telefonoNormalizadoValidation;\s*\n\s*const telefonoNormalizado = telefonoNormalizadoValidation\.digits;/,
      'buildPedidoPendientePayload debe retornar el error de validacion de inmediato (ok:false) en lugar de continuar con un valor truncado.'
    );
  });

  it('el objeto `delivery` (canonico, va integro a pedidos_delivery) se pasa intacto y no se deriva de una version recortada', async () => {
    const source = await getVentasSource();
    // El resumen descripcion_envio lee delivery.direccion_entrega/referencia_entrega
    // pero el objeto `delivery` en si -- el que se inserta en pedidos_delivery -- se
    // incluye en el payload de salida sin pasar por normalizePedidoText de nuevo.
    const idx = source.indexOf('descripcion_envio: modalidad === ');
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 900), idx);
    assert.match(
      before,
      /\r?\n\s*delivery,\r?\n/,
      'El campo `delivery` canonico debe pasarse tal cual (sin recorte adicional) justo antes del resumen descripcion_envio.'
    );
    assert.doesNotMatch(
      before,
      /delivery:\s*\{/,
      'delivery no debe reconstruirse/recortarse aqui -- debe ser el mismo objeto ya validado mas arriba.'
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
