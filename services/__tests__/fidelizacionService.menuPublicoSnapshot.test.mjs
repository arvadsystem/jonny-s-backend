import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerFacturaLoyaltyAccumulation } from '../fidelizacionService.js';
import { buildAccumulationSnapshot } from '../../modules/fidelizacion/infrastructure/fidelizacionRepository.js';
import { createFidelizacionMockClient } from '../../modules/fidelizacion/__tests__/fidelizacionMockClient.mjs';

// Menu publico: el registro de clientes (routers/public_cliente.js) nunca
// pide ni guarda telefono. El telefono que el cliente SI escribe en el
// checkout vive en pedidos_contacto. La acumulacion lo usa como SNAPSHOT
// HISTORICO -jamas escribiendo en telefonos/personas/empresas-, porque una
// escritura fallida (el UNIQUE de telefonos.telefono) abortaria toda la
// transaccion en PostgreSQL y ningun try/catch de JS la recuperaria.
//
// Reemplaza a fidelizacionService.publicMenuBackfill.test.mjs, que probaba
// justamente el backfill sincrono ya eliminado.

const baseArgs = (overrides = {}) => ({
  idFactura: 700,
  idPedido: 500,
  idCliente: 5,
  idSucursal: 1,
  idUsuarioEjecutor: 9,
  montoFactura: 100,
  ...overrides
});

const menuPublicoMock = (overrides = {}) => createFidelizacionMockClient({
  facturaContexts: {
    700: { id_pedido: 500, id_sucursal: 1, id_cliente: 5, monto_factura: 100, fecha_referencia_config: '2026-03-01T10:00:00Z' },
    ...(overrides.facturaContexts || {})
  },
  pedidos: { 500: { id_cliente: 5, origen_pedido: 'MENU' }, ...(overrides.pedidos || {}) },
  pedidosContacto: { 500: { nombre_contacto: 'Ana Menu', telefono_normalizado: '99998888' }, ...(overrides.pedidosContacto || {}) },
  // Perfil maestro tipico de un cliente del menu publico: tiene nombre
  // (lo pide el registro) pero NO tiene telefono (el registro nunca lo pide).
  clienteProfiles: { 5: { estado: true, nombre: 'Ana Menu', telefono: '' }, ...(overrides.clienteProfiles || {}) },
  ...(overrides.rest || {})
});

const acumularConSnapshot = async (client, args) => {
  const snapshot = await buildAccumulationSnapshot(client, { idFactura: args.idFactura });
  return registerFacturaLoyaltyAccumulation({ ...args, client, eligibilitySnapshot: snapshot });
};

