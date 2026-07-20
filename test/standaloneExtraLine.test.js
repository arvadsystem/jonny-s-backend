import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStandaloneExtraLine } from '../routers/ventas/utils/parseUtils.js';
import { buildPedidoKitchenPrintPayload } from '../routers/ventas/services/pedidoKitchenPrintPayloadService.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import { buildVentaTicketPdfDefinition } from '../routers/ventas/services/ventaTicketPdfService.js';
import { buildVentaDetailPayloadForScope } from '../routers/ventas/handlers/ventasReadHandlers.js';

test('linea sin producto/receta con exactamente un extra se clasifica como EXTRA con snapshot financiero', () => {
  const result = resolveStandaloneExtraLine({
    idProducto: null,
    idReceta: null,
    extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH', cantidad: 4, precio_unitario: 10, subtotal: 40 }]
  });
  assert.deepEqual(result, {
    id_extra: 3,
    nombre_extra_snapshot: 'Extra Ranch',
    codigo_extra_snapshot: 'EXT-RANCH',
    cantidad: 4,
    precio_unitario: 10,
    subtotal: 40
  });
});

test('no clasifica como extra si tiene producto/receta o si hay 0 o varios extras', () => {
  assert.equal(resolveStandaloneExtraLine({ idProducto: 5, idReceta: null, extras: [{ nombre: 'X' }] }), null);
  assert.equal(resolveStandaloneExtraLine({ idProducto: null, idReceta: 9, extras: [{ nombre: 'X' }] }), null);
  assert.equal(resolveStandaloneExtraLine({ idProducto: null, idReceta: null, extras: [] }), null);
  assert.equal(resolveStandaloneExtraLine({
    idProducto: null,
    idReceta: null,
    extras: [{ nombre: 'A' }, { nombre: 'B' }]
  }), null);
});

test('extra sin nombre no se clasifica como valido', () => {
  assert.equal(resolveStandaloneExtraLine({ idProducto: null, idReceta: null, extras: [{ id_extra: 3, cantidad: 2 }] }), null);
});

for (const scenario of [
  { nombre: 'Extra bacon', cantidad: 4, precio_unitario: 30, subtotal: 120 },
  { nombre: 'Extra Ranch', cantidad: 4, precio_unitario: 10, subtotal: 40 },
  { nombre: 'Extra papas sazonadas', cantidad: 3, precio_unitario: 40, subtotal: 120 }
]) {
  test(`cantidad x precio_unitario = subtotal para ${scenario.nombre}`, () => {
    const line = resolveStandaloneExtraLine({
      idProducto: null,
      idReceta: null,
      extras: [{ id_extra: 9, nombre: scenario.nombre, cantidad: scenario.cantidad, precio_unitario: scenario.precio_unitario, subtotal: scenario.subtotal }]
    });
    assert.equal(line.cantidad * line.precio_unitario, line.subtotal);
  });
}

const buildPedidoQueryRunner = (rows) => ({
  query: async (sql) => {
    if (sql.includes('information_schema.')) return { rowCount: 1, rows: [{ exists: 1 }] };
    return { rowCount: 1, rows: [{ id_pedido: 501, id_sucursal: 9, numero_pedido: 'PED-00501', items: rows }] };
  }
});

test('pedido con extra independiente se normaliza sin "Item de pedido" y con cantidad del snapshot', async () => {
  const queryRunner = buildPedidoQueryRunner([{
    id_detalle: 900, id_detalle_pedido: 900, tipo_item: 'ITEM',
    id_producto: null, id_receta: null,
    nombre_item: 'Item de pedido', nombre_producto: 'Item de pedido',
    cantidad: 4, observacion: null,
    extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH', cantidad: 4, precio_unitario: 10, subtotal: 40 }],
    configuracion_menu: null
  }]);

  const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 501);
  const item = pedido.items[0];
  assert.equal(item.tipo_item, 'EXTRA');
  assert.equal(item.nombre_item, 'Extra Ranch');
  assert.equal(item.es_linea_extra_independiente, true);
  assert.equal(item.id_extra, 3);
  assert.equal(item.codigo_extra_snapshot, 'EXT-RANCH');
  assert.equal(item.cantidad, 4);

  const html = buildComandaCocinaHtml(pedido, { widthMm: 80 });
  assert.match(html, /Extra Ranch/);
  assert.doesNotMatch(html, /Item de pedido/);
  assert.doesNotMatch(html, /Extra:\s*Extra Ranch/i);
});

