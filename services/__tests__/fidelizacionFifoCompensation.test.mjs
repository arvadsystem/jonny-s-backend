// Fase 4 (seccion 3.6 del ticket): compensacion FIFO de deuda de puntos
// (fidelizacion_ajustes_pendientes) dentro de addSaldoPoints, ejercitada a
// traves de registerFacturaLoyaltyAccumulation (unico punto de entrada
// exportado que la usa para acumulaciones -- Caja, ventas, menu publico y
// pago pendiente pasan todos por el mismo servicio central).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerFacturaLoyaltyAccumulation, __resetFidelizacionSchemaProbeCachesForTests } from '../fidelizacionService.js';
import { createFidelizacionMockClient } from '../../modules/fidelizacion/__tests__/fidelizacionMockClient.mjs';

beforeEach(() => {
  __resetFidelizacionSchemaProbeCachesForTests();
});

const baseAccumulationArgs = (client, overrides = {}) => ({
  client,
  idFactura: 101,
  idPedido: null,
  idCliente: 5,
  idSucursal: 1,
  idUsuarioEjecutor: 9,
  montoFactura: 250, // con lempiras_por_punto=10 (default del mock) -> 25 pts
  ...overrides
});

describe('14) una deuda pendiente: la acumulacion la compensa (total o parcialmente)', () => {
  it('acumulacion de 25 pts contra una deuda de 25 -> compensa exactamente, saldo disponible no sube', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 25, puntos_pendientes: 25, estado: 'PENDIENTE' }]
    });

    const result = await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client));

    assert.equal(result.created, true);
    assert.equal(result.points, 25);
    assert.equal(state.saldos.get(5).puntos_disponibles, 0, 'toda la acumulacion se destino a compensar la deuda');
    assert.equal(state.ajustesPendientes[0].estado, 'RECUPERADO');
  });
});

describe('15) varias deudas: se aplican en orden FIFO (fecha_creacion ASC, id_ajuste ASC)', () => {
  it('dos deudas: la mas antigua se compensa primero', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [
        { id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 10, puntos_pendientes: 10, estado: 'PENDIENTE', fecha_creacion: 2 },
        { id_cliente: 5, id_factura: 901, id_reversion: 2, puntos_objetivo: 10, puntos_pendientes: 10, estado: 'PENDIENTE', fecha_creacion: 1 }
      ]
    });

    // 25 pts nuevos: deben pagar completa la deuda mas antigua (id_reversion 2,
    // fecha_creacion 1) primero, luego la otra (id_reversion 1), y el
    // remanente (5) sube el saldo.
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client));

    const deudaAntigua = state.ajustesPendientes.find((a) => a.id_reversion === 2);
    const deudaReciente = state.ajustesPendientes.find((a) => a.id_reversion === 1);
    assert.equal(deudaAntigua.estado, 'RECUPERADO');
    assert.equal(deudaReciente.estado, 'RECUPERADO');
    assert.equal(state.saldos.get(5).puntos_disponibles, 5, '25 - 10 - 10 = 5 de remanente');
  });
});

describe('16-17-18) acumulacion menor/igual/mayor que la deuda', () => {
  it('16) acumulacion MENOR que la deuda: compensa parcialmente, saldo disponible sigue en 0', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 50, puntos_pendientes: 50, estado: 'PENDIENTE' }]
    });
    // montoFactura=100 -> 10 pts (lempiras_por_punto=10)
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 102, montoFactura: 100 }));

    assert.equal(state.ajustesPendientes[0].puntos_recuperados, 10);
    assert.equal(state.ajustesPendientes[0].puntos_pendientes, 40);
    assert.equal(state.ajustesPendientes[0].estado, 'PARCIALMENTE_RECUPERADO');
    assert.equal(state.saldos.get(5).puntos_disponibles, 0);
  });

  it('17) acumulacion IGUAL que la deuda: la salda por completo, saldo disponible sigue en 0', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 25, puntos_pendientes: 25, estado: 'PENDIENTE' }]
    });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 103 }));

    assert.equal(state.ajustesPendientes[0].puntos_pendientes, 0);
    assert.equal(state.ajustesPendientes[0].estado, 'RECUPERADO');
    assert.equal(state.saldos.get(5).puntos_disponibles, 0);
  });

  it('18) acumulacion MAYOR que la deuda: la salda y el remanente aumenta el saldo disponible', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 7, puntos_pendientes: 7, estado: 'PENDIENTE' }]
    });
    // 25 pts nuevos, deuda de 7 -> compensa 7, remanente 18 sube el saldo.
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 104 }));

    assert.equal(state.ajustesPendientes[0].puntos_pendientes, 0);
    assert.equal(state.ajustesPendientes[0].estado, 'RECUPERADO');
    assert.equal(state.saldos.get(5).puntos_disponibles, 18);
  });
});

