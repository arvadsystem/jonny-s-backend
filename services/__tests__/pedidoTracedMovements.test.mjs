import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchExistingPedidoMovement,
  fetchPedidoInventoryMovementsForUpdate,
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
  productosById: new Map([
    [8, { id_producto: 8, id_almacen: 5 }],
    [10, { id_producto: 10, id_almacen: 3 }],
    [11, { id_producto: 11, id_almacen: 3 }]
  ]),
  insumosById: new Map([
    [22, { id_insumo: 22, id_almacen: 4 }],
    [99, { id_insumo: 99, id_almacen: 6 }],
    [100, { id_insumo: 100, id_almacen: 6 }]
  ]),
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

const insumoMovementRow = (overrides = {}) => ({
  tipo_recurso: 'insumo',
  id_detalle_pedido: 9001,
  id_insumo: 22,
  cantidad: 2,
  origen_consumo: 'RECETA',
  ...overrides
});

const expectCode = async (fn, code) => {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, 409);
    return true;
  });
};

const expectSyncCode = (fn, code) => {
  assert.throws(fn, (error) => {
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

  it('bloquea mapas vacios con linea valida de producto', async () => {
    const options = baseOptions({
      movementRows: [productMovementRow()]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea mapas vacios con linea valida de insumo', async () => {
    const options = baseOptions({
      movementRows: [insumoMovementRow()]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES'
    );
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

  it('bloquea ids invalidos en productoQtyMap', async () => {
    for (const inputProductId of [0, -1, 'abc']) {
      const options = baseOptions({
        productoQtyMap: new Map([[inputProductId, 1]])
      });
      await expectCode(
        () => registrarMovimientosPedido(options),
        'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO'
      );
      assert.equal(options.client.queries.length, 0);
    }
  });

  it('bloquea ids invalidos en insumoQtyMap', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[0, 1]])
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea insumoQtyMap con id invalido mezclado con otro valido', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[22, 2], [0, 1]]),
      movementRows: [insumoMovementRow()]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea productoQtyMap con id invalido mezclado con otro valido', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 2], ['', 1]]),
      movementRows: [productMovementRow()]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea cantidades invalidas en mapas', async () => {
    for (const [qtyMapName, rawQuantity] of [
      ['productoQtyMap', 0],
      ['productoQtyMap', -1],
      ['insumoQtyMap', NaN],
      ['insumoQtyMap', Infinity],
      ['productoQtyMap', ''],
      ['productoQtyMap', 'abc']
    ]) {
      const options = baseOptions({
        [qtyMapName]: qtyMapName === 'productoQtyMap'
          ? new Map([[10, rawQuantity]])
          : new Map([[22, rawQuantity]])
      });
      await expectCode(
        () => registrarMovimientosPedido(options),
        'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA'
      );
      assert.equal(options.client.queries.length, 0);
    }
  });

  it('bloquea cantidad invalida mezclada con otra valida en mapas', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 2], [8, -1]]),
      movementRows: [productMovementRow()]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA'
    );
    assert.equal(options.client.queries.length, 0);
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

  it('acepta origenes explicitos validos para producto e insumo', async () => {
    const productOptions = baseOptions({
      productoQtyMap: new Map([[10, 2]]),
      movementRows: [productMovementRow({ origen_consumo: 'PRODUCTO' })]
    });
    await registrarMovimientosPedido(productOptions);
    assert.equal(productOptions.client.queries[0].params[5], 'PRODUCTO');

    for (const origenConsumo of ['RECETA', 'EXTRA', 'SALSA']) {
      const options = baseOptions({
        insumoQtyMap: new Map([[22, 2]]),
        movementRows: [insumoMovementRow({ origen_consumo: origenConsumo })]
      });
      await registrarMovimientosPedido(options);
      assert.equal(options.client.queries[0].params[5], origenConsumo);
    }
  });

  it('bloquea producto con origen de receta, extra o salsa', async () => {
    for (const origen_consumo of ['RECETA', 'EXTRA', 'SALSA']) {
      const options = baseOptions({
        productoQtyMap: new Map([[10, 2]]),
        movementRows: [productMovementRow({ origen_consumo })]
      });
      await expectCode(
        () => registrarMovimientosPedido(options),
        'PEDIDO_TRAZABILIDAD_ORIGEN_INCOMPATIBLE'
      );
      assert.equal(options.client.queries.length, 0);
    }
  });

  it('bloquea insumo con origen PRODUCTO', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[22, 2]]),
      movementRows: [insumoMovementRow({ origen_consumo: 'PRODUCTO' })]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_ORIGEN_INCOMPATIBLE'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea origen incompatible en movimiento normalizado', () => {
    expectSyncCode(
      () => validateTracedPedidoMovement({
        id_ref: 700,
        id_pedido_trazabilidad: 700,
        id_detalle_pedido: 9001,
        id_almacen: 3,
        id_producto: 10,
        id_insumo: null,
        cantidad: 1,
        origen_consumo: 'RECETA',
        ref_origen: 'PEDIDO'
      }),
      'PEDIDO_TRAZABILIDAD_ORIGEN_INCOMPATIBLE'
    );
  });

  it('bloquea origen_consumo nulo, vacio u OTRO en filas crudas', async () => {
    for (const origen_consumo of [null, '', 'OTRO']) {
      const options = baseOptions({
        productoQtyMap: new Map([[10, 2]]),
        movementRows: [productMovementRow({ origen_consumo })]
      });
      await expectCode(
        () => registrarMovimientosPedido(options),
        'ORIGEN_CONSUMO_INVALIDO'
      );
      assert.equal(options.client.queries.length, 0);
    }
  });

  it('bloquea tipo_recurso invalido o vacio', async () => {
    for (const tipo_recurso of ['otro', '']) {
      const options = baseOptions({
        productoQtyMap: new Map([[10, 2]]),
        movementRows: [productMovementRow({ tipo_recurso })]
      });
      await expectCode(
        () => registrarMovimientosPedido(options),
        'PEDIDO_TRAZABILIDAD_TIPO_RECURSO_INVALIDO'
      );
      assert.equal(options.client.queries.length, 0);
    }
  });

  it('bloquea producto o insumo sin id fisico o con id cruzado sobrante', async () => {
    for (const row of [
      productMovementRow({ id_producto: null }),
      productMovementRow({ id_insumo: 22 }),
      insumoMovementRow({ id_insumo: null }),
      insumoMovementRow({ id_producto: 10 })
    ]) {
      const options = baseOptions({
        productoQtyMap: new Map([[10, 2]]),
        insumoQtyMap: new Map([[22, 2]]),
        movementRows: [row]
      });
      await expectCode(
        () => registrarMovimientosPedido(options),
        'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO'
      );
      assert.equal(options.client.queries.length, 0);
    }
  });

  it('bloquea producto no resuelto', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[123, 1]]),
      movementRows: [productMovementRow({ id_producto: 123, cantidad: 1 })]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_PRODUCTO_NO_RESUELTO'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea insumo no resuelto', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[123, 1]]),
      movementRows: [insumoMovementRow({ id_insumo: 123, cantidad: 1 })]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_INSUMO_NO_RESUELTO'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea detalle nulo', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 1]]),
      movementRows: [productMovementRow({ cantidad: 1, id_detalle_pedido: null })]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea almacen nulo o cero', () => {
    for (const id_almacen of [null, 0]) {
      expectSyncCode(
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
        'PEDIDO_TRAZABILIDAD_ALMACEN_INVALIDO'
      );
    }
  });

  it('bloquea cantidad cero o negativa', () => {
    for (const cantidad of [0, -1]) {
      expectSyncCode(
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
        'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA'
      );
    }
  });

  it('bloquea recurso nulo o doble en movimiento normalizado', () => {
    for (const resource of [
      { id_producto: null, id_insumo: null },
      { id_producto: 10, id_insumo: 22 }
    ]) {
      expectSyncCode(
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
        'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO'
      );
    }
  });

  it('bloquea origen_consumo invalido y ref_origen desconocido en movimiento normalizado', () => {
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
    expectSyncCode(
      () => validateTracedPedidoMovement({ ...base, origen_consumo: 'OTRO' }),
      'ORIGEN_CONSUMO_INVALIDO'
    );
    expectSyncCode(
      () => validateTracedPedidoMovement({ ...base, ref_origen: 'OTRO' }),
      'PEDIDO_TRAZABILIDAD_REF_ORIGEN_INVALIDO'
    );
  });

  it('acepta total canonico valido para producto 8', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 8]]),
      movementRows: [productMovementRow({ id_producto: 8, cantidad: 8 })]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 1);
    assert.equal(options.client.queries[0].params[2], 8);
    assert.equal(options.client.queries[0].params[0], 8);
  });

  it('bloquea total canonico invalido para producto 8', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 8]]),
      movementRows: [productMovementRow({ id_producto: 8, cantidad: 7.999999 })]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('acepta total canonico valido para insumo 99', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[99, 99]]),
      movementRows: [insumoMovementRow({ id_insumo: 99, cantidad: 99 })]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 1);
    assert.equal(options.client.queries[0].params[3], 99);
    assert.equal(options.client.queries[0].params[0], 99);
  });

  it('bloquea total canonico invalido para insumo 99', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[99, 99]]),
      movementRows: [insumoMovementRow({ id_insumo: 99, cantidad: 98.999999 })]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('acepta dos lineas de producto que suman el total canonico', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 8]]),
      movementRows: [
        productMovementRow({ id_detalle_pedido: 9001, id_producto: 8, cantidad: 3 }),
        productMovementRow({ id_detalle_pedido: 9002, id_producto: 8, cantidad: 5 })
      ]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 2);
    assert.equal(options.client.queries.length, 2);
  });

  it('acepta dos lineas de insumo que suman el total canonico', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[99, 99]]),
      movementRows: [
        insumoMovementRow({ id_detalle_pedido: 9001, id_insumo: 99, cantidad: 50 }),
        insumoMovementRow({ id_detalle_pedido: 9002, id_insumo: 99, cantidad: 49 })
      ]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 2);
    assert.equal(options.client.queries.length, 2);
  });

  it('bloquea total canonico con recurso faltante', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 8]]),
      insumoQtyMap: new Map([[99, 99]]),
      movementRows: [productMovementRow({ id_producto: 8, cantidad: 8 })]
    });
    await assert.rejects(
      () => registrarMovimientosPedido(options),
      (error) => {
        assert.equal(error.code, 'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES');
        assert.deepEqual(error.details.missing, [{ key: 'insumo:99', expected: 99 }]);
        return true;
      }
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea total canonico con recurso inesperado', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 8]]),
      movementRows: [
        productMovementRow({ id_producto: 8, cantidad: 8 }),
        insumoMovementRow({ id_insumo: 99, cantidad: 99 })
      ]
    });
    await assert.rejects(
      () => registrarMovimientosPedido(options),
      (error) => {
        assert.equal(error.code, 'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES');
        assert.deepEqual(error.details.unexpected, [{ key: 'insumo:99', traced: 99 }]);
        return true;
      }
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea diferencia canonica a 6 decimales', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 1.0000004]]),
      movementRows: [productMovementRow({ id_producto: 8, cantidad: 1.0000014 })]
    });
    await assert.rejects(
      () => registrarMovimientosPedido(options),
      (error) => {
        assert.equal(error.code, 'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES');
        assert.deepEqual(error.details.mismatched, [{ key: 'producto:8', expected: 1, traced: 1.000001 }]);
        return true;
      }
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('acepta sumas decimales equivalentes por redondeo final', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 1.0000002]]),
      movementRows: [
        productMovementRow({ id_detalle_pedido: 9001, id_producto: 8, cantidad: 0.3333334 }),
        productMovementRow({ id_detalle_pedido: 9002, id_producto: 8, cantidad: 0.3333334 }),
        productMovementRow({ id_detalle_pedido: 9003, id_producto: 8, cantidad: 0.3333334 })
      ]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 3);
    assert.equal(options.client.queries.length, 3);
  });

  it('bloquea sumas decimales diferentes al comparar el total final', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 1.0000002]]),
      movementRows: [
        productMovementRow({ id_detalle_pedido: 9001, id_producto: 8, cantidad: 0.3333334 }),
        productMovementRow({ id_detalle_pedido: 9002, id_producto: 8, cantidad: 0.3333334 }),
        productMovementRow({ id_detalle_pedido: 9003, id_producto: 8, cantidad: 0.3333344 })
      ]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('acepta dos lineas de hasta seis decimales que suman exactamente el esperado', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[8, 1]]),
      movementRows: [
        productMovementRow({ id_detalle_pedido: 9001, id_producto: 8, cantidad: 0.123456 }),
        productMovementRow({ id_detalle_pedido: 9002, id_producto: 8, cantidad: 0.876544 })
      ]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 2);
    assert.equal(options.client.queries.length, 2);
  });

  it('retorna 0 cuando producto valido esta excluido en mapa y linea', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 2]]),
      movementRows: [productMovementRow()],
      excludedProductIds: new Set([10])
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 0);
    assert.equal(options.client.queries.length, 0);
  });

  it('retorna 0 cuando insumo valido esta excluido en mapa y linea', async () => {
    const options = baseOptions({
      insumoQtyMap: new Map([[22, 2]]),
      movementRows: [insumoMovementRow()],
      excludedInsumoIds: new Set([22])
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 0);
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea recurso excluido con id invalido antes de omitirlo', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[0, 2]]),
      excludedProductIds: new Set([0])
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('bloquea recurso excluido con cantidad invalida antes de omitirlo', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 0]]),
      excludedProductIds: new Set([10])
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('no inserta nada si la segunda fila cruda es invalida', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 2]]),
      insumoQtyMap: new Map([[22, 2]]),
      movementRows: [
        productMovementRow(),
        insumoMovementRow({ origen_consumo: null })
      ]
    });
    await expectCode(
      () => registrarMovimientosPedido(options),
      'ORIGEN_CONSUMO_INVALIDO'
    );
    assert.equal(options.client.queries.length, 0);
  });

  it('inserta exactamente dos movimientos si dos filas crudas son validas', async () => {
    const options = baseOptions({
      productoQtyMap: new Map([[10, 2]]),
      insumoQtyMap: new Map([[22, 2]]),
      movementRows: [
        productMovementRow(),
        insumoMovementRow()
      ]
    });
    const count = await registrarMovimientosPedido(options);
    assert.equal(count, 2);
    assert.equal(options.client.queries.length, 2);
  });

  it('mantiene lectura indexable por ref_origen = ANY sin UPPER ni BTRIM', async () => {
    const existingClient = createClient();
    await fetchExistingPedidoMovement(existingClient, 88);
    assert.match(existingClient.queries[0].sql, /ref_origen\s+=\s+ANY\(\$1::text\[\]\)/);
    assert.doesNotMatch(existingClient.queries[0].sql, /UPPER\(/);
    assert.doesNotMatch(existingClient.queries[0].sql, /BTRIM\(/);

    const lockClient = createClient();
    await fetchPedidoInventoryMovementsForUpdate(lockClient, 88);
    assert.match(lockClient.queries[0].sql, /ref_origen\s+=\s+ANY\(\$1::text\[\]\)/);
    assert.doesNotMatch(lockClient.queries[0].sql, /UPPER\(/);
    assert.doesNotMatch(lockClient.queries[0].sql, /BTRIM\(/);
  });
});
