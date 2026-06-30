import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzePedidoMovementState,
  partitionPedidoInventoryMovements
} from '../inventarioMovimientoService.js';

const context = {
  idPedido: 500,
  fechaHoraPedidoEpochMs: Date.UTC(2026, 5, 30, 10, 0, 0, 0),
  detallePedidoIds: [900]
};
const pedidoMs = context.fechaHoraPedidoEpochMs;
const minutes = (value) => value * 60 * 1000;

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
  fecha_mov_epoch_ms: Date.UTC(2026, 5, 20, 10, 0, 0, 0),
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
  fecha_mov: '2026-06-30T10:00:05.000Z',
  fecha_mov_epoch_ms: pedidoMs + 5000
};

const classifySingle = (row, testContext = context) => partitionPedidoInventoryMovements({
  rows: [row],
  context: testContext
});

describe('pedido legacy id collision partition', () => {
  it('ignora colision legacy antigua y deja estado NONE', () => {
    const partition = classifySingle(oldLegacy);
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
    const partition = classifySingle({
      ...oldLegacy,
      fecha_mov: '2026-06-30T10:00:05.000Z',
      fecha_mov_epoch_ms: pedidoMs + 5000
    });
    assert.equal(partition.currentLegacyRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('movimiento legacy sin fecha bloquea como INVALID_CURRENT_TRACE', () => {
    const partition = classifySingle({ ...oldLegacy, fecha_mov: null, fecha_mov_epoch_ms: null });
    assert.equal(partition.invalidCurrentTraceRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('ignora legacy antiguo aunque no tenga origen_consumo', () => {
    const partition = classifySingle({ ...oldLegacy, origen_consumo: null });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(partition.invalidCurrentTraceRows.length, 0);
  });

  it('ignora legacy antiguo aunque no tenga id_almacen', () => {
    const partition = classifySingle({ ...oldLegacy, id_almacen: null });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(partition.invalidCurrentTraceRows.length, 0);
  });

  it('ignora legacy antiguo aunque no tenga producto ni insumo', () => {
    const partition = classifySingle({ ...oldLegacy, id_producto: null, id_insumo: null });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(partition.invalidCurrentTraceRows.length, 0);
  });

  it('ignora legacy antiguo aunque tenga producto e insumo simultaneamente', () => {
    const partition = classifySingle({ ...oldLegacy, id_producto: 100, id_insumo: 200 });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(partition.invalidCurrentTraceRows.length, 0);
  });

  it('ignora legacy antiguo con datos incompletos', () => {
    const partition = classifySingle({
      ...oldLegacy,
      id_almacen: null,
      id_producto: null,
      id_insumo: null,
      origen_consumo: null,
      cantidad: null
    });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(partition.invalidCurrentTraceRows.length, 0);
  });

  it('ignora legacy seis horas anterior real si supera margen', () => {
    const partition = classifySingle({ ...oldLegacy, fecha_mov_epoch_ms: pedidoMs - minutes(360) });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
  });

  it('no ignora timestamps que parecen diferir seis horas pero epoch representa mismo instante', () => {
    const partition = classifySingle({
      ...oldLegacy,
      fecha_mov: '2026-06-30 04:00:00',
      fecha_mov_epoch_ms: pedidoMs
    });
    assert.equal(partition.currentLegacyRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('bloquea legacy exactamente en limite de cinco minutos', () => {
    const partition = classifySingle({ ...oldLegacy, fecha_mov_epoch_ms: pedidoMs - minutes(5) });
    assert.equal(partition.currentLegacyRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('ignora legacy cinco minutos y un milisegundo anterior', () => {
    const partition = classifySingle({ ...oldLegacy, fecha_mov_epoch_ms: pedidoMs - minutes(5) - 1 });
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
  });

  it('bloquea legacy cuatro minutos y cincuenta y nueve segundos anterior', () => {
    const partition = classifySingle({ ...oldLegacy, fecha_mov_epoch_ms: pedidoMs - minutes(4) - 59000 });
    assert.equal(partition.currentLegacyRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('bloquea legacy posterior al pedido', () => {
    const partition = classifySingle({ ...oldLegacy, fecha_mov_epoch_ms: pedidoMs + 1 });
    assert.equal(partition.currentLegacyRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('bloquea legacy contemporaneo aunque no tenga origen_consumo', () => {
    const partition = classifySingle({
      ...oldLegacy,
      origen_consumo: null,
      fecha_mov_epoch_ms: pedidoMs
    });
    assert.equal(partition.currentLegacyRows.length, 1);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 0);
  });

  it('bloquea fecha invalida normalizada', () => {
    const partition = classifySingle({ ...oldLegacy, fecha_mov_epoch_ms: 'invalid' });
    assert.equal(partition.invalidCurrentTraceRows.length, 1);
  });

  it('clasifica correctamente cambio de dia, mes y año con epochs normalizados', () => {
    for (const fecha_mov_epoch_ms of [
      Date.UTC(2026, 5, 29, 23, 59, 59, 999),
      Date.UTC(2026, 4, 31, 23, 59, 59, 999),
      Date.UTC(2025, 11, 31, 23, 59, 59, 999)
    ]) {
      const partition = classifySingle({ ...oldLegacy, fecha_mov_epoch_ms });
      assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    }
  });

  it('ignora movimiento FALTANTE_COCINA antiguo y bloquea contemporaneo', () => {
    const oldShortage = classifySingle({
      ...oldLegacy,
      ref_origen: 'FALTANTE_COCINA',
      fecha_mov_epoch_ms: pedidoMs - minutes(6)
    });
    const currentShortage = classifySingle({
      ...oldLegacy,
      ref_origen: 'FALTANTE_COCINA',
      fecha_mov_epoch_ms: pedidoMs - minutes(4)
    });
    assert.equal(oldShortage.ignoredLegacyCollisionRows.length, 1);
    assert.equal(currentShortage.currentLegacyRows.length, 1);
  });

  it('movimiento antiguo con trazabilidad parcial bloquea', () => {
    const partition = classifySingle({
      ...oldLegacy,
      id_pedido_trazabilidad: 500,
      id_detalle_pedido: null,
      fecha_mov_epoch_ms: pedidoMs - minutes(60)
    });
    assert.equal(partition.invalidCurrentTraceRows.length, 1);
  });

  it('movimiento actual trazado sin origen_consumo queda invalido', () => {
    const partition = partitionPedidoInventoryMovements({
      rows: [{ ...currentComplete, origen_consumo: null }],
      context
    });
    assert.equal(partition.invalidCurrentTraceRows.length, 1);
    assert.equal(partition.currentTracedRows.length, 0);
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

  it('fixture QA-like legacy con origen_consumo null se ignora', () => {
    const qaContext = {
      idPedido: 81,
      fechaHoraPedidoEpochMs: Date.UTC(2026, 5, 30, 10, 0, 0, 0),
      detallePedidoIds: [910]
    };
    const partition = classifySingle({
      id_movimiento: 81,
      id_ref: 81,
      id_detalle_pedido: null,
      id_pedido_trazabilidad: null,
      id_almacen: 1,
      id_producto: null,
      id_insumo: 22,
      origen_consumo: null,
      ref_origen: 'PEDIDO',
      tipo: 'SALIDA',
      fecha_mov_epoch_ms: qaContext.fechaHoraPedidoEpochMs - minutes(60)
    }, qaContext);
    assert.equal(partition.ignoredLegacyCollisionRows.length, 1);
    assert.equal(partition.invalidCurrentTraceRows.length, 0);
  });
});
