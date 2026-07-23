import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVentaDetailPayloadForScope
} from '../routers/ventas/handlers/ventasReadHandlers.js';
import {
  buildVentaKitchenPrintPayload
} from '../routers/ventas/handlers/ventasPrintHandlers.js';
import {
  assertKitchenPrintPayload
} from '../routers/ventas/services/kitchenPrintRoutingService.js';

const buildQueryRunner = () => ({
  query: async (sql) => {
    if (/FROM\s+facturas\s+f/i.test(sql)) {
      return {
        rowCount: 1,
        rows: [{
          id_factura: 40,
          id_pedido: 30,
          codigo_venta: 'VTA-00040',
          id_sucursal: 1,
          nombre_sucursal: 'Sucursal QA',
          total: 250,
          sub_total: 250,
          facturacion_snapshot: {
            emisor: {},
            ticket: {},
            fiscal: { habilitado: false }
          }
        }]
      };
    }
    if (/FROM\s+detalle_facturas\s+df/i.test(sql) && /detalle_facturas_origen/i.test(sql)) {
      return {
        rowCount: 3,
        rows: [
          {
            id_detalle: 1,
            id_detalle_pedido: 101,
            tipo_item: 'RECETA',
            id_producto: null,
            id_receta: 10,
            nombre_item: 'Hamburguesa',
            cantidad: 1,
            precio_unitario: 100,
            sub_total: 100,
            total_linea: 100,
            configuracion_menu: null,
            origen_snapshot: {}
          },
          {
            id_detalle: 2,
            id_detalle_pedido: 102,
            tipo_item: 'PRODUCTO',
            id_producto: 20,
            id_receta: null,
            nombre_item: 'Refresco inmediato',
            cantidad: 1,
            precio_unitario: 100,
            sub_total: 100,
            total_linea: 100,
            configuracion_menu: { entregar_con_pedido: false },
            origen_snapshot: {}
          },
          {
            id_detalle: 3,
            id_detalle_pedido: null,
            tipo_item: 'ITEM',
            id_producto: null,
            id_receta: null,
            nombre_item: 'Cargo logistico',
            cantidad: 1,
            precio_unitario: 50,
            sub_total: 50,
            total_linea: 50,
            configuracion_menu: null,
            origen_snapshot: { origen: 'DELIVERY' }
          }
        ]
      };
    }
    if (/information_schema\.(tables|columns)/i.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    if (/pedidos_delivery|pedidos_contacto|pedidos_contexto/i.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
});

test('detalle financiero conserva cargo y payload de comanda lo excluye', async () => {
  const detail = await buildVentaDetailPayloadForScope({
    idFactura: 40,
    allowedSucursalIds: [1],
    queryRunner: buildQueryRunner()
  });

  assert.equal(detail.status, 200);
  assert.equal(detail.body.items.length, 3);
  assert.equal(detail.body.items.some((item) => item.nombre_item === 'Cargo logistico'), true);
  assert.equal(detail.body.requiere_cocina, true);
  assert.equal(detail.body.requiere_revision, false);
  assert.equal(detail.body.items_no_cocina.length, 1);
  assert.equal(detail.body.items_no_cocina[0].tipo_clasificacion, 'CARGO_NO_COCINA');

  const kitchenPayload = buildVentaKitchenPrintPayload(detail.body);
  const operationalItems = assertKitchenPrintPayload(kitchenPayload);
  assert.deepEqual(operationalItems.map((item) => item.nombre_item), ['Hamburguesa']);
  assert.equal(kitchenPayload.items_no_cocina.length, 1);
  assert.equal(kitchenPayload.total_productos, 1);
});
