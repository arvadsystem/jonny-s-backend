import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCajaSessionOpenForFinancialWrite } from '../cajaSessionWriteGuardService.js';

const createClient = (responses) => ({
  calls: [],
  async query(sql, params) {
    this.calls.push({ sql, params });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response || { rowCount: 0, rows: [] };
  }
});

describe('validateCajaSessionOpenForFinancialWrite', () => {
  it('acepta una sesion abierta cuando el usuario sigue siendo participante activo', async () => {
    const client = createClient([
      {
        rowCount: 1,
        rows: [{
          id_caja: 7,
          id_sesion_caja: 11,
          id_sucursal: 3,
          id_participacion_caja: 19,
          rol_participacion: 'AUXILIAR'
        }]
      }
    ]);

    const row = await validateCajaSessionOpenForFinancialWrite({
      client,
      idSesionCaja: 11,
      idSucursal: 3,
      idUsuario: 5
    });

    assert.equal(row.id_sesion_caja, 11);
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].sql, /FOR UPDATE OF cs/);
  });

  it('rechaza con codigo estable si la sesion se cerro mientras esperaba el lock', async () => {
    const client = createClient([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [{
          id_sesion_caja: 11,
          id_sucursal: 3,
          estado_codigo: 'CERRADA',
          caja_activa: true,
          is_responsible: true,
          has_active_participation: true
        }]
      }
    ]);

    await assert.rejects(
      () => validateCajaSessionOpenForFinancialWrite({
        client,
        idSesionCaja: 11,
        idSucursal: 3,
        idUsuario: 5
      }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_CAJA_SESSION_CLOSED');
        return true;
      }
    );
  });

  it('no abre bypass para usuarios que ya no participan activamente', async () => {
    const client = createClient([
      { rowCount: 0, rows: [] },
      {
        rowCount: 1,
        rows: [{
          id_sesion_caja: 11,
          id_sucursal: 3,
          estado_codigo: 'ABIERTA',
          caja_activa: true,
          is_responsible: false,
          has_active_participation: false
        }]
      }
    ]);

    await assert.rejects(
      () => validateCajaSessionOpenForFinancialWrite({
        client,
        idSesionCaja: 11,
        idSucursal: 3,
        idUsuario: 5
      }),
      (err) => {
        assert.equal(err.httpStatus, 403);
        assert.equal(err.code, 'VENTAS_CAJA_SESSION_PARTICIPATION_REQUIRED');
        return true;
      }
    );
  });
});
