// Fase 4 (seccion 3.8 del ticket): resolucion de sesion de caja obligatoria
// para canjes presenciales de fidelizacion.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCanjeSesionCaja } from '../fidelizacionCanjeSessionService.js';

const OPEN_SESSION_ROW = (overrides = {}) => ({
  id_sesion_caja: 1,
  id_caja: 1,
  id_sucursal: 1,
  fecha_cierre: null,
  estado_codigo: 'ABIERTA',
  caja_activa: true,
  ...overrides
});

const createSessionMockClient = ({ userOpenSessions = [], allOpenSessions = [], sessionsById = {} } = {}) => {
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      // fetchUserOpenSessionsAtSucursal (tiene el filtro por id_usuario_responsable/participante)
      if (text.includes('cajas_sesiones_participantes csp') && text.includes('id_usuario_responsable')) {
        return { rows: userOpenSessions };
      }
      // fetchSessionById (validacion de sesion explicita)
      if (text.includes('estado_codigo') && text.includes('caja_activa') && text.includes('LIMIT 1')) {
        const id = Number(params[0]);
        const row = sessionsById[id];
        return { rows: row ? [row] : [] };
      }
      // fetchAllOpenSessionsAtSucursal (sin filtro por usuario)
      if (text.includes('cs.id_sucursal') && text.includes('ABIERTA') && !text.includes('cajas_sesiones_participantes')) {
        return { rows: allOpenSessions };
      }
      throw new Error(`Consulta no simulada en mock de sesion de canje: ${text}`);
    }
  };
  return client;
};

describe('24-25-26) Cajero (sin acceso multisucursal): siempre su propia sesion', () => {
  it('24) una sola sesion abierta -> se selecciona automaticamente', async () => {
    const client = createSessionMockClient({ userOpenSessions: [OPEN_SESSION_ROW({ id_sesion_caja: 42 })] });
    const result = await resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 7, hasMultisucursalAccess: false });
    assert.equal(result.id_sesion_caja, 42);
  });

  it('25) cero sesiones -> FIDELIZACION_CANJE_SESSION_REQUIRED', async () => {
    const client = createSessionMockClient({ userOpenSessions: [] });
    await assert.rejects(
      resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 7, hasMultisucursalAccess: false }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'FIDELIZACION_CANJE_SESSION_REQUIRED');
        return true;
      }
    );
  });

  it('26) varias sesiones del mismo usuario -> FIDELIZACION_CANJE_SESSION_AMBIGUOUS', async () => {
    const client = createSessionMockClient({
      userOpenSessions: [OPEN_SESSION_ROW({ id_sesion_caja: 1 }), OPEN_SESSION_ROW({ id_sesion_caja: 2 })]
    });
    await assert.rejects(
      resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 7, hasMultisucursalAccess: false }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'FIDELIZACION_CANJE_SESSION_AMBIGUOUS');
        return true;
      }
    );
  });

  it('un id_sesion_caja enviado por un cajero se ignora por completo (nunca elige sesion ajena)', async () => {
    const client = createSessionMockClient({ userOpenSessions: [OPEN_SESSION_ROW({ id_sesion_caja: 42 })] });
    const result = await resolveCanjeSesionCaja({
      client, idSucursal: 1, idUsuario: 7, hasMultisucursalAccess: false, requestedIdSesionCaja: 999
    });
    assert.equal(result.id_sesion_caja, 42, 'ignora 999 y usa su propia sesion resuelta');
  });
});

