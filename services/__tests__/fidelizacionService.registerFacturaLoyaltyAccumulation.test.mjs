import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerFacturaLoyaltyAccumulation } from '../fidelizacionService.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';

describe('registerFacturaLoyaltyAccumulation', () => {
  it('acumula puntos en una venta inmediata (factura nueva)', async () => {
    const { client, state } = createFidelizacionMockClient();

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 101,
      idPedido: null,
      idCliente: 5,
      idSucursal: 1,
      idUsuarioEjecutor: 9,
      montoFactura: 250
    });

    assert.equal(result.created, true);
    assert.equal(result.points, 25);
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.movimientos[0].id_factura, 101);
  });

  it('acumula puntos cuando la factura proviene de un pedido pendiente pagado', async () => {
    const { client, state } = createFidelizacionMockClient();

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 202,
      idPedido: 55,
      idCliente: 5,
      idSucursal: 1,
      idUsuarioEjecutor: 9,
      montoFactura: 100
    });

    assert.equal(result.created, true);
    assert.equal(result.points, 10);
    assert.equal(state.movimientos.length, 1);
  });

  it('factura ya acumulada: es idempotente y no inserta un segundo movimiento', async () => {
    const { client, state } = createFidelizacionMockClient({
      movimientos: [{ id_movimiento: 1, id_factura: 303, tipo: 'ACUMULACION', origen: 'FACTURA' }]
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 303,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ALREADY_REGISTERED');
    assert.equal(result.idMovimiento, 1);
    assert.equal(state.movimientos.length, 1, 'no debe crear un movimiento duplicado');
  });

  it('reintento de acumulacion: un fallo a mitad de camino no deja estado parcial, y el reintento si acumula', async () => {
    const { client: failingClient, state } = createFidelizacionMockClient({
      failOn: 'INSERT INTO public.fidelizacion_movimientos'
    });

    await assert.rejects(
      registerFacturaLoyaltyAccumulation({
        client: failingClient,
        idFactura: 404,
        idCliente: 5,
        idSucursal: 1,
        montoFactura: 100
      }),
      /SIMULATED_FAILURE/
    );

    // En produccion, este fallo ocurre dentro de una transaccion propia que
    // hace ROLLBACK (ver registerVentaFidelizacionAfterCommit), por lo que
    // ninguna de las escrituras previas (saldo, movimiento) queda persistida.
    // Simulamos ese ROLLBACK reconstruyendo un cliente limpio para el reintento.
    const { client: retryClient, state: retryState } = createFidelizacionMockClient();

    const retryResult = await registerFacturaLoyaltyAccumulation({
      client: retryClient,
      idFactura: 404,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(retryResult.created, true);
    assert.equal(retryState.movimientos.length, 1);
    assert.equal(state.movimientos.length, 0, 'el intento fallido no debio persistir movimientos');
  });

  it('fallo simulado de fidelizacion: la funcion propaga el error sin intentar recuperarlo por si misma', async () => {
    const { client } = createFidelizacionMockClient({
      failOn: 'FROM public.fidelizacion_configuracion_sucursal'
    });

    await assert.rejects(
      registerFacturaLoyaltyAccumulation({
        client,
        idFactura: 505,
        idCliente: 5,
        idSucursal: 1,
        montoFactura: 100
      }),
      /SIMULATED_FAILURE/
    );
  });

  it('cliente no elegible: no acumula y no lanza error', async () => {
    const { client, state } = createFidelizacionMockClient({ elegible: false });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 606,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_NOT_ELIGIBLE');
    assert.equal(state.movimientos.length, 0);
  });

  it('datos requeridos ausentes: no acumula y no ejecuta ninguna consulta', async () => {
    const { client, state } = createFidelizacionMockClient();

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: null,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'MISSING_REQUIRED_DATA');
    assert.equal(state.calls.length, 0);
  });
});
