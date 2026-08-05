import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReversionPaymentAllocation } from '../../routers/ventas/services/ventasReversionPaymentAllocationService.js';

const payment = (id, amount, code, cash) => ({
  id_factura_cobro: id,
  id_metodo_pago: id,
  metodo_pago_codigo: code,
  metodo_pago_nombre: code,
  metodo_pago_encontrado: true,
  metodo_pago_activo: true,
  afecta_efectivo: cash,
  monto: amount
});
const allocate = (rows, current, previous = 0, total = rows.reduce((sum, row) => sum + row.monto, 0)) =>
  buildReversionPaymentAllocation({
    paymentRows: rows,
    facturaTotal: total,
    previouslyReversed: previous,
    currentReversal: current
  });

describe('distribucion financiera de reversiones por metodo', () => {
  it('reversion total en efectivo crea porcion efectiva completa', () => {
    const result = allocate([payment(1, 780, 'EFECTIVO', true)], 780);
    assert.equal(result.monto_efectivo_reversado, 780);
    assert.equal(result.asignaciones[0].monto_reversado, 780);
  });

  it('reversion total con tarjeta no afecta efectivo', () => {
    const result = allocate([payment(1, 780, 'TARJETA', false)], 780);
    assert.equal(result.monto_efectivo_reversado, 0);
  });

  it('reversion total con transferencia no afecta efectivo', () => {
    const result = allocate([payment(1, 780, 'TRANSFERENCIA', false)], 780);
    assert.equal(result.monto_efectivo_reversado, 0);
  });

  it('pago mixto total conserva suma exacta y topes por cobro', () => {
    const result = allocate([
      payment(10, 300.01, 'EFECTIVO', true),
      payment(11, 479.99, 'TARJETA', false)
    ], 780);
    assert.deepEqual(result.asignaciones.map((row) => row.monto_reversado), [300.01, 479.99]);
    assert.equal(result.monto_efectivo_reversado, 300.01);
  });

  it('pago mixto parcial se asigna deterministicamente por id_factura_cobro', () => {
    const result = allocate([
      payment(10, 300, 'EFECTIVO', true),
      payment(11, 480, 'TARJETA', false)
    ], 350);
    assert.deepEqual(result.asignaciones.map((row) => [row.metodo_pago_codigo, row.monto_reversado]), [
      ['EFECTIVO', 300],
      ['TARJETA', 50]
    ]);
  });

  it('dos parciales usan objetivo acumulado sin volver a consumir el primer metodo', () => {
    const rows = [payment(10, 300, 'EFECTIVO', true), payment(11, 480, 'TARJETA', false)];
    const first = allocate(rows, 250);
    const second = allocate(rows, 200, 250);
    assert.equal(first.monto_efectivo_reversado, 250);
    assert.equal(second.monto_efectivo_reversado, 50);
    assert.deepEqual(second.asignaciones.map((row) => [row.metodo_pago_codigo, row.monto_reversado]), [
      ['EFECTIVO', 50],
      ['TARJETA', 150]
    ]);
  });

  it('rechaza exceder el total pagado acumulado', () => {
    assert.throws(
      () => allocate([payment(1, 100, 'EFECTIVO', true)], 0.01, 100),
      (error) => error.code === 'VENTAS_REVERSION_MONTO_EXCEDE_COBROS'
    );
  });

  it('rechaza total de cobros distinto al total de factura', () => {
    assert.throws(
      () => allocate([payment(1, 99.99, 'EFECTIVO', true)], 50, 0, 100),
      (error) => error.code === 'VENTAS_REVERSION_COBROS_TOTAL_MISMATCH'
    );
  });

  it('rechaza metodo inexistente o inactivo', () => {
    const missing = { ...payment(1, 100, 'OTRO', false), metodo_pago_encontrado: false };
    const inactive = { ...payment(1, 100, 'OTRO', false), metodo_pago_activo: false };
    assert.throws(() => allocate([missing], 100), (error) => error.code === 'VENTAS_REVERSION_METODO_PAGO_NO_ENCONTRADO');
    assert.throws(() => allocate([inactive], 100), (error) => error.code === 'VENTAS_REVERSION_METODO_PAGO_INACTIVO');
  });

  it('mantiene exactitud de centavos en importes fraccionarios', () => {
    const result = allocate([
      payment(1, 0.01, 'EFECTIVO', true),
      payment(2, 0.02, 'TARJETA', false)
    ], 0.03);
    assert.equal(result.asignaciones.reduce((sum, row) => sum + row.monto_reversado, 0), 0.03);
  });
});
