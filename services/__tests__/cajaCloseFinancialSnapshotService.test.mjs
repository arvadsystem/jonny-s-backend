import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCajaCloseFinancialSnapshot } from '../cajaCloseFinancialSnapshotService.js';

describe('loadCajaCloseFinancialSnapshot', () => {
  it('conserva efectivo teorico negativo exacto cuando egresos superan apertura', async () => {
    const queryRunner = {
      async query(sql) {
        assert.match(sql, /sb\.monto_apertura\s*\+ at\.ventas_efectivo_netas\s*\+ COALESCE\(mm\.ingresos_manuales, 0\)\s*- COALESCE\(mm\.egresos_manuales, 0\)/);
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
            metodos_pago_invalidos: [],
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

  it('incluye OTRO y futuros metodos activos no efectivos sin ampliar el arqueo segmentado', async () => {
    const calls = [];
    const queryRunner = {
      async query(sql) {
        calls.push(sql);
        return {
          rows: [{
            id_sesion_caja: '20',
            monto_apertura: '0',
            ventas_efectivo_netas: '100',
            ventas_tarjeta_netas: '200',
            ventas_transferencia_netas: '300',
            ventas_no_efectivo_netas: '900',
            ingresos_manuales: '0',
            egresos_manuales: '0',
            efectivo_teorico: '100',
            tarjeta_teorico: '200',
            transferencia_teorico: '300',
            total_teorico: '1000',
            metodos_pago_invalidos: [],
            metodos: [
              { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: '100', reversiones: '0', ventas_netas: '100', monto_teorico: '100' },
              { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: '200', reversiones: '0', ventas_netas: '200', monto_teorico: '200' },
              { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: '300', reversiones: '0', ventas_netas: '300', monto_teorico: '300' }
            ],
            fingerprint: {
              cantidad_cobros: 4,
              total_cobros: '1000',
              ventas_efectivo_netas: '100',
              ventas_no_efectivo_netas: '900',
              efectivo_teorico: '100',
              total_teorico: '1000'
            }
          }]
        };
      }
    };

    const snapshot = await loadCajaCloseFinancialSnapshot({
      queryRunner,
      idSesionCaja: '20'
    });

    assert.equal(snapshot.ventasEfectivoNetas, 100);
    assert.equal(snapshot.ventasNoEfectivoNetas, 900);
    assert.equal(snapshot.totalTeorico, 1000);
    assert.equal(snapshot.fingerprint.ventas_no_efectivo_netas, 900);
    assert.deepEqual(snapshot.metodos.map((method) => method.codigo), [
      'EFECTIVO',
      'TARJETA',
      'TRANSFERENCIA'
    ]);
    assert.match(calls[0], /pm\.afecta_efectivo/);
    assert.match(calls[0], /WHEN mt\.afecta_efectivo IS TRUE/);
    assert.match(calls[0], /WHEN mt\.afecta_efectivo IS FALSE/);
    assert.match(calls[0], /\+ at\.ventas_no_efectivo_netas/);
    assert.doesNotMatch(calls[0], /codigo\) = ANY\(ARRAY\['EFECTIVO','TARJETA','TRANSFERENCIA'\]::text\[\]\)\s*\),\s*payments AS/);
  });

  it('rechaza cobros con metodo inexistente, inactivo o sin clasificacion contable', async () => {
    const queryRunner = {
      async query() {
        return {
          rows: [{
            id_sesion_caja: '21',
            metodos_pago_invalidos: [{
              id_metodo_pago: 99,
              codigo: 'LEGACY',
              motivo: 'INACTIVO'
            }]
          }]
        };
      }
    };

    await assert.rejects(
      loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '21' }),
      (error) => {
        assert.equal(error.code, 'VENTAS_CAJAS_METODO_PAGO_NO_CONTABILIZABLE');
        assert.equal(error.httpStatus, 409);
        assert.deepEqual(error.details.metodos, [{
          id_metodo_pago: 99,
          codigo: 'LEGACY',
          motivo: 'INACTIVO'
        }]);
        return true;
      }
    );
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
            metodos_pago_invalidos: [],
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

  it('resuelve reversiones por sesion, limita el reparto a esa sesion y no castea movimientos a int', async () => {
    const queryRunner = {
      async query(sql) {
        assert.match(sql, /EXISTS \(\s*SELECT 1\s*FROM public\.facturas_cobros fc_scope/);
        assert.match(sql, /fc\.id_sesion_caja\s*=\s*rs\.id_sesion_caja_atribuida/);
        assert.match(sql, /CARDINALITY\(rs\.sesiones_cobro\)\s*>=\s*2/);
        assert.doesNotMatch(sql, /MAX\(cm\.id_movimiento_caja\)::int/);
        return { rows: [] };
      }
    };

    await loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '1' });
  });

  it('rechaza con 409 una reversion heredada con cobros en dos sesiones', async () => {
    const queryRunner = {
      async query() {
        return {
          rows: [{
            id_sesion_caja: '1',
            reversiones_sesion_ambiguas: [{
              id_reversion: '91',
              id_factura_original: '81',
              sesiones: ['1', '2']
            }],
            metodos_pago_invalidos: []
          }]
        };
      }
    };

    await assert.rejects(
      loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '1' }),
      (error) => {
        assert.equal(error.httpStatus, 409);
        assert.equal(error.code, 'VENTAS_CAJAS_REVERSION_SESSION_AMBIGUOUS');
        assert.deepEqual(error.details, {
          id_reversion: '91',
          id_factura_original: '81',
          sesiones: ['1', '2']
        });
        return true;
      }
    );
  });

  it('resuelve catalogValidation por codigo exacto (nunca por MIN(id) arbitrario)', async () => {
    const queryRunner = {
      async query() {
        return {
          rows: [{
            id_sesion_caja: '30',
            monto_apertura: '0',
            ventas_efectivo_netas: '0',
            ventas_tarjeta_netas: '0',
            ventas_transferencia_netas: '0',
            ventas_no_efectivo_netas: '400',
            ingresos_manuales: '0',
            egresos_manuales: '0',
            efectivo_teorico: '0',
            tarjeta_teorico: '0',
            transferencia_teorico: '0',
            total_teorico: '400',
            metodos_pago_invalidos: [],
            metodos: [
              { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: '0', reversiones: '0', ventas_netas: '0', monto_teorico: '0' },
              { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: '0', reversiones: '0', ventas_netas: '0', monto_teorico: '0' },
              { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: '0', reversiones: '0', ventas_netas: '0', monto_teorico: '0' }
            ],
            catalogo_requerido: {
              EFECTIVO: { id_metodo_pago: 1, activo: true, afecta_efectivo: true },
              TARJETA: { id_metodo_pago: 2, activo: true, afecta_efectivo: false },
              TRANSFERENCIA: { id_metodo_pago: 3, activo: true, afecta_efectivo: false },
              OTRO: { id_metodo_pago: 4, activo: true, afecta_efectivo: false }
            },
            otros_no_efectivo_ventas_brutas: '400',
            otros_no_efectivo_reversiones: '0',
            otros_no_efectivo_ventas_netas: '400',
            otros_no_efectivo_metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: '400', reversiones: '0', ventas_netas: '400' }],
            fingerprint: {}
          }]
        };
      }
    };

    const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '30' });

    assert.equal(snapshot.catalogValidation.EFECTIVO.valido, true);
    assert.equal(snapshot.catalogValidation.TARJETA.valido, true);
    assert.equal(snapshot.catalogValidation.TRANSFERENCIA.valido, true);
    assert.equal(snapshot.catalogValidation.OTRO.valido, true);
    assert.equal(snapshot.catalogValidation.OTRO.id_metodo_pago, 4);
    assert.equal(snapshot.catalogValidation.OTRO.coincidencias, 1);
    assert.equal(snapshot.fingerprint.catalogo_otro, '1:4:1:0');
    assert.equal(snapshot.otrosNoEfectivo.ventas_brutas, 400);
    assert.equal(snapshot.otrosNoEfectivo.ventas_netas, 400);
    assert.deepEqual(snapshot.otrosNoEfectivo.metodos_agrupados, [
      { codigo: 'OTRO', ventas_brutas: 400, reversiones: 0, ventas_netas: 400 }
    ]);
  });

  it('detecta codigos de catalogo duplicados sin ocultarlos en jsonb_object_agg', async () => {
    const queryRunner = {
      async query(sql) {
        assert.match(sql, /COUNT\(pmc\.id_metodo_pago\)::int AS coincidencias/);
        assert.match(sql, /GROUP BY rc\.codigo/);
        return {
          rows: [{
            id_sesion_caja: '34',
            metodos_pago_invalidos: [],
            metodos: [],
            catalogo_requerido: {
              TARJETA: {
                coincidencias: 2,
                id_metodo_pago: null,
                activo: null,
                afecta_efectivo: null
              }
            },
            fingerprint: {}
          }]
        };
      }
    };

    const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '34' });
    assert.equal(snapshot.catalogValidation.TARJETA.valido, false);
    assert.equal(snapshot.catalogValidation.TARJETA.motivo, 'CODIGO_DUPLICADO');
    assert.equal(snapshot.catalogValidation.TARJETA.coincidencias, 2);
    assert.equal(snapshot.fingerprint.catalogo_tarjeta, '2:0:0:NULL');
  });

  it('marca catalogValidation invalido por codigo faltante, inactivo o afecta_efectivo incorrecto', async () => {
    const buildRow = (catalogoRequerido) => ({
      rows: [{
        id_sesion_caja: '31',
        metodos_pago_invalidos: [],
        catalogo_requerido: catalogoRequerido,
        metodos: [],
        fingerprint: {}
      }]
    });

    const queryRunnerMissing = { async query() { return buildRow({}); } };
    const missing = await loadCajaCloseFinancialSnapshot({ queryRunner: queryRunnerMissing, idSesionCaja: '31' });
    assert.equal(missing.catalogValidation.EFECTIVO.valido, false);
    assert.equal(missing.catalogValidation.EFECTIVO.motivo, 'NO_EXISTE');
    assert.equal(missing.catalogValidation.OTRO.valido, false);
    assert.equal(missing.catalogValidation.OTRO.motivo, 'NO_EXISTE');

    const queryRunnerInactive = {
      async query() {
        return buildRow({ EFECTIVO: { id_metodo_pago: 1, activo: false, afecta_efectivo: true } });
      }
    };
    const inactive = await loadCajaCloseFinancialSnapshot({ queryRunner: queryRunnerInactive, idSesionCaja: '31' });
    assert.equal(inactive.catalogValidation.EFECTIVO.valido, false);
    assert.equal(inactive.catalogValidation.EFECTIVO.motivo, 'INACTIVO');

    const queryRunnerMisclassified = {
      async query() {
        return buildRow({ TARJETA: { id_metodo_pago: 2, activo: true, afecta_efectivo: true } });
      }
    };
    const misclassified = await loadCajaCloseFinancialSnapshot({ queryRunner: queryRunnerMisclassified, idSesionCaja: '31' });
    assert.equal(misclassified.catalogValidation.TARJETA.valido, false);
    assert.equal(misclassified.catalogValidation.TARJETA.motivo, 'AFECTA_EFECTIVO_INCORRECTO');
  });

  it('degrada de forma segura cuando faltan los campos nuevos (fixture con forma anterior)', async () => {
    const queryRunner = {
      async query() {
        return {
          rows: [{
            id_sesion_caja: '32',
            metodos_pago_invalidos: [],
            metodos: [
              { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: '0', reversiones: '0', ventas_netas: '0', monto_teorico: '0' }
            ],
            fingerprint: {}
          }]
        };
      }
    };

    const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '32' });
    assert.equal(snapshot.catalogValidation.EFECTIVO.valido, false);
    assert.equal(snapshot.otrosNoEfectivo.ventas_brutas, 0);
    assert.equal(snapshot.otrosNoEfectivo.reversiones, 0);
    assert.equal(snapshot.otrosNoEfectivo.ventas_netas, 0);
    assert.deepEqual(snapshot.otrosNoEfectivo.metodos_agrupados, []);
  });

  it('conserva ventas_netas negativo en el bucket agrupado (reversiones superiores a ventas)', async () => {
    const queryRunner = {
      async query() {
        return {
          rows: [{
            id_sesion_caja: '33',
            metodos_pago_invalidos: [],
            metodos: [],
            catalogo_requerido: {
              OTRO: { id_metodo_pago: 4, activo: true, afecta_efectivo: false }
            },
            otros_no_efectivo_ventas_brutas: '0',
            otros_no_efectivo_reversiones: '300',
            otros_no_efectivo_ventas_netas: '-300',
            otros_no_efectivo_metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: '0', reversiones: '300', ventas_netas: '-300' }],
            fingerprint: {}
          }]
        };
      }
    };

    const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner, idSesionCaja: '33' });
    assert.equal(snapshot.otrosNoEfectivo.ventas_netas, -300);
    assert.equal(snapshot.otrosNoEfectivo.metodos_agrupados[0].ventas_netas, -300);
  });
});
