import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveOriginalSessionFromCobros,
  lockAndValidateOriginalCajaSession
} from '../../routers/ventas/services/ventasReversionSessionService.js';

const makeClient = (handlers) => ({
  async query(sql, params) {
    for (const [pattern, handler] of handlers) {
      if (pattern.test(sql)) return handler(params);
    }
    throw new Error(`Consulta no simulada: ${sql}`);
  }
});

describe('resolveOriginalSessionFromCobros', () => {
  it('7) resuelve una unica sesion desde facturas_cobros -> permitida', async () => {
    const client = makeClient([
      [/FROM public\.facturas_cobros/, () => ({
        rowCount: 2,
        rows: [{ id_factura_cobro: 1, id_sesion_caja: 19 }, { id_factura_cobro: 2, id_sesion_caja: 19 }]
      })]
    ]);
    const result = await resolveOriginalSessionFromCobros({ client, idFactura: 232, facturaIdSesionCaja: 19 });
    assert.equal(result.id_sesion_caja, 19);
    assert.equal(result.cobros.length, 2);
  });

  it('8) cero sesiones (sin cobros) -> VENTAS_REVERSION_SESSION_MISSING', async () => {
    const client = makeClient([
      [/FROM public\.facturas_cobros/, () => ({ rowCount: 0, rows: [] })]
    ]);
    await assert.rejects(
      resolveOriginalSessionFromCobros({ client, idFactura: 232 }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_SESSION_MISSING');
        return true;
      }
    );
  });

  it('cero sesiones (cobros con id_sesion_caja nulo) -> VENTAS_REVERSION_SESSION_MISSING', async () => {
    const client = makeClient([
      [/FROM public\.facturas_cobros/, () => ({ rowCount: 1, rows: [{ id_factura_cobro: 1, id_sesion_caja: null }] })]
    ]);
    await assert.rejects(
      resolveOriginalSessionFromCobros({ client, idFactura: 232 }),
      (err) => err.code === 'VENTAS_REVERSION_SESSION_MISSING'
    );
  });

  it('9) varias sesiones distintas -> VENTAS_REVERSION_SESSION_AMBIGUOUS', async () => {
    const client = makeClient([
      [/FROM public\.facturas_cobros/, () => ({
        rowCount: 2,
        rows: [{ id_factura_cobro: 1, id_sesion_caja: 19 }, { id_factura_cobro: 2, id_sesion_caja: 20 }]
      })]
    ]);
    await assert.rejects(
      resolveOriginalSessionFromCobros({ client, idFactura: 232 }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_SESSION_AMBIGUOUS');
        return true;
      }
    );
  });

  it('10) sesion unica distinta a facturas.id_sesion_caja -> VENTAS_REVERSION_SESSION_MISMATCH', async () => {
    const client = makeClient([
      [/FROM public\.facturas_cobros/, () => ({ rowCount: 1, rows: [{ id_factura_cobro: 1, id_sesion_caja: 19 }] })]
    ]);
    await assert.rejects(
      resolveOriginalSessionFromCobros({ client, idFactura: 232, facturaIdSesionCaja: 41 }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_SESSION_MISMATCH');
        return true;
      }
    );
  });

  it('nunca elige la primera sesion arbitrariamente cuando hay ambiguedad', async () => {
    const client = makeClient([
      [/FROM public\.facturas_cobros/, () => ({
        rowCount: 3,
        rows: [
          { id_factura_cobro: 1, id_sesion_caja: 5 },
          { id_factura_cobro: 2, id_sesion_caja: 5 },
          { id_factura_cobro: 3, id_sesion_caja: 6 }
        ]
      })]
    ]);
    await assert.rejects(
      resolveOriginalSessionFromCobros({ client, idFactura: 1 }),
      (err) => err.code === 'VENTAS_REVERSION_SESSION_AMBIGUOUS'
    );
  });
});