test('el contador de productos excluye lineas EXTRA', async () => {
  const queryRunner = buildPedidoQueryRunner([
    { id_detalle: 1, id_detalle_pedido: 1, tipo_item: 'PRODUCTO', id_producto: 10, id_receta: null, nombre_item: '6 Alitas', cantidad: 1, extras: [], configuracion_menu: null },
    { id_detalle: 2, id_detalle_pedido: 2, tipo_item: 'ITEM', id_producto: null, id_receta: null, nombre_item: 'Item de pedido', cantidad: 4, extras: [{ id_extra: 3, nombre: 'Extra bacon', cantidad: 4, precio_unitario: 30, subtotal: 120 }], configuracion_menu: null },
    { id_detalle: 3, id_detalle_pedido: 3, tipo_item: 'ITEM', id_producto: null, id_receta: null, nombre_item: 'Item de pedido', cantidad: 4, extras: [{ id_extra: 4, nombre: 'Extra Ranch', cantidad: 4, precio_unitario: 10, subtotal: 40 }], configuracion_menu: null },
    { id_detalle: 4, id_detalle_pedido: 4, tipo_item: 'ITEM', id_producto: null, id_receta: null, nombre_item: 'Item de pedido', cantidad: 3, extras: [{ id_extra: 5, nombre: 'Extra papas', cantidad: 3, precio_unitario: 40, subtotal: 120 }], configuracion_menu: null }
  ]);
  const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 501);
  assert.equal(pedido.total_productos, 1);
  assert.equal(pedido.items.filter((i) => i.tipo_item === 'EXTRA').length, 3);
});

test('buildPedidoKitchenPrintPayload legacy (v2) conserva "Item de pedido" y no normaliza', async () => {
  const queryRunner = buildPedidoQueryRunner([{
    id_detalle: 900, id_detalle_pedido: 900, tipo_item: 'ITEM',
    id_producto: null, id_receta: null,
    nombre_item: 'Item de pedido', nombre_producto: 'Item de pedido',
    cantidad: 4, observacion: null,
    extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH', cantidad: 4, precio_unitario: 10, subtotal: 40 }],
    configuracion_menu: null
  }]);
  const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 501, { normalizeStandaloneExtras: false });
  const item = pedido.items[0];
  assert.equal(item.es_linea_extra_independiente, false);
  assert.equal(item.tipo_item, 'ITEM');
  assert.equal(item.nombre_item, 'Item de pedido');
});

test('el ticket de factura no duplica el extra como fila y como detalle anidado', () => {
  const venta = {
    id_factura: 12,
    fecha_hora_facturacion: '2026-07-19T23:39:35.024Z',
    sub_total: 40, total: 40,
    items: [{
      id_detalle: 1, cantidad: 4, nombre_item: 'Extra Ranch',
      total_linea: 40, sub_total: 40, es_linea_extra_independiente: true,
      extras: [{ nombre: 'Extra Ranch', cantidad: 4, subtotal: 40 }]
    }]
  };
  const definition = buildVentaTicketPdfDefinition(venta);
  const texts = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.text !== undefined) texts.push(String(value.text));
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'text') walk(child);
    }
  };
  walk(definition.content);
  assert.equal(texts.filter((t) => t.includes('Extra Ranch')).length, 1);
  assert.doesNotMatch(texts.join('\n'), /\+ Extra Ranch/);
});