describe('27-28-29-30-31) Administrador/Super Admin (hasMultisucursalAccess=true)', () => {
  it('rechaza id_sesion_caja con sufijo no numerico (10abc)', async () => {
    const client = createSessionMockClient();
    await assert.rejects(
      resolveCanjeSesionCaja({
        client,
        idSucursal: 1,
        idUsuario: 7,
        hasMultisucursalAccess: true,
        requestedIdSesionCaja: '10abc'
      }),
      (err) => err.code === 'FIDELIZACION_CANJE_SESSION_INVALID' && err.httpStatus === 400
    );
  });
  it('27) sin id_sesion_caja explicito, una sola sesion abierta en la sucursal -> se selecciona automaticamente', async () => {
    const client = createSessionMockClient({ allOpenSessions: [OPEN_SESSION_ROW({ id_sesion_caja: 55 })] });
    const result = await resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 1, hasMultisucursalAccess: true });
    assert.equal(result.id_sesion_caja, 55);
  });

  it('sin id_sesion_caja explicito, ninguna sesion abierta -> FIDELIZACION_CANJE_SESSION_REQUIRED', async () => {
    const client = createSessionMockClient({ allOpenSessions: [] });
    await assert.rejects(
      resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 1, hasMultisucursalAccess: true }),
      { code: 'FIDELIZACION_CANJE_SESSION_REQUIRED' }
    );
  });

  it('28) sin id_sesion_caja explicito, varias sesiones abiertas -> FIDELIZACION_CANJE_SESSION_SELECTION_REQUIRED', async () => {
    const client = createSessionMockClient({
      allOpenSessions: [OPEN_SESSION_ROW({ id_sesion_caja: 1 }), OPEN_SESSION_ROW({ id_sesion_caja: 2 })]
    });
    await assert.rejects(
      resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 1, hasMultisucursalAccess: true }),
      { code: 'FIDELIZACION_CANJE_SESSION_SELECTION_REQUIRED' }
    );
  });

  it('29) id_sesion_caja explicito valido (misma sucursal, abierta) -> se usa esa', async () => {
    const client = createSessionMockClient({
      sessionsById: { 77: OPEN_SESSION_ROW({ id_sesion_caja: 77, id_sucursal: 1 }) }
    });
    const result = await resolveCanjeSesionCaja({
      client, idSucursal: 1, idUsuario: 1, hasMultisucursalAccess: true, requestedIdSesionCaja: 77
    });
    assert.equal(result.id_sesion_caja, 77);
  });

  it('30) id_sesion_caja explicito de OTRA sucursal -> FIDELIZACION_CANJE_SESSION_INVALID', async () => {
    const client = createSessionMockClient({
      sessionsById: { 77: OPEN_SESSION_ROW({ id_sesion_caja: 77, id_sucursal: 2 }) }
    });
    await assert.rejects(
      resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 1, hasMultisucursalAccess: true, requestedIdSesionCaja: 77 }),
      { code: 'FIDELIZACION_CANJE_SESSION_INVALID' }
    );
  });

  it('31) id_sesion_caja explicito ya CERRADA -> FIDELIZACION_CANJE_SESSION_INVALID', async () => {
    const client = createSessionMockClient({
      sessionsById: { 77: OPEN_SESSION_ROW({ id_sesion_caja: 77, id_sucursal: 1, fecha_cierre: '2026-01-01', estado_codigo: 'CERRADA' }) }
    });
    await assert.rejects(
      resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 1, hasMultisucursalAccess: true, requestedIdSesionCaja: 77 }),
      { code: 'FIDELIZACION_CANJE_SESSION_INVALID' }
    );
  });

  it('id_sesion_caja explicito inexistente -> FIDELIZACION_CANJE_SESSION_INVALID', async () => {
    const client = createSessionMockClient({ sessionsById: {} });
    await assert.rejects(
      resolveCanjeSesionCaja({ client, idSucursal: 1, idUsuario: 1, hasMultisucursalAccess: true, requestedIdSesionCaja: 999 }),
      { code: 'FIDELIZACION_CANJE_SESSION_INVALID' }
    );
  });
});

describe('32-33-34) canje guarda id_sesion_caja, no crea efecto financiero, historico con NULL sigue legible', () => {
  it('32) createPresentialFidelizacionCanje incluye id_sesion_caja en el INSERT de fidelizacion_canjes', () => {
    const source = readFileSync(resolve('services/fidelizacionService.js'), 'utf8');
    const insertBlock = source.match(/INSERT INTO public\.fidelizacion_canjes \([\s\S]{0,400}/)?.[0] || '';
    assert.match(insertBlock, /id_sesion_caja/);
  });

  it('id_sesion_caja es obligatorio (FIDELIZACION_CANJE_SESSION_REQUIRED si falta) y valida contra el esquema (FIDELIZACION_SCHEMA_PENDIENTE si la columna no existe)', () => {
    const source = readFileSync(resolve('services/fidelizacionService.js'), 'utf8');
    assert.match(source, /if \(!sesionCajaId\) \{/);
    assert.match(source, /FIDELIZACION_CANJE_SESSION_REQUIRED/);
    assert.match(source, /hasFidelizacionCanjesSesionCajaColumn/);
    assert.match(source, /FIDELIZACION_SCHEMA_PENDIENTE/);
  });

  it('33) createPresentialFidelizacionCanje nunca inserta en cajas_movimientos ni modifica efectivo/caja (los canjes no crean efecto financiero)', () => {
    const source = readFileSync(resolve('services/fidelizacionService.js'), 'utf8');
    const fnStart = source.indexOf('export const createPresentialFidelizacionCanje');
    const fnBody = source.slice(fnStart, fnStart + 6000);
    assert.doesNotMatch(fnBody, /INSERT INTO public\.cajas_movimientos/);
    assert.doesNotMatch(fnBody, /UPDATE public\.cajas_sesiones/);
  });

  it('34) la migracion de id_sesion_caja es NULLABLE (canjes historicos anteriores a Fase 4 siguen siendo legibles con NULL, nunca se infiere retroactivamente)', () => {
    const migration = readFileSync(resolve('sql/20260728_fidelizacion_canjes_sesion_caja_SAFE.sql'), 'utf8');
    assert.match(migration, /ADD COLUMN IF NOT EXISTS id_sesion_caja BIGINT NULL/);
    assert.doesNotMatch(migration, /UPDATE public\.fidelizacion_canjes/, 'no debe hacer backfill inferido para canjes historicos');
  });
});
