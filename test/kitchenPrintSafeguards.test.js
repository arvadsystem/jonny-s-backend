import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVentaKitchenPrintPayload } from '../routers/ventas/handlers/ventasPrintHandlers.js';
import {
  routeKitchenPrintItems
} from '../routers/ventas/services/kitchenPrintRoutingService.js';
import {
  canRequestPedidoStateTransition
} from '../routers/ventas/services/pedidoStatePermissionService.js';
import { enqueuePedidoComandaPrintJob } from '../routers/printing.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import { createCanonicalPrintJob } from '../services/printJobDocumentService.js';

const recipe = (name = 'Hamburguesa') => ({
  id_detalle: 1,
  tipo_item: 'RECETA',
  id_receta: 10,
  cantidad: 1,
  nombre_item: name
});

const product = (deliverWithOrder, name = 'Coca-Cola') => ({
  id_detalle: 2,
  tipo_item: 'PRODUCTO',
  id_producto: 20,
  cantidad: 1,
  nombre_item: name,
  configuracion_menu: deliverWithOrder === undefined
    ? null
    : { entregar_con_pedido: deliverWithOrder }
});

const baseSale = (items) => ({
  id_factura: 40,
  id_pedido: 30,
  id_sucursal: 1,
  numero_venta: 'VTA-00040',
  items
});

test('venta inmediata incluye receta y producto de entrega conjunta', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe(), product(true)]));
  assert.deepEqual(payload.items.map((item) => item.instruccion_operativa), [
    'PREPARAR',
    'ENTREGAR_JUNTO_CON_EL_PEDIDO'
  ]);
});

test('venta inmediata excluye producto de entrega inmediata', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe(), product(false)]));
  assert.deepEqual(payload.items.map((item) => item.nombre_item), ['Hamburguesa']);
});

test('pedido pendiente incluye producto conjunto junto a la preparacion', () => {
  const items = routeKitchenPrintItems([recipe(), product(true)]);
  assert.deepEqual(items.map((item) => item.nombre_item), ['Hamburguesa', 'Coca-Cola']);
});

test('pedido pendiente excluye producto de entrega inmediata', () => {
  const items = routeKitchenPrintItems([recipe(), product(false)]);
  assert.deepEqual(items.map((item) => item.nombre_item), ['Hamburguesa']);
});

test('venta solo-producto no genera documento de comanda', async () => {
  await assert.rejects(
    () => createCanonicalPrintJob({
      tipoDocumento: 'comanda',
      venta: baseSale([product(true)]),
      widthMm: 80
    }),
    (error) => error.status === 409 && error.code === 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  );
});

test('pedido solo-producto no crea ni encola trabajo de comanda', async () => {
  let createCalls = 0;
  let enqueueCalls = 0;
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({
      req: { user: { id_usuario: 5 } },
      idPedido: 30,
      tipoDocumento: 'comanda',
      loadPedido: async () => ({
        id_pedido: 30,
        id_factura: null,
        id_sucursal: 1,
        items: [product(true)]
      }),
      createPayload: async () => { createCalls += 1; },
      enqueue: async () => { enqueueCalls += 1; }
    }),
    (error) => error.status === 409 && error.code === 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  );
  assert.equal(createCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test('extra independiente genera comanda como PREPARAR sin extra anidado', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([{
    id_detalle: 3,
    tipo_item: 'EXTRA',
    id_extra: 8,
    cantidad: 2,
    nombre_item: 'Extra queso',
    es_linea_extra_independiente: true,
    extras: [{ id_extra: 8, nombre: 'Extra queso', cantidad: 2 }]
  }]));
  assert.equal(payload.requiere_cocina, true);
  assert.equal(payload.items[0].instruccion_operativa, 'PREPARAR');
  assert.deepEqual(payload.items[0].extras, []);
});

test('comanda separa PREPARAR y ENTREGAR JUNTO CON EL PEDIDO', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe(), product(true)]));
  const html = buildComandaCocinaHtml(payload, { widthMm: 58 });
  assert.match(html, />PREPARAR</);
  assert.match(html, />ENTREGAR JUNTO CON EL PEDIDO</);
  assert.ok(html.indexOf('Hamburguesa') < html.indexOf('Coca-Cola'));
});

test('comanda sin productos acompanantes omite la seccion vacia', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe()]));
  const html = buildComandaCocinaHtml(payload, { widthMm: 80 });
  assert.match(html, />PREPARAR</);
  assert.doesNotMatch(html, />ENTREGAR JUNTO CON EL PEDIDO</);
});

test('administrador conserva autorizacion operativa para cambiar estado', async () => {
  const allowed = await canRequestPedidoStateTransition({
    req: {},
    targetState: 'EN_COCINA',
    hasAnyRole: async (_req, roles) => roles.includes('ADMINISTRADOR'),
    hasAnyPermission: async () => false
  });
  assert.equal(allowed, true);
});

test('usuario con solo permiso de lectura no puede cambiar estado', async () => {
  const allowed = await canRequestPedidoStateTransition({
    req: {},
    targetState: 'EN_COCINA',
    hasAnyRole: async () => false,
    hasAnyPermission: async (_req, permissions) => permissions.includes('VENTAS_VER')
  });
  assert.equal(allowed, false);
});
