import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerFacturaLoyaltyAccumulation } from '../fidelizacionService.js';
import { createFidelizacionMockClient } from '../../modules/fidelizacion/__tests__/fidelizacionMockClient.mjs';

// Menu publico: el registro de clientes (routers/public_cliente.js) nunca
// pide ni guarda telefono, y el telefono que el cliente SI escribe en el
// checkout (pedidos_contacto.telefono_normalizado) nunca se sincronizaba de
// vuelta a personas/empresas -por eso un cliente del menu publico quedaba
// con CLIENT_PROFILE_INCOMPLETE para siempre, sin importar cuantas veces
// escribiera su telefono al pagar-. Estas pruebas ejercitan
// registerFacturaLoyaltyAccumulation de verdad (comportamiento real, no
// solo regex), con un mock relacional minimo (clientesRelacional/pedidos/
// pedidosContacto) que representa las mismas filas que
// fetchClienteProfileForFidelizacion lee.

const baseArgs = (overrides = {}) => ({
  idFactura: 700,
  idPedido: 500,
  idCliente: 5,
  idSucursal: 1,
  idUsuarioEjecutor: 9,
  montoFactura: 100,
  ...overrides
});

describe('registerFacturaLoyaltyAccumulation: backfill de telefono desde pedidos_contacto (menu publico)', () => {
  it('cliente con id_cliente, sin telefono en personas, con telefono valido en pedidos_contacto -> completa el perfil y acumula en el primer pago', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: true, nombre: 'Cliente Menu Publico', telefono: '' } },
      pedidos: { 500: { id_cliente: 5 } },
      pedidosContacto: { 500: { telefono_normalizado: '99998888' } },
      clientesRelacional: {
        5: { idPersona: 55, personaIdTelefono: null, personaTelefono: null }
      }
    });

    const result = await registerFacturaLoyaltyAccumulation(baseArgs({ client }));

    assert.equal(result.created, true, 'el backfill debe completar el perfil ANTES de evaluarlo, en el mismo pago');
    assert.equal(state.movimientos.length, 1);
    const rel = state.clientesRelacional[5];
    assert.equal(rel.personaTelefono, '9999-8888', 'debe normalizar con normalizePhoneHN');
    assert.ok(rel.personaIdTelefono, 'debe enlazar un id_telefono nuevo');
  });

  it('el backfill nunca sobrescribe un telefono ya existente en personas', async () => {
    const { client, state } = createFidelizacionMockClient({
      pedidos: { 501: { id_cliente: 6 } },
      pedidosContacto: { 501: { telefono_normalizado: '11112222' } },
      clientesRelacional: {
        6: { idPersona: 66, personaIdTelefono: 900, personaTelefono: '9000-0000' }
      },
      clienteProfiles: { 6: { estado: true, nombre: 'Cliente Con Telefono', telefono: '9000-0000' } }
    });

    const result = await registerFacturaLoyaltyAccumulation(baseArgs({
      client, idFactura: 701, idPedido: 501, idCliente: 6
    }));

    assert.equal(state.clientesRelacional[6].personaTelefono, '9000-0000', 'nunca se sobrescribe un telefono ya existente');
    assert.equal(result.created, true, 'perfil ya completo desde antes: acumula normalmente');
  });

  it('cliente sin telefono en personas NI en pedidos_contacto -> sigue CLIENT_PROFILE_INCOMPLETE, sin lanzar error', async () => {
    const { client, state } = createFidelizacionMockClient({
      pedidos: { 502: { id_cliente: 7 } },
      pedidosContacto: {},
      clientesRelacional: { 7: { idPersona: 77, personaIdTelefono: null, personaTelefono: null } },
      clienteProfiles: { 7: { estado: true, nombre: 'Sin Telefono En Ningun Lado', telefono: '' } }
    });

    let result;
    await assert.doesNotReject((async () => {
      result = await registerFacturaLoyaltyAccumulation(baseArgs({ client, idFactura: 702, idPedido: 502, idCliente: 7 }));
    })());

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.clientesRelacional[7].personaIdTelefono, null);
    assert.equal(state.movimientos.length, 0);
  });

  it('cuenta dividida: el backfill nunca se aplica a un cliente que no es el dueno del pedido', async () => {
    const { client, state } = createFidelizacionMockClient({
      // El pedido 503 es de la cliente 8 (quien hizo el pedido), pero esta
      // factura de division es de la cliente 9 (un acompanante).
      pedidos: { 503: { id_cliente: 8 } },
      pedidosContacto: { 503: { telefono_normalizado: '55556666' } },
      clientesRelacional: {
        9: { idPersona: 99, personaIdTelefono: null, personaTelefono: null }
      },
      clienteProfiles: { 9: { estado: true, nombre: 'Acompanante De Division', telefono: '' } }
    });

    const result = await registerFacturaLoyaltyAccumulation(baseArgs({ client, idFactura: 703, idPedido: 503, idCliente: 9 }));

    assert.equal(state.clientesRelacional[9].personaIdTelefono, null, 'nunca debe completarse con el telefono de otro cliente');
    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
  });

  it('cliente consumidor final (sin persona ni empresa): el backfill no falla, simplemente no tiene nada que completar', async () => {
    const { client, state } = createFidelizacionMockClient({
      pedidos: { 504: { id_cliente: 10 } },
      pedidosContacto: { 504: { telefono_normalizado: '44443333' } },
      clientesRelacional: { 10: { idPersona: null, idEmpresa: null } },
      clienteProfiles: { 10: { estado: true, nombre: 'Consumidor Final', telefono: '' } }
    });

    let result;
    await assert.doesNotReject((async () => {
      result = await registerFacturaLoyaltyAccumulation(baseArgs({ client, idFactura: 704, idPedido: 504, idCliente: 10 }));
    })());

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
  });

  it('cliente tipo empresa: tambien se completa (no solo personas)', async () => {
    const { client, state } = createFidelizacionMockClient({
      pedidos: { 506: { id_cliente: 13 } },
      pedidosContacto: { 506: { telefono_normalizado: '22223333' } },
      clientesRelacional: { 13: { idEmpresa: 130, empresaIdTelefono: null, empresaTelefono: null } },
      clienteProfiles: { 13: { estado: true, nombre: 'Comercial ACME', telefono: '' } }
    });

    const result = await registerFacturaLoyaltyAccumulation(baseArgs({ client, idFactura: 707, idPedido: 506, idCliente: 13 }));

    assert.equal(result.created, true);
    assert.equal(state.clientesRelacional[13].empresaTelefono, '2222-3333');
  });

  it('una falla especifica en el backfill (tabla de telefonos) nunca impide la evaluacion normal del perfil', async () => {
    const { client, state } = createFidelizacionMockClient({
      pedidos: { 505: { id_cliente: 11 } },
      pedidosContacto: { 505: { telefono_normalizado: '77778888' } },
      clientesRelacional: { 11: { idPersona: 111, personaIdTelefono: null, personaTelefono: null } },
      clienteProfiles: { 11: { estado: true, nombre: 'Cliente Con Fallo De Backfill', telefono: '' } },
      failOn: 'INSERT INTO public.telefonos'
    });

    let result;
    await assert.doesNotReject((async () => {
      result = await registerFacturaLoyaltyAccumulation(baseArgs({ client, idFactura: 705, idPedido: 505, idCliente: 11 }));
    })());

    // El backfill fallo internamente (capturado), asi que el perfil sigue
    // incompleto -pero la funcion nunca lanza ni bloquea la evaluacion, y
    // tampoco hace ROLLBACK por esto-.
    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.clientesRelacional[11].personaIdTelefono, null);
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(!sqlCalls.includes('ROLLBACK'), 'una falla en el backfill no debe disparar un ROLLBACK de la evaluacion');
  });

  it('sin idPedido (venta directa sin pedido asociado): el backfill no hace nada, sin consultar pedidos_contacto', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 12: { estado: true, nombre: 'Venta Directa', telefono: '' } }
    });

    const result = await registerFacturaLoyaltyAccumulation(baseArgs({ client, idFactura: 706, idPedido: null, idCliente: 12 }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.ok(!state.calls.some((c) => c.sql.includes('pedidos_contacto')), 'sin idPedido no debe consultar pedidos_contacto');
  });
});
