import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  registrarMovimientosPedido,
  validateTracedPedidoMovement
} from '../inventarioMovimientoService.js';

const createClient = () => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    }
  };
};

const baseOptions = (overrides = {}) => ({
  client: createClient(),
  idPedido: 700,
  actorUserId: 11,
  productoQtyMap: new Map(),
  insumoQtyMap: new Map(),
  productosById: new Map([[10, { id_producto: 10, id_almacen: 3 }]]),
  insumosById: new Map([[22, { id_insumo: 22, id_almacen: 4 }]]),
  movementRows: [],
  ...overrides
});

const productMovementRow = (overrides = {}) => ({
  tipo_recurso: 'producto',
  id_detalle_pedido: 9001,
  id_producto: 10,
  cantidad: 2,
  origen_consumo: 'PRODUCTO',
  ...overrides
});

const expectCode = async (fn, code) => {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, 409);
    return true;
  });
};

describe('pedido traced movement registration', () => {
  it('retorna 0 cuando no hay movementRows ni consumo fisico', async () => {
    const options = baseOptions();
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 0);
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea productoQtyMap positivo sin movementRows', async () => {
    const options = baseOptions({ productoQtyMap: new Map([[10, 1]]) });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA'
    );
  });

  it('bloquea insumoQtyMap positivo sin movementRows', async () => {
    const options = baseOptions({ insumoQtyMap: new Map([[22, 1]]) });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA'
    );
  });

  it('bloquea mapas positivos sin movementRows', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 1]]),
      insumoQtyMap: new Map([[22, 1]])
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA'
    );
  });

  it('inserta movimiento trazado con detalle, trazabilidad, origen y ref_origen', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 2]]),
      movementRows: [productMovementRow()]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 1);
    assert.equal(options.client.queries.length, 1);
    const params = options.client.queries[0].params;
    assert.equal(params[0], 2);
    assert.equal(params[1], 3);
    assert.equal(params[2], 10);
    assert.equal(params[3], null);
    assert.equal(params[4], 9001);
    assert.equal(params[5], 'PRODUCTO');
    assert.equal(params[6], 'PEDIDO');
    assert.equal(params[7], 700);
    assert.equal(params[8], 700);
  });

  it('normaliza ref_origen pedido, espacios y faltante_cocina en inserts', async () => {
    for (const [rawRef, expectedRef] of [
      ['pedido', 'PEDIDO'],
      [' PEDIDO ', 'PEDIDO'],
      ['faltante_cocina', 'FALTANTE_COCINA']
    ]) {
      const options = baseOptions({
        refOrigen: rawRef,
        productoQtyMap: new Map([[10, 2]]),
        movementRows: [productMovementRow()]
      });
      await registrarMovimientosPedido(options);
      assert.equal(options.client.queries[0].params[6], expectedRef);
    }
  });

  it('bloquea detalle nulo', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 1]]),
      movementRows: [productMovementRow({ id_detalle_pedido: null })]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA'
    );
  });

  it('bloquea almacen nulo o cero', () => {
    for (const id_almacen of [null, 0]) {
      assert.throws(
        () => validateTracedPedidoMovement({
          id_ref: 700,
          id_pedido_trazabilidad: 700,
          id_detalle_pedido: 9001,
          id_almacen,
          id_producto: 10,
          id_insumo: null,
          cantidad: 1,
          origen_consumo: 'PRODUCTO',
          ref_origen: 'PEDIDO'
        }),
        { code: 'PEDIDO_TRAZABILIDAD_ALMACEN_INVALIDO' }
      );
    }
  });

  it('bloquea cantidad cero o negativa', () => {
    for (const cantidad of [0, -1]) {
      assert.throws(
        () => validateTracedPedidoMovement({
          id_ref: 700,
          id_pedido_trazabilidad: 700,
          id_detalle_pedido: 9001,
          id_almacen: 3,
          id_producto: 10,
          id_insumo: null,
          cantidad,
          origen_consumo: 'PRODUCTO',
          ref_origen: 'PEDIDO'
        }),
        { code: 'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA' }
      );
    }
  });

  it('bloquea recurso nulo o doble', () => {
    for (const resource of [
      { id_producto: null, id_insumo: null },
      { id_producto: 10, id_insumo: 22 }
    ]) {
      assert.throws(
        () => validateTracedPedidoMovement({
          id_ref: 700,
          id_pedido_trazabilidad: 700,
          id_detalle_pedido: 9001,
          id_almacen: 3,
          cantidad: 1,
          origen_consumo: 'PRODUCTO',
          ref_origen: 'PEDIDO',
          ...resource
        }),
        { code: 'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO' }
      );
    }
  });

  it('bloquea origen_consumo invalido y ref_origen desconocido', () => {
    const base = {
      id_ref: 700,
      id_pedido_trazabilidad: 700,
      id_detalle_pedido: 9001,
      id_almacen: 3,
      id_producto: 10,
      id_insumo: null,
      cantidad: 1,
      origen_consumo: 'PRODUCTO',
      ref_origen: 'PEDIDO'
    };
    assert.throws(
      () => validateTracedPedidoMovement({ ...base, origen_consumo: 'OTRO' }),
      { code: 'ORIGEN_CONSUMO_INVALIDO' }
    );
    assert.throws(
      () => validateTracedPedidoMovement({ ...base, ref_origen: 'OTRO' }),
      { code: 'PEDIDO_TRAZABILIDAD_REF_ORIGEN_INVALIDO' }
    );
  });
});