describe('lockAndValidateOriginalCajaSession', () => {
  const openSessionRow = {
    id_sesion_caja: 19,
    id_caja: 1,
    id_sucursal: 3,
    fecha_cierre: null,
    estado_codigo: 'ABIERTA',
    caja_activa: true
  };

  it('11) sesion abierta, misma sucursal, caja activa -> permitida', async () => {
    const client = makeClient([
      [/fn_ventas_lock_caja_financial_session/, () => ({ rows: [] })],
      [/FROM public\.cajas_sesiones/, () => ({ rowCount: 1, rows: [openSessionRow] })]
    ]);
    const result = await lockAndValidateOriginalCajaSession({ client, idSesionCaja: 19, idSucursal: 3 });
    assert.deepEqual(result, { id_sesion_caja: 19, id_caja: 1, id_sucursal: 3 });
  });

  it('10) sesion cerrada (fecha_cierre no nula) -> VENTAS_REVERSION_SESION_CERRADA', async () => {
    const client = makeClient([
      [/fn_ventas_lock_caja_financial_session/, () => ({ rows: [] })],
      [/FROM public\.cajas_sesiones/, () => ({ rowCount: 1, rows: [{ ...openSessionRow, fecha_cierre: '2026-07-01', estado_codigo: 'CERRADA' }] })]
    ]);
    await assert.rejects(
      lockAndValidateOriginalCajaSession({ client, idSesionCaja: 19, idSucursal: 3 }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_SESION_CERRADA');
        return true;
      }
    );
  });

  it('venta de mas de 1 hora con sesion abierta -> permitida (no hay ventana de tiempo)', async () => {
    // Este helper no recibe ni evalua ninguna fecha/hora de la venta -- la
    // unica condicion es el estado de la sesion. Se confirma no pasando
    // ningun dato temporal y verificando que igual resuelve exitosamente.
    const client = makeClient([
      [/fn_ventas_lock_caja_financial_session/, () => ({ rows: [] })],
      [/FROM public\.cajas_sesiones/, () => ({ rowCount: 1, rows: [openSessionRow] })]
    ]);
    const result = await lockAndValidateOriginalCajaSession({ client, idSesionCaja: 19, idSucursal: 3 });
    assert.equal(result.id_sesion_caja, 19);
  });

  it('sucursal fuera de horario administrativo con sesion abierta -> permitida (no se consulta horario)', async () => {
    const calls = [];
    const client = makeClient([
      [/fn_ventas_lock_caja_financial_session/, () => ({ rows: [] })],
      [/FROM public\.cajas_sesiones/, (params) => { calls.push(params); return { rowCount: 1, rows: [openSessionRow] }; }]
    ]);
    await lockAndValidateOriginalCajaSession({ client, idSesionCaja: 19, idSucursal: 3 });
    assert.equal(calls.length, 1);
  });

  it('caja inactiva -> VENTAS_REVERSION_SESION_CERRADA', async () => {
    const client = makeClient([
      [/fn_ventas_lock_caja_financial_session/, () => ({ rows: [] })],
      [/FROM public\.cajas_sesiones/, () => ({ rowCount: 1, rows: [{ ...openSessionRow, caja_activa: false }] })]
    ]);
    await assert.rejects(
      lockAndValidateOriginalCajaSession({ client, idSesionCaja: 19, idSucursal: 3 }),
      (err) => err.code === 'VENTAS_REVERSION_SESION_CERRADA'
    );
  });

  it('sesion de sucursal distinta -> VENTAS_REVERSION_SESION_CERRADA', async () => {
    const client = makeClient([
      [/fn_ventas_lock_caja_financial_session/, () => ({ rows: [] })],
      [/FROM public\.cajas_sesiones/, () => ({ rowCount: 1, rows: [{ ...openSessionRow, id_sucursal: 99 }] })]
    ]);
    await assert.rejects(
      lockAndValidateOriginalCajaSession({ client, idSesionCaja: 19, idSucursal: 3 }),
      (err) => err.code === 'VENTAS_REVERSION_SESION_CERRADA'
    );
  });
});
