import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzePedidoMovementState,
  partitionPedidoInventoryMovements
} from '../inventarioMovimientoService.js';

const context = {
  idPedido: 500,
  fechaHoraPedido: '2026-06-30T10:00:00.000Z',
  detallePedidoIds: [900]
};

const expectedRows = [{
  id_ref: 500,
  id_pedido_trazabilidad: 500,
  id_detalle_pedido: 900,
  ref_origen: 'PEDIDO',
  origen_consumo: 'RECETA',
  id_almacen: 1,
  id_producto: null,
  id_insumo: 200,
  cantidad: 8
}];

const oldLegacy = {
  id_movimiento: 1,
  id_ref: 500,
  ref_origen: 'PEDIDO',
  tipo: 'SALIDA',
  fecha_mov: '2026-06-20T10:00:00.000Z',
  id_detalle_pedido: null,
  id_pedido_trazabilidad: null,
  id_almacen: 1,
  id_producto: null,
  id_insumo: 200,
  origen_consumo: 'RECETA',
  cantidad: 8
};

const currentComplete = {
  ...expectedRows[0],
  id_movimiento: 2,
  tipo: 'SALIDA',
  fecha_mov: '2026-06-30T10:00:05.000Z'
};

describe('pedido legacy id collision partition', () => {
  it('ignora colision legacy antigua y deja estado NONE', () => {
    const partition = partitionPedidoInventoryMovements({ rows: [oldLegacy], context });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(partition.currentRows.length, 0);
    assert.equal(analyzePedidoMovementState({
      expectedRows,
      existingRows: [...partition.currentRows, ...partition.invalidCurrentTraceRows]
    }).state, 'NONE');
  });

  it('colision antigua mas movimientos actuales completos da COMPLETE', () => {
    const partition = partitionPedidoInventoryMovements({ rows: [oldLegacy, currentComplete], context });
    const state = analyzePedidoMovementState({
      expectedRows,
      existingRows: [...partition.currentRows, ...partition.invalidCurrentTraceRows]
    });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(state.state, 'COMPLETE');
  });

  it('colision antigua mas movimientos actuales parciales da PARTIAL', () => {
    const partition = partitionPedidoInventoryMovements({ rows: [oldLegacy, { ...currentComplete, cantidad: 4 }], context });
    const state = analyzePedidoMovementState({
      expectedRows,
      existingRows: [...partition.currentRows, ...partition.invalidCurrentTraceRows]
    });
    assert.equal(state.state, 'PARTIAL');
    assert.equal(state.mismatched.length, 1);
  });

  it('movimiento legacy cinco segundos despues del pedido queda como CURRENT_LEGACY', () => {
    const partition = partitionPedidoInventoryMovements({
      rows: [{ ...oldLegacy, fecha_mov: '2026-06-30T10:00:05.000Z' }],
      context
    });
    assert.equal(partition.currentLegacyRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('movimiento legacy sin fecha bloquea como INVALID_CURRENT_TRACE', () => {
    const partition = partitionPedidoInventoryMovements({
      rows: [{ ...oldLegacy, fecha_mov: null }],
      context
    });
    assert.equal(partition.invalidCurrentTraceRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('movimiento trazado con detalle de otro pedido bloquea como INVALID_CURRENT_TRACE', () => {
    const partition = partitionPedidoInventoryMovements({
      rows: [{ ...currentComplete, id_detalle_pedido: 901 }],
      context
    });
    assert.equal(partition.invalidCurrentTraceRows.length, 1);
    assert.equal(partition.currentTracedRows.length, 0);
  });

  it('movimiento antiguo con detalle de otro pedido no se asume legacy valido', () => {
    const partition = partitionPedidoInventoryMovements({
      rows: [{ ...oldLegacy, id_detalle_pedido: 901, id_pedido_trazabilidad: null }],
      context
    });
    assert.equal(partition.invalidCurrentTraceRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });
});
