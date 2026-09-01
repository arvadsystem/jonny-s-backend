import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  resolveKdsDeliveryMode,
  resolveKdsOrderOrigin,
  resolveLegacyKdsServiceType
} from '../utils/kdsOrderContext.js';
import {
  insertPublicPedidoQuery,
  resolvePublicOrderCatalogContextQuery
} from '../routers/public_menu/publicMenuQueries.js';

const classify = (input) => ({
  origin: resolveKdsOrderOrigin(input),
  mode: resolveKdsDeliveryMode(input)
});

test('matriz KDS separa origen operativo y modalidad de entrega', () => {
  const cases = [
    [{ canalCodigo: 'LOCAL', modalidadCodigo: 'CONSUMO_LOCAL', origenPedido: 'CAJA' }, ['LOCAL', 'COMER_AQUI']],
    [{ canalCodigo: 'LOCAL', modalidadCodigo: 'RECOGER', origenPedido: 'CAJA' }, ['LOCAL', 'PARA_LLEVAR']],
    [{ canalCodigo: 'WHATSAPP', modalidadCodigo: 'RECOGER' }, ['LOCAL', 'PARA_LLEVAR']],
    [{ canalCodigo: 'WHATSAPP', modalidadCodigo: 'DELIVERY' }, ['DELIVERY', 'DELIVERY']],
    [{ canalCodigo: 'TELEFONO', modalidadCodigo: 'DELIVERY' }, ['DELIVERY', 'DELIVERY']],
    [{ canalCodigo: 'MENU_PUBLICO', modalidadCodigo: 'CONSUMO_LOCAL', origenPedido: 'MENU' }, ['WEB', 'COMER_AQUI']],
    [{ canalCodigo: 'MENU_PUBLICO', modalidadCodigo: 'RECOGER' }, ['WEB', 'PARA_LLEVAR']],
    [{ canalCodigo: 'MENU_PUBLICO', modalidadCodigo: 'DELIVERY' }, ['WEB', 'DELIVERY']],
    [{ canalCodigo: 'LOCAL', modalidadCodigo: 'DELIVERY', origenPedido: 'MENU' }, ['WEB', 'DELIVERY']],
    [{ origenPedido: 'CAJA', modalidadCodigo: 'RECOGER' }, ['LOCAL', 'PARA_LLEVAR']],
    [{}, ['NO_DEFINIDO', 'NO_DEFINIDA']]
  ];
  for (const [input, expected] of cases) assert.deepEqual(Object.values(classify(input)), expected);
});

test('fallback legacy se aplica despues de datos estructurados y WEB gana a delivery', () => {
  assert.equal(resolveKdsOrderOrigin({ descripcionPedido: '[public-menu]', modalidadCodigo: 'DELIVERY', hasDelivery: true }), 'WEB');
  assert.equal(resolveKdsDeliveryMode({ descripcionEnvio: 'pedido para llevar' }), 'PARA_LLEVAR');
  assert.equal(resolveLegacyKdsServiceType('COMER_AQUI'), 'LOCAL');
  assert.equal(resolveLegacyKdsServiceType('NO_DEFINIDA'), 'NO_DEFINIDO');
});

test('GET cocina incorpora contexto canónico y expone contrato KDS sin inferencia antigua', async () => {
  const source = await readFile(new URL('../routers/cocina.js', import.meta.url), 'utf8');
  assert.match(source, /pedidos_contexto/);
  assert.match(source, /cat_pedidos_canales/);
  assert.match(source, /cat_pedidos_modalidades_entrega/);
  assert.match(source, /EXISTS[\s\S]*pedidos_delivery/);
  assert.match(source, /origen_pedido_kds: origenPedidoKds/);
  assert.match(source, /modalidad_entrega_kds: modalidadEntregaKds/);
  assert.doesNotMatch(source, /inferTipoServicio/);
});

test('public menu resuelve canal MENU_PUBLICO y modalidad según tipo', async () => {
  for (const [tipoPedido, expectedMode] of [['dine-in', 'CONSUMO_LOCAL'], ['pickup', 'RECOGER'], ['delivery', 'DELIVERY']]) {
    const calls = [];
    const client = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('cat_pedidos_canales')) return { rows: [{ id_canal_pedido: 10 }] };
      return { rows: [{ id_modalidad_entrega: 20 }] };
    } };
    const result = await resolvePublicOrderCatalogContextQuery(client, { tipoPedido }, {
      hasTableFn: async (table) => ['cat_pedidos_canales', 'cat_pedidos_modalidades_entrega'].includes(table)
    });
    assert.deepEqual([result.id_canal_pedido, result.id_modalidad_entrega], [10, 20]);
    assert.deepEqual(calls[0].params, ['MENU_PUBLICO']);
    assert.equal(calls[1].params[0][0], expectedMode);
  }
});

test('cabecera public menu persiste origen MENU y canal MENU_PUBLICO cuando existe', async () => {
  let insert;
  const client = { query: async (sql, params) => { insert = { sql, params }; return { rows: [{ id_pedido: 99 }] }; } };
  await insertPublicPedidoQuery(client, {
    descripcion_pedido: '[public-menu]', descripcion_envio: '', sub_total: 10, isv: 0, total: 10,
    id_estado_pedido: 1, id_sucursal: 2, id_cliente: 3, id_usuario: 4, origen_pedido: 'MENU', tipo_entrega: 'RECOGER'
  }, { hasColumnFn: async (table, column) => ['tipo_entrega', 'canal'].includes(column) });
  assert.match(insert.sql, /origen_pedido/);
  assert.match(insert.sql, /canal/);
  assert.ok(insert.params.includes('MENU'));
  assert.ok(insert.params.includes('MENU_PUBLICO'));
  assert.ok(insert.params.includes('RECOGER'));
});
