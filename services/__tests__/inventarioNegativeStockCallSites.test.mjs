import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const readSource = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

const inventoryOptionsBody = (source) => {
  const callStart = source.indexOf('validarYDescontarPedido(consumoPayloadResult.payload, {');
  assert.notEqual(callStart, -1, 'No se encontro la llamada real al servicio central de inventario.');
  const callEnd = source.indexOf('\n          });', callStart);
  assert.notEqual(callEnd, -1, 'No se encontro el cierre de opciones del servicio de inventario.');
  return source.slice(callStart, callEnd);
};

describe('fronteras reales que habilitan deficit sin aceptar configuracion incompleta', () => {
  it('Ventas fija explicitamente la politica correcta para sus cinco flujos financieros', async () => {
    const source = await readSource('../../routers/ventas.js');
    const wrapperStart = source.indexOf('const validarYDescontarInventarioCajaPedido = async ({');
    const wrapperEnd = source.indexOf('\n};', wrapperStart);
    const wrapper = source.slice(wrapperStart, wrapperEnd);

    assert.match(wrapper, /allowNegativeStock:\s*true/);
    assert.match(wrapper, /allowIncompleteConfiguration:\s*false/);
    assert.equal((source.match(/validarYDescontarInventarioCajaPedido\(\{/g) || []).length, 5);
  });

  it('Cocina permite deficit de producto, receta, extra y salsa pero bloquea estructura invalida', async () => {
    const source = await readSource('../../routers/cocina.js');
    const options = inventoryOptionsBody(source);

    assert.match(options, /allowNegativeStock:\s*true/);
    assert.match(options, /allowIncompleteConfiguration:\s*false/);
    assert.doesNotMatch(options, /strictInsumoIds/);
  });

  it('el endpoint generico de Insumos conserva el default estricto sin opt-in financiero', async () => {
    const source = await readSource('../../routers/insumos.js');
    const callStart = source.indexOf('validarYDescontarPedido(req.body || {}, {');
    const callEnd = source.indexOf('\n    });', callStart);
    const options = source.slice(callStart, callEnd);

    assert.notEqual(callStart, -1);
    assert.doesNotMatch(options, /allowNegativeStock/);
    assert.doesNotMatch(options, /allowIncompleteConfiguration/);
  });
});
