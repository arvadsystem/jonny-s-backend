import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStandaloneExtraLine } from '../routers/ventas/utils/parseUtils.js';
import { buildPedidoKitchenPrintPayload } from '../routers/ventas/services/pedidoKitchenPrintPayloadService.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import { buildVentaTicketPdfDefinition } from '../routers/ventas/services/ventaTicketPdfService.js';

test('linea sin producto/receta con exactamente un extra se clasifica como EXTRA', () => {
  const result = resolveStandaloneExtraLine({
    idProducto: null,
    idReceta: null,
    extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH' }]
  });
  assert.deepEqual(result, {
    id_extra: 3,
    nombre_extra_snapshot: 'Extra Ranch',
    codigo_extra_snapshot: 'EXT-RANCH'
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

test('pedido con extra independiente (id_producto/id_receta null, cantidad 4) se normaliza sin "Item de pedido"', async () => {
  const queryRunner = {
    query: async (sql) => {
      if (sql.includes('information_schema.')) return { rowCount: 1, rows: [{ exists: 1 }] };
      return {
        rowCount: 1,
        rows: [{
          id_pedido: 501,
          id_sucursal: 9,
          numero_pedido: 'PED-00501',
          items: [{
            id_detalle: 900,
            id_detalle_pedido: 900,
            tipo_item: 'ITEM',
            id_producto: null,
            id_receta: null,
            nombre_item: 'Item de pedido',
            nombre_producto: 'Item de pedido',
            cantidad: 4,
            observacion: null,
            extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH', cantidad: 4 }],
            configuracion_menu: null
          }]
        }]
      };
    }
  };

  const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 501);
  const item = pedido.items[0];

  assert.equal(item.tipo_item, 'EXTRA');
  assert.equal(item.nombre_item, 'Extra Ranch');
  assert.equal(item.es_linea_extra_independiente, true);
  assert.equal(item.id_extra, 3);
  assert.equal(item.nombre_extra_snapshot, 'Extra Ranch');
  assert.equal(item.codigo_extra_snapshot, 'EXT-RANCH');
  assert.notEqual(item.nombre_item, 'Item de pedido');

  const html = buildComandaCocinaHtml(pedido, { widthMm: 80 });
  assert.match(html, /Extra Ranch/);
  assert.doesNotMatch(html, /Item de pedido/);
  assert.doesNotMatch(html, /Extra:\s*Extra Ranch/i);
});

test('el ticket de factura no duplica el extra como fila y como detalle anidado', () => {
  const venta = {
    id_factura: 12,
    fecha_hora_facturacion: '2026-07-19T23:39:35.024Z',
    sub_total: 40,
    total: 40,
    items: [
      {
        id_detalle: 1,
        cantidad: 4,
        nombre_item: 'Extra Ranch',
        total_linea: 40,
        sub_total: 40,
        es_linea_extra_independiente: true,
        extras: [{ nombre: 'Extra Ranch', cantidad: 4, subtotal: 40 }]
      }
    ]
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
  const joined = texts.join('\n');

  const occurrences = texts.filter((t) => t.includes('Extra Ranch')).length;
  assert.equal(occurrences, 1);
  assert.doesNotMatch(joined, /\+ Extra Ranch/);
});
