import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCajaCloseFinancialSnapshot } from '../cajaCloseFinancialSnapshotService.js';

describe('loadCajaCloseFinancialSnapshot', () => {
  it('conserva efectivo teorico negativo exacto cuando egresos superan apertura', async () => {
    const queryRunner = {
      async query(sql) {
        assert.match(sql, /fs\.monto_apertura \+ fs\.ventas_efectivo_netas \+ fs\.ingresos_manuales - fs\.egresos_manuales/);
        return {
          rows: [{
            id_sesion_caja: '9',
            monto_apertura: '3000.00',
            ventas_efectivo_netas: '0.00',
            ventas_tarjeta_netas: '0.00',
            ventas_transferencia_netas: '0.00',
            ventas_no_efectivo_netas: '0.00',
            ingresos_manuales: '0.00',
            egresos_manuales: '16763.00',
            efectivo_teorico: '-13763.00',
            tarjeta_teorico: '0.00',
            transferencia_teorico: '0.00',
            total_teorico: '-13763.00',
            metodos: [{
              id_metodo_pago: 1,
              codigo: 'EFECTIVO',
              ventas_brutas: '0.00',
              reversiones: '0.00',
              ventas_netas: '0.00',
              monto_teorico: '-13763.00'
            }],
            fingerprint: {
              total_egresos_manuales: '16763.00',
              efectivo_teorico: '-13763.00',
              total_teorico: '-13763.00'
            }
          }]
        };
      }
    };

    const snapshot = await loadCajaCloseFinancialSnapshot({
      queryRunner,
      idSesionCaja: '9'
    });

    assert.equal(snapshot.montoApertura, 3000);
    assert.equal(snapshot.ventasEfectivoNetas, 0);
    assert.equal(snapshot.ingresosManuales, 0);
    assert.equal(snapshot.egresosManuales, 16763);
    assert.equal(snapshot.efectivoTeorico, -13763);
    assert.equal(snapshot.totalTeorico, -13763);
    assert.equal(snapshot.metodos.find((row) => row.codigo === 'EFECTIVO').monto_teorico, -13763);
  });

  it('ejecuta exactamente una consulta y normaliza metodos/fingerprint', async () => {
    const calls = [];
    const queryRunner = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{
            id_sesion_caja: '1',
            monto_apertura: '0',
            ventas_efectivo_netas: '0',
            ventas_tarjeta_netas: '0',
            ventas_transferencia_netas: '0',
            ventas_no_efectivo_netas: '0',
            ingresos_manuales: '0',
            egresos_manuales: '0',
            efectivo_teorico: '0',
            tarjeta_teorico: '0',
            transferencia_teorico: '0',
            total_teorico: '0',
            metodos: [
              { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: '0', reversiones: '0', ventas_netas: '0', monto_teorico: '0' },
              { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: '0', reversiones: '0', ventas_netas: '0', monto_teorico: '0' },
              { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: '0', reversiones: '0', ventas_netas: '0', monto_teorico: '0' }
            ],
            fingerprint: {
              cantidad_cobros: 0,
              max_id_factura_cobro: '9007199254740993',
              total_cobros: '0',
              cantidad_reversiones: 0,
              max_id_reversion: '0',
              total_reversado: '0',
              cantidad_movimientos: 0,
              max_id_movimiento_caja: '9223372036854775807',
              total_ingresos_manuales: '0',
              total_egresos_manuales: '0',
              efectivo_teorico: '0',
              tarjeta_teorico: '0',
              transferencia_teorico: '0',
              total_teorico: '0'
            }
          }]
        };
      }
    };

    const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '1' });

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /WITH session_base AS/);
    assert.match(calls[0].sql, /reversion_allocations AS/);
    assert.match(calls[0].sql, /COALESCE\(MAX\(id_factura_cobro\), 0\)::text FROM payments/);
    assert.equal(snapshot.metodos.length, 3);
    assert.equal(snapshot.fingerprint.max_id_factura_cobro, '9007199254740993');
    assert.equal(snapshot.fingerprint.max_id_movimiento_caja, '9223372036854775807');
  });

  it('usa EXISTS para reversiones heredadas y no castea movimientos a int', async () => {
    const queryRunner = {
      async query(sql) {
        assert.match(sql, /EXISTS \(\s*SELECT 1\s*FROM public\.facturas_cobros fc_scope/);
        assert.doesNotMatch(sql, /MAX\(cm\.id_movimiento_caja\)::int/);
        return { rows: [] };
      }
    };

    await loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '1' });
  });
});
