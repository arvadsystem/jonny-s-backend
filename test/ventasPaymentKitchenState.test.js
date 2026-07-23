import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  persistImmediateSalePaymentState,
  reconcileVentaResponseWithPersistedPedidoState
} from '../routers/ventas/services/ventaImmediatePaymentStateService.js';

const estadoRows = [
  { id_estado_pedido: 1, descripcion: 'PENDIENTE' },
  { id_estado_pedido: 2, descripcion: 'EN_COCINA' },
  { id_estado_pedido: 3, descripcion: 'LISTO_PARA_ENTREGA' },
  { id_estado_pedido: 4, descripcion: 'COMPLETADO' }
];

const buildClient = ({ lines, estadoPago = 'PAGADO_CONFIRMADO', canal = 'LOCAL', modalidad = 'CONSUMO_LOCAL' }) => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
        return { rowCount: estadoRows.length, rows: estadoRows };
      }
      if (/FROM public\.cat_pedidos_estados_pago/.test(sql)) {
        return { rowCount: 1, rows: [{ id_estado_pago_pedido: 9 }] };
      }
      if (/SELECT id_pedido_pago_control/.test(sql)) return { rowCount: 0, rows: [] };
      if (/INSERT INTO public\.pedidos_pago_control/.test(sql)) return { rowCount: 1, rows: [] };
      if (/SELECT estado_pago, canal, tipo_entrega AS modalidad/.test(sql)) {
        return { rowCount: 1, rows: [{ estado_pago: estadoPago, canal, modalidad }] };
      }
      if (/FROM public\.detalle_pedido/.test(sql)) return { rowCount: lines.length, rows: lines };
      if (/SELECT p\.id_pedido,[\s\S]*FROM public\.pedidos p/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id_pedido: 218,
            estado_pago: estadoPago,
            canal,
            modalidad,
            id_estado_pedido: lines.some((line) => line.id_receta) ? 1 : 4,
            visible_en_cocina_at: null,
            estado_pedido: lines.some((line) => line.id_receta) ? 'PENDIENTE' : 'COMPLETADO'
          }]
        };
      }
      if (/UPDATE public\.pedidos/.test(sql)) {
        return { rowCount: 1, rows: [{ id_pedido: 218, id_estado_pedido: 4, visible_en_cocina_at: null }] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };
  return { client, calls };
};

test('venta inmediata producto-only persiste pago y finaliza el pedido', async () => {
  const fixture = buildClient({
    lines: [{
      id_detalle_pedido: 1,
      tipo_item: 'PRODUCTO',
      id_producto: 10,
      id_receta: null,
      cantidad: 1,
      nombre_item: 'Refresco'
    }]
  });
  await persistImmediateSalePaymentState({
    client: fixture.client,
    idPedido: 218,
    idFactura: 172,
    venta: {
      id_usuario: 44,
      id_sesion_caja: 71,
      total: 292,
      contexto: { canal: 'LOCAL', modalidad: 'CONSUMO_LOCAL' }
    }
  });

  const orderUpdates = fixture.calls.filter((call) => /UPDATE public\.pedidos/.test(call.sql));
  assert.equal(orderUpdates.length, 2);
  assert.match(orderUpdates[0].sql, /estado_pago = \$2/);
  assert.doesNotMatch(orderUpdates[1].sql, /estado_pago/);
  assert.deepEqual(orderUpdates[1].params, [218, 4]);
});

test('respuesta reconciliada expone ruteo persistido de receta', async () => {
  const fixture = buildClient({
    lines: [{
      id_detalle_pedido: 2,
      tipo_item: 'RECETA',
      id_producto: null,
      id_receta: 20,
      cantidad: 1,
      nombre_item: 'Hamburguesa'
    }]
  });
  const response = await reconcileVentaResponseWithPersistedPedidoState({
    client: fixture.client,
    response: { id_pedido: 218 }
  });
  assert.equal(response.estado_pedido, 'PENDIENTE');
  assert.equal(response.requiere_cocina, true);
  assert.equal(response.requiere_revision, false);
  assert.equal(response.accion_operativa, 'ENVIAR_COCINA');
});

test('auditoria y cola de impresion no modifican el estado del pedido', () => {
  const auditSource = fs.readFileSync(new URL('../routers/ventas/handlers/ventasPrintHandlers.js', import.meta.url), 'utf8');
  const queueSource = fs.readFileSync(new URL('../routers/printing.js', import.meta.url), 'utf8');
  assert.doesNotMatch(auditSource, /markPedidoVisibleInKitchen|isInitialKitchenDispatchEvent/);
  assert.doesNotMatch(queueSource, /markPedidoVisibleInKitchen|onInsertedTransaction/);
});
