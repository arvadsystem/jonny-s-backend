import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchClienteProfileForFidelizacion,
  isClienteProfileComplete
} from '../fidelizacionService.js';

// Mock fiel al modelo real (clientes -> personas/empresas -> telefonos),
// simulando un esquema SIN clientes.id_empresa_cliente (la variante mas
// comun hoy: empresaRelationExpr cae a c.id_empresa). No usa la cola/pool de
// fidelizacion: prueba directamente fetchClienteProfileForFidelizacion.
const createProfileTestClient = ({ clientes = [], personas = [], empresas = [], telefonos = [] }) => {
  const clientesById = new Map(clientes.map((c) => [c.id_cliente, c]));
  const personasById = new Map(personas.map((p) => [p.id_persona, p]));
  const empresasById = new Map(empresas.map((e) => [e.id_empresa, e]));
  const telefonosById = new Map(telefonos.map((t) => [t.id_telefono, t]));

  return {
    async query(sql, params = []) {
      const text = String(sql);

      if (text.includes('information_schema.columns')) {
        return { rowCount: 0, rows: [] };
      }

      if (text.includes('FROM public.clientes c') && text.includes('LEFT JOIN public.personas p')) {
        const idCliente = Number(params[0]);
        const cliente = clientesById.get(idCliente);
        if (!cliente) return { rows: [] };

        const esPersona = cliente.id_persona !== undefined && cliente.id_persona !== null;
        const persona = esPersona ? personasById.get(cliente.id_persona) : null;
        const empresa = !esPersona ? empresasById.get(cliente.id_empresa) : null;
        const nombre = esPersona ? (persona?.nombre ?? null) : (empresa?.nombre_empresa ?? null);
        const idTelefono = esPersona ? persona?.id_telefono : empresa?.id_telefono;
        const telefono = idTelefono ? (telefonosById.get(idTelefono)?.telefono ?? null) : null;

        return {
          rows: [{
            id_cliente: idCliente,
            estado: cliente.estado ?? true,
            nombre,
            telefono
          }]
        };
      }

      throw new Error(`UNEXPECTED_QUERY: ${text.slice(0, 100)}`);
    }
  };
};

describe('fetchClienteProfileForFidelizacion + isClienteProfileComplete (perfil real: personas/empresas/telefonos)', () => {
  it('persona activa con nombre y telefono validos: perfil completo', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 1, estado: true, id_persona: 10, id_empresa: null }],
      personas: [{ id_persona: 10, nombre: 'Juan Perez', id_telefono: 100 }],
      telefonos: [{ id_telefono: 100, telefono: '9999-9999' }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 1);
    assert.equal(isClienteProfileComplete(profile), true);
  });

  it('persona sin nombre: perfil incompleto', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 2, estado: true, id_persona: 11, id_empresa: null }],
      personas: [{ id_persona: 11, nombre: '', id_telefono: 101 }],
      telefonos: [{ id_telefono: 101, telefono: '9999-9999' }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 2);
    assert.equal(isClienteProfileComplete(profile), false);
  });

  it('persona sin telefono asociado: perfil incompleto', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 3, estado: true, id_persona: 12, id_empresa: null }],
      personas: [{ id_persona: 12, nombre: 'Maria Lopez', id_telefono: null }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 3);
    assert.equal(isClienteProfileComplete(profile), false);
  });

  it('empresa con nombre_empresa y telefono validos: perfil completo', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 4, estado: true, id_persona: null, id_empresa: 20 }],
      empresas: [{ id_empresa: 20, nombre_empresa: 'Acme SA', id_telefono: 200 }],
      telefonos: [{ id_telefono: 200, telefono: '2222-3333' }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 4);
    assert.equal(isClienteProfileComplete(profile), true);
  });

  it('empresa sin nombre_empresa: perfil incompleto', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 5, estado: true, id_persona: null, id_empresa: 21 }],
      empresas: [{ id_empresa: 21, nombre_empresa: null, id_telefono: 201 }],
      telefonos: [{ id_telefono: 201, telefono: '2222-3333' }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 5);
    assert.equal(isClienteProfileComplete(profile), false);
  });

  it('empresa sin telefono asociado: perfil incompleto', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 6, estado: true, id_persona: null, id_empresa: 22 }],
      empresas: [{ id_empresa: 22, nombre_empresa: 'Beta SA', id_telefono: null }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 6);
    assert.equal(isClienteProfileComplete(profile), false);
  });

  it('cliente inactivo: perfil incompleto aunque nombre y telefono sean validos', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 7, estado: false, id_persona: 13, id_empresa: null }],
      personas: [{ id_persona: 13, nombre: 'Carlos Ruiz', id_telefono: 300 }],
      telefonos: [{ id_telefono: 300, telefono: '8888-7777' }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 7);
    assert.equal(isClienteProfileComplete(profile), false);
  });

  it('telefono con formato ruidoso pero 8 digitos reales (+504, espacios, guiones): sigue siendo valido via normalizePhoneHN', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 8, estado: true, id_persona: 14, id_empresa: null }],
      personas: [{ id_persona: 14, nombre: 'Ana Diaz', id_telefono: 400 }],
      telefonos: [{ id_telefono: 400, telefono: '9999-9999' }]
    });

    const profile = await fetchClienteProfileForFidelizacion(client, 8);
    assert.equal(isClienteProfileComplete(profile), true);
  });

  it('cliente inexistente: perfil incompleto (no lanza)', async () => {
    const client = createProfileTestClient({});
    const profile = await fetchClienteProfileForFidelizacion(client, 999);
    assert.equal(profile, null);
    assert.equal(isClienteProfileComplete(profile), false);
  });

  it('la consulta de perfil nunca referencia usuarios_clientes ni roles (no exige usuario/rol CLIENTE)', async () => {
    const client = createProfileTestClient({
      clientes: [{ id_cliente: 1, estado: true, id_persona: 10, id_empresa: null }],
      personas: [{ id_persona: 10, nombre: 'Juan Perez', id_telefono: 100 }],
      telefonos: [{ id_telefono: 100, telefono: '9999-9999' }]
    });

    const calls = [];
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      calls.push(String(sql));
      return originalQuery(sql, params);
    };

    await fetchClienteProfileForFidelizacion(client, 1);

    assert.ok(calls.every((sql) => !sql.includes('usuarios_clientes') && !sql.includes('roles_usuarios')));
  });
});
