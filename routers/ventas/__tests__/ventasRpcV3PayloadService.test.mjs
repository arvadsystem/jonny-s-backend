import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPedidoPendienteRpcV2Payload,
  buildVentaRpcV3Payload
} from '../services/ventasRpcPayloadService.js';

const baseVenta = (lines) => ({
  descripcion_pedido: 'Pedido',
  descripcion_envio: null,
  pedido_subtotal: 100,
  pedido_isv: 0,
  pedido_total: 100,
  id_estado_pedido: 1,
  id_sucursal: 6,
  id_cliente: 1,
  id_usuario: 10,
  id_caja: 3,
  id_sesion_caja: 77,
  id_metodo_pago: 1,
  metodo_pago: 'EFECTIVO',
  metodo_pago_codigo: 'EFECTIVO',
  efectivo_entregado: 100,
  cambio: 0,
  subtotal: 100,
  descuento: 0,
  isv: 0,
  total: 100,
  all_lines: lines,
  pedido_lines: lines
});

const recetaLine = (overrides = {}) => ({
  kind: 'RECETA',
  cart_key: 'abc',
  id_receta: 5,
  id_producto: null,
  id_extra: null,
  cantidad: 2,
  precio_unitario: 50,
  sub_total: 100,
  total_linea: 100,
  descuento: 0,
  subtotal_extras: 0,
  nombre_item: 'Combo',
  componentes_receta: [
    { id_insumo: 11, id_almacen: 2, cantidad: 1.5 }
  ],
  complementos_detalle: [],
  extras_detalle: [],
  ...overrides
});

describe('ventas RPC V3/V2 payload builders', () => {
  it('construye consumos de producto con line_ref estable', () => {
    const payload = buildVentaRpcV3Payload({
      venta: baseVenta([{
        kind: 'PRODUCTO',
        cart_key: 'prod',
        id_producto: 9,
        id_almacen: 4,
        cantidad: 2,
        precio_unitario: 50,
        sub_total: 100,
        total_linea: 100,
        descuento: 0,
        nombre_item: 'Producto'
      }]),
      idempotencyKey: 'idem-123456',
      requestHash: 'a'.repeat(64)
    });
    assert.equal(payload.schema_version, 3);
    assert.equal(payload.items[0].line_ref, 'line-0-prod');
    assert.equal(payload.items[0].consumos[0].origen_consumo, 'PRODUCTO');
    assert.equal(payload.items[0].consumos[0].id_producto, 9);
  });

  it('construye receta + extra + salsa sin mezclar origenes', () => {
    const payload = buildVentaRpcV3Payload({
      venta: baseVenta([recetaLine({
        extras_detalle: [{
          id_extra: 8,
          cantidad: 2,
          cantidad_total: 2,
          id_insumo: 22,
          id_almacen: 3,
          cantidad_insumo: 0.25,
          id_unidad_medida: 1
        }],
        complementos_detalle: [{
          id_salsa: 7,
          id_complemento: 7,
          nombre: 'Salsa',
          inventario: {
            id_salsa: 7,
            id_insumo: 33,
            id_almacen: 3,
            cantidad_base_total: 4,
            id_unidad_consumo: 1,
            id_unidad_base: 1
          }
        }]
      })]),
      idempotencyKey: 'idem-123456',
      requestHash: 'b'.repeat(64)
    });
    const origins = payload.items[0].consumos.map((entry) => entry.origen_consumo).sort();
    assert.deepEqual(origins, ['EXTRA', 'RECETA', 'SALSA']);
    assert.equal(payload.items[0].consumos.find((entry) => entry.origen_consumo === 'RECETA').cantidad, 3);
    assert.equal(payload.items[0].consumos.find((entry) => entry.origen_consumo === 'EXTRA').cantidad, 0.5);
  });

  it('no consolida line_ref diferentes para el mismo insumo', () => {
    const venta = baseVenta([
      recetaLine({ cart_key: 'a' }),
      recetaLine({ cart_key: 'b' })
    ]);
    const payload = buildVentaRpcV3Payload({
      venta,
      idempotencyKey: 'idem-123456',
      requestHash: 'c'.repeat(64)
    });
    assert.equal(payload.items.length, 2);
    assert.equal(payload.items[0].consumos[0].cantidad, 3);
    assert.equal(payload.items[1].consumos[0].cantidad, 3);
    assert.notEqual(payload.items[0].line_ref, payload.items[1].line_ref);
  });

  it('rechaza snapshot de salsa incompleto', () => {
    assert.throws(() => buildVentaRpcV3Payload({
      venta: baseVenta([recetaLine({
        complementos_detalle: [{ id_salsa: 7, inventario: { id_salsa: 7 } }]
      })]),
      idempotencyKey: 'idem-123456',
      requestHash: 'd'.repeat(64)
    }), /POS_RPC_SALSA_SNAPSHOT_INVALIDO/);
  });

  it('construye pedido pendiente V2 con contacto, delivery y pago pendiente', () => {
    const payload = buildPedidoPendienteRpcV2Payload({
      pedidoPendiente: {
        ...baseVenta([recetaLine()]),
        pedido_lines: [recetaLine()],
        subtotal: 100,
        isv: 0,
        canal: 'WHATSAPP',
        modalidad: 'DELIVERY',
        id_canal_pedido: 1,
        id_modalidad_entrega: 2,
        id_estado_pago_pedido: 3,
        id_motivo_pago_pendiente: 4,
        observacion_pago: 'Pendiente',
        contacto: { nombre_contacto: 'Cliente', telefono_contacto: '9999' },
        delivery: { costo_envio: 0, direccion_entrega: 'Dir' }
      },
      idempotencyKey: 'idem-abcdef',
      requestHash: 'e'.repeat(64)
    });
    assert.equal(payload.schema_version, 2);
    assert.equal(payload.idempotency.operation, undefined);
    assert.equal(payload.pedido_lines[0].line_ref, 'line-0-abc');
    assert.equal(payload.modalidad, 'DELIVERY');
    assert.equal(payload.id_estado_pago_pedido, 3);
  });
});
