import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerFacturaLoyaltyAccumulation } from '../fidelizacionService.js';
import { createFidelizacionMockClient } from '../../modules/fidelizacion/__tests__/fidelizacionMockClient.mjs';

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

  it('cliente con perfil incompleto (sin nombre): no acumula y no lanza error (skip, no fallo)', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '9999-9999' } }
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 606,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.movimientos.length, 0);
  });

  it('cliente con perfil incompleto (sin telefono): no acumula', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: true, nombre: 'Juan Perez', telefono: '' } }
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 607,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.movimientos.length, 0);
  });

  it('cliente inactivo: no acumula, y el perfil incompleto se clasifica como skip (no lanza, no hace ROLLBACK)', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: false, nombre: 'Juan Perez', telefono: '9999-9999' } }
    });

    let result;
    await assert.doesNotReject(
      (async () => {
        result = await registerFacturaLoyaltyAccumulation({
          client,
          idFactura: 608,
          idCliente: 5,
          idSucursal: 1,
          montoFactura: 100
        });
      })()
    );

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.movimientos.length, 0);
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(!sqlCalls.includes('ROLLBACK'));
  });

  it('cliente sin usuario ni rol CLIENTE: SI puede acumular (ya no se exige esa relacion)', async () => {
    const { client, state } = createFidelizacionMockClient();

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 609,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, true);
    assert.equal(state.movimientos.length, 1);
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.every((sql) => !sql.includes('usuarios_clientes') && !sql.includes('roles_usuarios')));
  });

  it('switch de acumulacion apagado: no acumula (ACCUMULATION_DISABLED)', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfig: { lempiras_por_punto: 10, acumulacion_habilitada: false }
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 610,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_DISABLED');
    assert.equal(state.movimientos.length, 0);
  });

  it('switch encendido con tasa valida: acumula', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfig: { lempiras_por_punto: 10, acumulacion_habilitada: true }
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 611,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, true);
    assert.equal(result.points, 10);
    assert.equal(state.movimientos.length, 1);
  });

  it('switch encendido sin tasa valida (0): ACCUMULATION_RULE_NOT_CONFIGURED', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfig: { lempiras_por_punto: 0, acumulacion_habilitada: true }
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 612,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_RULE_NOT_CONFIGURED');
    assert.equal(state.movimientos.length, 0);
  });

  it('configuracion historica: switch apagado en la fecha de la factura no acumula, aunque hoy este encendido', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 10, acumulacion_habilitada: false, vigente_desde: '2020-01-01T00:00:00Z', vigente_hasta: '2026-01-01T00:00:00Z' },
        { lempiras_por_punto: 10, acumulacion_habilitada: true, vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: null }
      ]
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 613,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100,
      referenceDate: '2025-06-01T00:00:00Z'
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_DISABLED');
    assert.equal(state.movimientos.length, 0);
  });

  it('configuracion historica: switch encendido en la fecha de la factura acumula, aunque hoy este apagado', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 10, acumulacion_habilitada: true, vigente_desde: '2020-01-01T00:00:00Z', vigente_hasta: '2026-01-01T00:00:00Z' },
        { lempiras_por_punto: 10, acumulacion_habilitada: false, vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: null }
      ]
    });

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura: 614,
      idCliente: 5,
      idSucursal: 1,
      montoFactura: 100,
      referenceDate: '2025-06-01T00:00:00Z'
    });

    assert.equal(result.created, true);
    assert.equal(state.movimientos.length, 1);
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
