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
      { rowCount: 1, rows: [{ fn_ventas_assert_caja_session_write_open: null }] }
    ]);

    const row = await validateCajaSessionOpenForFinancialWrite({
      client,
      idSesionCaja: 11,
      idCaja: 7,
      idSucursal: 3,
      idUsuario: 5
    });

    assert.equal(row.id_sesion_caja, '11');
    assert.equal(row.id_caja, 7);
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].sql, /fn_ventas_assert_caja_session_write_open/);
  });

  it('rechaza con codigo estable si la sesion se cerro mientras esperaba el lock', async () => {
    const client = createClient([
      Object.assign(new Error('VENTAS_CAJA_SESSION_CLOSED'), { code: 'P0001' })
    ]);

    await assert.rejects(
      () => validateCajaSessionOpenForFinancialWrite({
        client,
        idSesionCaja: 11,
        idCaja: 7,
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
      Object.assign(new Error('VENTAS_CAJA_SESSION_PARTICIPATION_REQUIRED'), { code: 'P0001' })
    ]);

    await assert.rejects(
      () => validateCajaSessionOpenForFinancialWrite({
        client,
        idSesionCaja: 11,
        idCaja: 7,
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
