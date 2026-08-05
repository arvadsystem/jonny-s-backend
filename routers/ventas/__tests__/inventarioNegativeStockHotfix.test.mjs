import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

// Hotfix: STOCK_O_CONFIG_INSUFICIENTE bloqueaba con 409 cuando el unico problema
// era stock negativo. validarYDescontarInventarioCajaPedido llamaba a
// validarYDescontarPedido sin allowNegativeStock, por lo que el default false
// bloqueaba la operacion. Este archivo verifica, sobre el codigo fuente real,
// que el fix quedo centralizado en el wrapper y que las 5 llamadas (venta
// pagada RPC v1/v2/legacy, pedido pendiente RPC v1/legacy) capturan y
// propagan la advertencia sin perder el bloqueo de configuraciones invalidas.

const getVentasSource = async () => readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

const getFunctionBody = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `No se encontro: ${signature}`);
  const end = source.indexOf('\n};', start);
  assert.notEqual(end, -1, `No se encontro el cierre de: ${signature}`);
  return source.slice(start, end);
};

describe('Hotfix: stock negativo permitido como advertencia, no como 409', () => {
  it('importa SHORTAGE_MOVEMENT_REF en vez de duplicar el literal FALTANTE_COCINA', async () => {
    const source = await getVentasSource();
    assert.match(
      source,
      /import \{ SHORTAGE_MOVEMENT_REF \} from '\.\.\/services\/inventarioMovimientoService\.js';/,
      'Debe reutilizar la constante exportada, no redeclararla.'
    );
    assert.doesNotMatch(
      source,
      /['"]FALTANTE_COCINA['"]/,
      'No debe duplicar el literal de la constante SHORTAGE_MOVEMENT_REF.'
    );
  });

  it('validarYDescontarInventarioCajaPedido habilita stock negativo sin relajar configuraciones incompletas', async () => {
    const source = await getVentasSource();
    const body = getFunctionBody(source, 'const validarYDescontarInventarioCajaPedido = async ({');

    assert.match(
      body,
      /const inventoryResult = await validarYDescontarPedido\(consumoPayloadResult\.payload, \{\s*id_usuario: idUsuario,\s*dbClient: client,\s*perf,\s*allowNegativeStock: true,\s*allowIncompleteConfiguration: false,\s*shortageMode: SHORTAGE_MOVEMENT_REF\s*\}\);/,
      'El wrapper debe habilitar allowNegativeStock, mantener allowIncompleteConfiguration en false y pasar el shortageMode oficial.'
    );

    // Config invalida (allowIncompleteConfiguration:false) y cualquier otro
    // !ok (incluye CONFIGURACION_INVENTARIO_INVALIDA) deben seguir mapeando a 409.
    assert.match(
      body,
      /if \(!inventoryResult\?\.ok\) \{\s*throw \{\s*httpStatus: 409,/,
      'Un resultado no-ok (p. ej. configuracion invalida) debe seguir lanzando 409.'
    );
  });

  it('las 5 llamadas a validarYDescontarInventarioCajaPedido capturan el resultado (no lo descartan)', async () => {
    const source = await getVentasSource();
    const discarded = (source.match(/(?<!const inventoryOutcome = )await validarYDescontarInventarioCajaPedido\(\{/g) || []);
    const captured = (source.match(/const inventoryOutcome = await validarYDescontarInventarioCajaPedido\(\{/g) || []);
    assert.equal(captured.length, 5, 'Deben existir exactamente 5 sitios que capturan inventoryOutcome (venta v1/v2/legacy, pedido pendiente v1/legacy).');
    assert.equal(discarded.length, 0, 'Ningun sitio debe descartar el resultado; todos necesitan la advertencia para la respuesta.');
  });

  it('cada respuesta exitosa agrega la advertencia antes de guardar el SUCCESS idempotente', async () => {
    const source = await getVentasSource();
    const responseVars = [
      'reconciledRpcResponseBody',
      'responseBody',
      'rpcV2ResponseBody',
      'rpcV1ResponseBody',
      'createVentaResponse'
    ];
    for (const varName of responseVars) {
      const declRe = new RegExp(`const ${varName} = \\{[\\s\\S]{0,600}?\\.\\.\\.\\(inventoryOutcome\\?\\.warning \\? \\{ warning: inventoryOutcome\\.warning \\} : \\{\\}\\)[\\s\\S]{0,20}?\\};`);
      assert.match(source, declRe, `${varName} debe incluir la advertencia de inventario cuando exista.`);

      const declIndex = source.search(declRe);
      const saveIndex = source.indexOf('await saveVentasIdempotencySuccess({', declIndex);
      const saveExternalIndex = source.indexOf('await saveExternalIdempotencySuccessIfNeeded({', declIndex);
      const nextSaveIndex = [saveIndex, saveExternalIndex].filter((i) => i !== -1).sort((a, b) => a - b)[0];
      assert.ok(
        nextSaveIndex !== undefined && nextSaveIndex > declIndex,
        `${varName}: debe guardarse la version con advertencia antes de persistir el SUCCESS idempotente (replay debe reproducirla).`
      );
    }
  });

  it('el wrapper sigue devolviendo PEDIDO_YA_DESCONTADO como ok:true (replay estable, sin doble descuento)', async () => {
    const source = await getVentasSource();
    const body = getFunctionBody(source, 'const validarYDescontarInventarioCajaPedido = async ({');
    assert.match(body, /PEDIDO_YA_DESCONTADO/);
    assert.match(body, /return \{\s*ok: true,\s*code: 'PEDIDO_YA_DESCONTADO'/);
  });
});