describe('Menu publico: acumula desde el snapshot de pedidos_contacto, sin tocar el perfil maestro', () => {
  it('11/12: pedido MENU con nombre y telefono validos acumula, aunque personas.id_telefono sea null', async () => {
    const { client, state } = menuPublicoMock();

    const result = await acumularConSnapshot(client, baseArgs());

    assert.equal(result.created, true, 'debe acumular usando el telefono del pedido, no el del perfil maestro (vacio)');
    assert.equal(state.movimientos.length, 1);
  });

  it('13/14/15: no escribe en telefonos, personas ni empresas en ningun momento', async () => {
    const { client, state } = menuPublicoMock();

    await acumularConSnapshot(client, baseArgs());

    assert.deepEqual(state.escriturasPerfilMaestro, [], 'el camino de acumulacion debe ser SOLO LECTURA sobre el perfil maestro');
    const sqlCalls = state.calls.map((c) => c.sql).join('\n');
    assert.doesNotMatch(sqlCalls, /INSERT INTO public\.telefonos/);
    assert.doesNotMatch(sqlCalls, /UPDATE public\.telefonos/);
    assert.doesNotMatch(sqlCalls, /UPDATE public\.personas/);
    assert.doesNotMatch(sqlCalls, /UPDATE public\.empresas/);
  });

  it('20: pedido sin telefono valido no acumula, y no lanza (el pago continua)', async () => {
    const { client, state } = menuPublicoMock({
      pedidosContacto: { 500: { nombre_contacto: 'Ana Menu', telefono_normalizado: '' } }
    });

    let result;
    await assert.doesNotReject((async () => {
      result = await acumularConSnapshot(client, baseArgs());
    })());

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.movimientos.length, 0);
    assert.deepEqual(state.escriturasPerfilMaestro, []);
  });

  it('20b: pedido sin nombre valido no acumula', async () => {
    const { client } = menuPublicoMock({
      pedidosContacto: { 500: { nombre_contacto: '   ', telefono_normalizado: '99998888' } },
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '' } }
    });

    const result = await acumularConSnapshot(client, baseArgs());
    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
  });

  it('21: cliente sin usuario ni rol CLIENTE acumula igual (la regla es de perfil, no de credenciales)', async () => {
    const { client, state } = menuPublicoMock();

    const result = await acumularConSnapshot(client, baseArgs());

    assert.equal(result.created, true);
    const sqlCalls = state.calls.map((c) => c.sql).join('\n');
    assert.doesNotMatch(sqlCalls, /usuarios_clientes/);
    assert.doesNotMatch(sqlCalls, /roles_usuarios/);
  });

  it('22/23: contacto de un pedido de OTRO dueno no se usa (cuenta dividida)', async () => {
    // La factura es del cliente 9 (acompanante), pero el pedido -y por tanto
    // su fila de contacto- pertenece al cliente 5 (quien hizo el pedido).
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        701: { id_pedido: 500, id_sucursal: 1, id_cliente: 9, monto_factura: 100, fecha_referencia_config: '2026-03-01T10:00:00Z' }
      },
      pedidos: { 500: { id_cliente: 5, origen_pedido: 'MENU' } },
      pedidosContacto: { 500: { nombre_contacto: 'Ana Menu', telefono_normalizado: '99998888' } },
      clienteProfiles: { 9: { estado: true, nombre: 'Acompanante', telefono: '' } }
    });

    const snapshot = await buildAccumulationSnapshot(client, { idFactura: 701 });
    assert.equal(snapshot.fuenteSnapshot, 'PERFIL_MAESTRO', 'nunca debe tomar el contacto de un pedido ajeno');
    assert.equal(snapshot.telefonoSnapshot, null);
    assert.equal(snapshot.perfilCompletoSnapshot, false);

    const result = await registerFacturaLoyaltyAccumulation({
      ...baseArgs({ idFactura: 701, idCliente: 9 }),
      client,
      eligibilitySnapshot: snapshot
    });
    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.movimientos.length, 0);
  });

  it('origen CAJA: usa el perfil maestro, no el contacto del pedido', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: {
        702: { id_pedido: 600, id_sucursal: 1, id_cliente: 5, monto_factura: 100, fecha_referencia_config: '2026-03-01T10:00:00Z' }
      },
      pedidos: { 600: { id_cliente: 5, origen_pedido: 'CAJA' } },
      pedidosContacto: { 600: { nombre_contacto: 'Tecleado En Caja', telefono_normalizado: '11112222' } },
      clienteProfiles: { 5: { estado: true, nombre: 'Cliente POS', telefono: '9000-0000' } }
    });

    const snapshot = await buildAccumulationSnapshot(client, { idFactura: 702 });
    assert.equal(snapshot.fuenteSnapshot, 'PERFIL_MAESTRO');
    assert.equal(snapshot.telefonoSnapshot, '9000-0000');
    assert.equal(snapshot.perfilCompletoSnapshot, true);
  });

  it('origen NULL con evidencia completa del flujo publico: cuenta como menu publico', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: {
        703: { id_pedido: 610, id_sucursal: 1, id_cliente: 5, monto_factura: 100, fecha_referencia_config: '2026-03-01T10:00:00Z' }
      },
      pedidos: { 610: { id_cliente: 5, origen_pedido: null } },
      pedidosContacto: { 610: { nombre_contacto: 'Ana Legacy', telefono_normalizado: '99997777' } },
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Legacy', telefono: '' } }
    });

    const snapshot = await buildAccumulationSnapshot(client, { idFactura: 703 });
    assert.equal(snapshot.fuenteSnapshot, 'PEDIDO_CONTACTO');
    assert.equal(snapshot.telefonoSnapshot, '9999-7777');
    assert.equal(snapshot.perfilCompletoSnapshot, true);
  });

  it('origen NULL SIN evidencia completa (falta telefono en el contacto): cae al perfil maestro, no inventa elegibilidad', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: {
        704: { id_pedido: 620, id_sucursal: 1, id_cliente: 5, monto_factura: 100, fecha_referencia_config: '2026-03-01T10:00:00Z' }
      },
      pedidos: { 620: { id_cliente: 5, origen_pedido: null } },
      pedidosContacto: { 620: { nombre_contacto: 'Sin Telefono', telefono_normalizado: '' } },
      clienteProfiles: { 5: { estado: true, nombre: 'Perfil Maestro', telefono: '' } }
    });

    const snapshot = await buildAccumulationSnapshot(client, { idFactura: 704 });
    assert.equal(snapshot.fuenteSnapshot, 'PERFIL_MAESTRO');
    assert.equal(snapshot.perfilCompletoSnapshot, false);
  });

  it('cliente inactivo: nunca es elegible aunque el contacto del pedido sea valido', async () => {
    const { client } = menuPublicoMock({
      clienteProfiles: { 5: { estado: false, nombre: 'Ana Menu', telefono: '' } }
    });

    const snapshot = await buildAccumulationSnapshot(client, { idFactura: 700 });
    assert.equal(snapshot.perfilCompletoSnapshot, false, 'cliente inactivo nunca acumula');
  });
});

describe('Menu publico: prueba de transaccion abortada (por que el backfill sincrono era invalido)', () => {
  it('una escritura fallida a telefonos dejaria la transaccion ABORTADA: el camino actual nunca la intenta', async () => {
    const { client, state } = menuPublicoMock();

    // Demostracion del peligro: si alguien volviera a escribir el perfil
    // maestro dentro de esta transaccion y chocara con el UNIQUE, la
    // transaccion queda abortada y TODO lo siguiente falla con 25P02 -aunque
    // el error se capture en JavaScript-.
    state.telefonosUnicos.add('9999-8888');
    await assert.rejects(
      client.query('INSERT INTO public.telefonos (telefono) VALUES ($1) RETURNING id_telefono', ['9999-8888']),
      /unique constraint/
    );
    await assert.rejects(
      client.query('SELECT 1 FROM public.clientes c LEFT JOIN public.personas p ON true', []),
      (err) => err.code === '25P02'
    );

    // El camino real de acumulacion, en cambio, nunca intenta esa escritura:
    // con una transaccion limpia acumula sin tocar el perfil maestro.
    const limpio = menuPublicoMock();
    const result = await acumularConSnapshot(limpio.client, baseArgs());
    assert.equal(result.created, true);
    assert.deepEqual(limpio.state.escriturasPerfilMaestro, []);
  });
});