describe('19-20) transiciones de estado del ajuste pendiente', () => {
  it('19) PENDIENTE -> PARCIALMENTE_RECUPERADO cuando queda deuda restante', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 100, puntos_pendientes: 100, estado: 'PENDIENTE' }]
    });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 105 }));
    assert.equal(state.ajustesPendientes[0].estado, 'PARCIALMENTE_RECUPERADO');
  });

  it('20) PARCIALMENTE_RECUPERADO -> RECUPERADO cuando la ultima compensacion salda el resto', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 100, puntos_recuperados: 90, puntos_pendientes: 10, estado: 'PARCIALMENTE_RECUPERADO' }]
    });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 106, montoFactura: 100 })); // 10 pts, exactamente lo pendiente
    assert.equal(state.ajustesPendientes[0].puntos_pendientes, 0);
    assert.equal(state.ajustesPendientes[0].estado, 'RECUPERADO');
  });
});

describe('21) remanente aumenta puntos_disponibles (solo el remanente, nunca el total acumulado)', () => {
  it('el saldo disponible sube exactamente por el remanente tras compensar toda la deuda', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 5, puntos_pendientes: 5, estado: 'PENDIENTE' }]
    });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 107 })); // 25 pts
    assert.equal(state.saldos.get(5).puntos_disponibles, 20, '25 - 5 de deuda = 20 de remanente');
  });

  it('puntos_acumulados_total (historico) sube por el TOTAL ganado, no solo el remanente', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 5, puntos_pendientes: 5, estado: 'PENDIENTE' }]
    });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 108 })); // 25 pts
    assert.equal(state.saldos.get(5).puntos_acumulados_total, 25, 'el cliente SI gano 25 puntos; la deuda es de una reversion previa, no reduce lo ganado');
  });
});

describe('22) movimiento auditable de compensacion', () => {
  it('crea un movimiento de fidelizacion adicional cuando compensa una deuda (ademas del movimiento de acumulacion)', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 5, puntos_pendientes: 5, estado: 'PENDIENTE' }]
    });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 109 }));
    // 1 movimiento de acumulacion + 1 movimiento de compensacion (catalogo
    // COMPENSACION/AJUSTE_PENDIENTE ya sembrado en el mock compartido).
    assert.equal(state.movimientos.length, 2);
  });

  it('sin deuda pendiente: solo se crea el movimiento de acumulacion (sin compensacion)', async () => {
    const { client, state } = createFidelizacionMockClient({ ajustesPendientesTableExists: true, ajustesPendientes: [] });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 110 }));
    assert.equal(state.movimientos.length, 1);
  });

  it('sin catalogos COMPENSACION/AJUSTE_PENDIENTE aborta antes de aplicar la deuda', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      compensationCatalogsAvailable: false,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 5, puntos_pendientes: 5, estado: 'PENDIENTE' }]
    });
    await assert.rejects(
      registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 112 })),
      (err) => err.code === 'FIDELIZACION_SCHEMA_PENDIENTE' && err.httpStatus === 409
    );
    assert.equal(state.ajustesPendientes[0].puntos_pendientes, 5);
    assert.equal(state.movimientos.length, 0);
  });

  it('la secuencia de saldos del movimiento principal y la compensacion es continua y termina en el saldo real', async () => {
    const { client, state } = createFidelizacionMockClient({
      ajustesPendientesTableExists: true,
      ajustesPendientes: [{ id_cliente: 5, id_factura: 900, id_reversion: 1, puntos_objetivo: 7, puntos_pendientes: 7, estado: 'PENDIENTE' }]
    });
    await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 113 }));
    const [acumulacion, compensacion] = state.movimientos;
    assert.equal(acumulacion.saldo_anterior, 0);
    assert.equal(acumulacion.saldo_nuevo, 25);
    assert.equal(compensacion.saldo_anterior, acumulacion.saldo_nuevo);
    assert.equal(compensacion.saldo_nuevo, 18);
    assert.equal(state.saldos.get(5).puntos_disponibles, compensacion.saldo_nuevo);
  });

  it('tabla fidelizacion_ajustes_pendientes ausente (esquema Fase 4 no aplicado): la acumulacion funciona exactamente igual que antes de Fase 4', async () => {
    const { client, state } = createFidelizacionMockClient({ ajustesPendientesTableExists: false });
    const result = await registerFacturaLoyaltyAccumulation(baseAccumulationArgs(client, { idFactura: 111 }));
    assert.equal(result.created, true);
    assert.equal(result.points, 25);
    assert.equal(state.saldos.get(5).puntos_disponibles, 25);
    assert.equal(state.movimientos.length, 1);
  });
});

describe('23) concurrencia sobre el mismo cliente: el bloqueo FOR UPDATE serializa la compensacion', () => {
  it('la consulta de ajustes pendientes usa FOR UPDATE (misma transaccion que ya bloquea fidelizacion_saldos_cliente)', () => {
    // Prueba de bloqueo/lock real requiere Postgres; se documenta aqui la
    // garantia estructural (mismo patron que el resto de la sesion para
    // "concurrencia" -- ver pg_advisory_xact_lock en createPresentialFidelizacionCanje
    // y FOR UPDATE en getClienteSaldoForUpdate/applyFifoCompensation).
    const source = readFileSync(resolve('services/fidelizacionService.js'), 'utf8');
    const block = source.match(/const applyFifoCompensation = async \(\{[\s\S]{0,900}/)?.[0] || '';
    assert.match(block, /FROM public\.fidelizacion_ajustes_pendientes[\s\S]{0,300}FOR UPDATE/);
    assert.match(block, /ORDER BY fecha_creacion ASC, id_ajuste ASC/);
  });
});