// --- Prueba integral post-facturacion: buildVentaDetailPayloadForScope --------

const buildFacturaDetailQueryRunner = () => {
  const kitchenRow = {
    id_detalle: 71,
    id_detalle_pedido: 501,
    tipo_item: 'ITEM',
    id_producto: null,
    id_receta: null,
    nombre_item: 'Item de cocina',
    nombre_producto: 'Item de cocina',
    cantidad: 4,
    precio_unitario: 40,
    sub_total: 40,
    subtotal_linea: 40,
    total_linea: 40,
    descuento: 0, descuento_linea: 0, descuento_global: 0,
    observacion: null,
    origen_snapshot: {}
  };
  const facturaExtraRow = {
    id_detalle_factura: 71,
    id_extra: 3,
    nombre: 'Extra Ranch',
    codigo_extra_snapshot: 'EXT-RANCH',
    cantidad: 4,
    precio_unitario: 10,
    subtotal: 40
  };
  return {
    query: async (sql) => {
      if (sql.includes('information_schema.')) return { rowCount: 1, rows: [{ exists: 1 }] };
      if (/FROM\s+facturas\s+f/i.test(sql)) {
        return { rowCount: 1, rows: [{
          id_factura: 12, codigo_venta: 'VTA-00012', id_pedido: 501,
          fecha_hora_pedido: '2026-07-19T23:39:35.024Z', fecha_hora_facturacion: '2026-07-19T23:39:35.024Z',
          id_sucursal: 9, nombre_sucursal: 'El Carmen', id_usuario: 1, nombre_usuario: 'Ana Cajera',
          sub_total: 40, total: 40, cliente_nombre: 'Consumidor final', facturacion_snapshot: null
        }] };
      }
      if (/FROM\s+detalle_facturas\s+df/i.test(sql) && /detalle_facturas_origen/i.test(sql)) {
        return { rowCount: 1, rows: [kitchenRow] };
      }
      if (/FROM\s+public\.detalle_factura_extras/i.test(sql)) {
        return { rowCount: 1, rows: [facturaExtraRow] };
      }
      if (/ventas_cuenta_divisiones/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/pedidos_delivery|pedidos_contacto|pedidos_contexto/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  };
};

test('buildVentaDetailPayloadForScope normaliza el extra independiente con precio y subtotal correctos', async () => {
  const result = await buildVentaDetailPayloadForScope({
    idFactura: 12,
    allowedSucursalIds: [9],
    queryRunner: buildFacturaDetailQueryRunner()
  });
  assert.equal(result.status, 200);
  const item = result.body.items.find((i) => i.es_linea_extra_independiente);
  assert.ok(item, 'debe existir una linea de extra independiente');
  assert.equal(item.tipo_item, 'EXTRA');
  assert.equal(item.nombre_item, 'Extra Ranch');
  assert.equal(item.cantidad, 4);
  assert.equal(item.precio_unitario, 10);
  assert.equal(item.sub_total, 40);
  assert.equal(item.total_linea, 40);
  assert.equal(item.cantidad * item.precio_unitario, item.sub_total);

  const names = result.body.items.map((i) => i.nombre_item);
  assert.ok(!names.includes('Item de pedido'), 'no debe aparecer "Item de pedido"');
  assert.ok(!names.includes('Item de cocina'), 'no debe aparecer "Item de cocina"');
  assert.equal(names.filter((n) => n === 'Extra Ranch').length, 1);
});

test('buildVentaDetailPayloadForScope legacy (v2) preserva el detalle sin normalizar', async () => {
  const result = await buildVentaDetailPayloadForScope({
    idFactura: 12,
    allowedSucursalIds: [9],
    normalizeStandaloneExtras: false,
    queryRunner: buildFacturaDetailQueryRunner()
  });
  assert.equal(result.status, 200);
  const item = result.body.items[0];
  assert.ok(!item.es_linea_extra_independiente);
  assert.equal(item.nombre_item, 'Item de cocina');
});
