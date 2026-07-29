import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertPedidoEligibleForReversion,
  resolveCancelledEstadoPedidoIdOrThrow
} from '../../routers/ventas/services/ventasReversionEligibilityService.js';

const makeClient = (handlers) => ({
  async query(sql, params) {
    for (const [pattern, handler] of handlers) {
      if (pattern.test(sql)) return handler(params);
    }
    throw new Error(`Consulta no simulada: ${sql}`);
  }
});

const pedidoRow = (estado_descripcion, en_preparacion_at = null) => ({
  rowCount: 1,
  rows: [{ id_pedido: 254, en_preparacion_at, estado_descripcion }]
});

describe('assertPedidoEligibleForReversion', () => {
  it('13) PENDIENTE y sin preparacion -> permitido', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('Pendiente')]]);
    const result = await assertPedidoEligibleForReversion({ client, idPedido: 254 });
    assert.equal(result.estado, 'PENDIENTE');
  });

  it('14) EN_COCINA y sin preparacion -> permitido', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('En cocina')]]);
    const result = await assertPedidoEligibleForReversion({ client, idPedido: 254 });
    assert.equal(result.estado, 'EN_COCINA');
  });

  it('15) EN_PREPARACION -> bloqueado (VENTAS_REVERSION_PREPARACION_INICIADA)', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('En preparacion')]]);
    await assert.rejects(
      assertPedidoEligibleForReversion({ client, idPedido: 254 }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_PREPARACION_INICIADA');
        return true;
      }
    );
  });

  it('16) en_preparacion_at no nulo bloquea aunque el texto diga EN_COCINA', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('En cocina', new Date())]]);
    await assert.rejects(
      assertPedidoEligibleForReversion({ client, idPedido: 254 }),
      (err) => err.code === 'VENTAS_REVERSION_PREPARACION_INICIADA'
    );
  });

  it('LISTO_PARA_ENTREGA -> bloqueado', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('Listo para entrega')]]);
    await assert.rejects(assertPedidoEligibleForReversion({ client, idPedido: 254 }));
  });

  it('COMPLETADO -> bloqueado', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('Completado')]]);
    await assert.rejects(assertPedidoEligibleForReversion({ client, idPedido: 254 }));
  });

  it('NO_ENTREGADO -> bloqueado', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('No entregado')]]);
    await assert.rejects(assertPedidoEligibleForReversion({ client, idPedido: 254 }));
  });

  it('CANCELADO -> bloqueado', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('Cancelado')]]);
    await assert.rejects(assertPedidoEligibleForReversion({ client, idPedido: 254 }));
  });

  it('estado no reconocido -> bloqueado (fail closed)', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => pedidoRow('Estado inventado xyz')]]);
    await assert.rejects(assertPedidoEligibleForReversion({ client, idPedido: 254 }));
  });

  it('17) venta directa (sin id_pedido) -> permitido, no inventa estado de Cocina', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => { throw new Error('no deberia consultar pedidos'); }]]);
    const result = await assertPedidoEligibleForReversion({ client, idPedido: null });
    assert.equal(result, null);
  });

  it('venta directa con idPedido=0 -> permitido sin consultar', async () => {
    const client = makeClient([[/FROM public\.pedidos/, () => { throw new Error('no deberia consultar pedidos'); }]]);
    const result = await assertPedidoEligibleForReversion({ client, idPedido: 0 });
    assert.equal(result, null);
  });
});

describe('resolveCancelledEstadoPedidoIdOrThrow', () => {
  it('resuelve el id de CANCELADO por codigo cuando el catalogo existe', async () => {
    const client = makeClient([
      [/SELECT id_estado_pedido, descripcion FROM estados_pedido/, () => ({
        rowCount: 3,
        rows: [
          { id_estado_pedido: 1, descripcion: 'Pendiente' },
          { id_estado_pedido: 2, descripcion: 'En cocina' },
          { id_estado_pedido: 9, descripcion: 'Cancelado' }
        ]
      })]
    ]);
    const id = await resolveCancelledEstadoPedidoIdOrThrow(client);
    assert.equal(id, 9);
  });

  it('45) catalogo CANCELADO ausente -> VENTAS_REVERSION_ESTADO_CANCELADO_NO_CONFIGURADO, sin fallback a PENDIENTE', async () => {
    const client = makeClient([
      [/SELECT id_estado_pedido, descripcion FROM estados_pedido/, () => ({
        rowCount: 2,
        rows: [
          { id_estado_pedido: 1, descripcion: 'Pendiente' },
          { id_estado_pedido: 2, descripcion: 'En cocina' }
        ]
      })]
    ]);
    await assert.rejects(
      resolveCancelledEstadoPedidoIdOrThrow(client),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_ESTADO_CANCELADO_NO_CONFIGURADO');
        // Confirma que NUNCA cae de vuelta al id de PENDIENTE (1).
        assert.notEqual(err.code, 'PENDIENTE');
        return true;
      }
    );
  });
});
