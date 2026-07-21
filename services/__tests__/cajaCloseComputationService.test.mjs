import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSegmentedArqueoComputation,
  fingerprintValuesEqual,
  OTHER_NON_CASH_METHOD_CODE
} from '../cajaCloseComputationService.js';

// Catalogo valido de referencia (EFECTIVO=1, TARJETA=2, TRANSFERENCIA=3,
// OTRO=4), reflejando el estado real observado en QA/produccion.
const VALID_CATALOG_VALIDATION = Object.freeze({
  EFECTIVO: { codigo: 'EFECTIVO', id_metodo_pago: 1, activo: true, afecta_efectivo: true, valido: true, motivo: null },
  TARJETA: { codigo: 'TARJETA', id_metodo_pago: 2, activo: true, afecta_efectivo: false, valido: true, motivo: null },
  TRANSFERENCIA: { codigo: 'TRANSFERENCIA', id_metodo_pago: 3, activo: true, afecta_efectivo: false, valido: true, motivo: null },
  OTRO: { codigo: 'OTRO', id_metodo_pago: 4, activo: true, afecta_efectivo: false, valido: true, motivo: null }
});

const NO_OTHER_ACTIVITY = Object.freeze({ ventas_brutas: 0, reversiones: 0, ventas_netas: 0, metodos_agrupados: [] });

const snapshot = {
  catalogValidation: VALID_CATALOG_VALIDATION,
  otrosNoEfectivo: NO_OTHER_ACTIVITY,
  metodos: [
    { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 0, reversiones: 0, ventas_netas: 0, monto_teorico: 0 },
    { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 10, reversiones: 0, ventas_netas: 10, monto_teorico: 10 },
    { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 0, reversiones: 0, ventas_netas: 0, monto_teorico: 0 }
  ]
};

describe('caja close computation', () => {
  it('no exige observacion en preview/validacion cuando se desactiva la regla', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot,
      payloadRows: [
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 9, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });

    const tarjeta = result.rows.find((row) => row.metodo_pago_codigo === 'TARJETA');
    assert.equal(tarjeta.requiere_revision, true);
    assert.equal(tarjeta.observacion_requerida, false);
  });

  it('sin actividad agrupada no genera fila OTRO (retrocompatible con 3 filas)', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot: {
        catalogValidation: VALID_CATALOG_VALIDATION,
        otrosNoEfectivo: NO_OTHER_ACTIVITY,
        metodos: [
          { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 100, monto_teorico: 100 },
          { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 200, monto_teorico: 200 },
          { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 300, monto_teorico: 300 }
        ]
      },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 100 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });

    assert.deepEqual(result.rows.map((row) => row.metodo_pago_codigo), ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);
    assert.equal(result.monto_teorico_total, 600);
    assert.equal(result.monto_declarado_total, 600);
    assert.equal(result.diferencia_total, 0);
  });

  it('agrupa metodos no efectivo distintos de tarjeta/transferencia en una fila OTRO valida y visible', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot: {
        catalogValidation: VALID_CATALOG_VALIDATION,
        otrosNoEfectivo: {
          ventas_brutas: 400,
          reversiones: 0,
          ventas_netas: 400,
          metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: 400, reversiones: 0, ventas_netas: 400 }]
        },
        metodos: [
          { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 100, monto_teorico: 100 },
          { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 200, monto_teorico: 200 },
          { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 300, monto_teorico: 300 }
        ]
      },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 100 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });

    assert.deepEqual(result.rows.map((row) => row.metodo_pago_codigo), [
      'EFECTIVO',
      'TARJETA',
      'TRANSFERENCIA',
      OTHER_NON_CASH_METHOD_CODE
    ]);
    assert.equal(OTHER_NON_CASH_METHOD_CODE, 'OTRO');
    const otros = result.rows.at(-1);
    // El id_metodo_pago debe ser el id exacto del catalogo cuyo codigo es
    // OTRO (nunca null, nunca un MIN() arbitrario de otro codigo).
    assert.equal(otros.id_metodo_pago, 4);
    assert.equal(otros.display_name, 'Otros no efectivo');
    assert.equal(otros.editable, false);
    assert.equal(otros.monto_teorico, 400);
    assert.equal(otros.monto_declarado, 400);
    assert.equal(otros.diferencia, 0);
    assert.equal(otros.completado_automaticamente, true);
    assert.equal(otros.requiere_revision, false);
    assert.equal(result.monto_teorico_total, 1000);
    assert.equal(result.monto_declarado_total, 1000);
    assert.equal(result.diferencia_total, 0);
    assert.equal(
      result.rows.reduce((sum, row) => sum + row.monto_declarado, 0),
      result.monto_declarado_total
    );
    assert.equal(
      result.rows.reduce((sum, row) => sum + row.monto_teorico, 0),
      result.monto_teorico_total
    );
  });

  it('ancla monto_declarado de OTRO en 0 cuando el residual neto es negativo y exige revision (5.4)', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot: {
        catalogValidation: VALID_CATALOG_VALIDATION,
        otrosNoEfectivo: {
          ventas_brutas: 0,
          reversiones: 300,
          ventas_netas: -300,
          metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: 0, reversiones: 300, ventas_netas: -300 }]
        },
        metodos: [
          { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 0, monto_teorico: 3000 },
          { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 0, monto_teorico: 0 },
          { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 0, monto_teorico: 0 }
        ]
      },
      payloadRows: [{ metodo_pago_codigo: 'EFECTIVO', monto_declarado: 3000 }],
      threshold: 0,
      requireObservacionOnDifference: true
    });

    const otros = result.rows.find((row) => row.metodo_pago_codigo === OTHER_NON_CASH_METHOD_CODE);
    assert.equal(otros.monto_teorico, -300);
    assert.equal(otros.monto_declarado, 0);
    assert.ok(otros.monto_declarado >= 0);
    assert.equal(otros.diferencia, 300);
    // 5.4: "No marcar una fila con diferencia distinta de cero como
    // requiere_revision=false" -- a diferencia de la version anterior, esto
    // ahora exige revision (el cierre queda PENDIENTE_REVISION) aunque no
    // bloquea el cierre en si.
    assert.equal(otros.requiere_revision, true);
    assert.equal(otros.observacion_requerida, false);
    assert.match(otros.observacion, /Conciliaci.n autom.tica/);
    assert.equal(result.monto_teorico_total, 2700);
    assert.equal(result.monto_declarado_total, 3000);
    assert.equal(result.diferencia_total, 300);
  });

  it('conserva total positivo cuando el efectivo teorico es negativo', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot: {
        catalogValidation: VALID_CATALOG_VALIDATION,
        otrosNoEfectivo: NO_OTHER_ACTIVITY,
        metodos: [
          { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 0, monto_teorico: -2000 },
          { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 2500, monto_teorico: 2500 },
          { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 0, monto_teorico: 0 }
        ]
      },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 2500, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });

    assert.equal(result.monto_teorico_total, 500);
    assert.equal(result.diferencia_total, 2000);
  });

  it('rechaza con 409 antes de escribir cuando falta EFECTIVO/TARJETA/TRANSFERENCIA en el catalogo', () => {
    for (const missingCode of ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']) {
      const brokenCatalog = {
        ...VALID_CATALOG_VALIDATION,
        [missingCode]: { codigo: missingCode, id_metodo_pago: null, activo: false, afecta_efectivo: null, valido: false, motivo: 'NO_EXISTE' }
      };
      assert.throws(
        () => buildSegmentedArqueoComputation({
          snapshot: { catalogValidation: brokenCatalog, otrosNoEfectivo: NO_OTHER_ACTIVITY, metodos: snapshot.metodos },
          payloadRows: [],
          threshold: 0,
          requireObservacionOnDifference: false
        }),
        (error) => {
          assert.equal(error.code, 'VENTAS_CAJAS_METODO_CATALOGO_INCOMPLETO');
          assert.equal(error.httpStatus, 409);
          assert.equal(error.details.codigo, missingCode);
          assert.equal(error.details.motivo, 'NO_EXISTE');
          return true;
        }
      );
    }
  });

  it('rechaza con 409 antes de escribir cuando TARJETA esta mal clasificada (afecta_efectivo=true)', () => {
    const brokenCatalog = {
      ...VALID_CATALOG_VALIDATION,
      TARJETA: { codigo: 'TARJETA', id_metodo_pago: 2, activo: true, afecta_efectivo: true, valido: false, motivo: 'AFECTA_EFECTIVO_INCORRECTO' }
    };
    assert.throws(
      () => buildSegmentedArqueoComputation({
        snapshot: { catalogValidation: brokenCatalog, otrosNoEfectivo: NO_OTHER_ACTIVITY, metodos: snapshot.metodos },
        payloadRows: [],
        threshold: 0,
        requireObservacionOnDifference: false
      }),
      (error) => {
        assert.equal(error.code, 'VENTAS_CAJAS_METODO_CATALOGO_INCOMPLETO');
        assert.equal(error.details.motivo, 'AFECTA_EFECTIVO_INCORRECTO');
        return true;
      }
    );
  });

  it('rechaza con 409 antes de escribir cuando hay actividad agrupada pero OTRO es invalido', () => {
    const brokenCatalog = {
      ...VALID_CATALOG_VALIDATION,
      OTRO: { codigo: 'OTRO', id_metodo_pago: null, activo: false, afecta_efectivo: null, valido: false, motivo: 'NO_EXISTE' }
    };
    assert.throws(
      () => buildSegmentedArqueoComputation({
        snapshot: {
          catalogValidation: brokenCatalog,
          otrosNoEfectivo: { ventas_brutas: 400, reversiones: 0, ventas_netas: 400, metodos_agrupados: [] },
          metodos: snapshot.metodos
        },
        payloadRows: [
          { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
          { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 },
          { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
        ],
        threshold: 0,
        requireObservacionOnDifference: false
      }),
      (error) => {
        assert.equal(error.code, 'VENTAS_CAJAS_OTROS_NO_EFECTIVO_CONFIG_INVALID');
        assert.equal(error.httpStatus, 409);
        assert.equal(error.details.codigo, 'OTRO');
        assert.equal(error.details.motivo, 'NO_EXISTE');
        return true;
      }
    );
  });

  it('OTRO invalido pero sin actividad agrupada no bloquea el cierre (config invalida es irrelevante sin dinero en juego)', () => {
    const brokenCatalog = {
      ...VALID_CATALOG_VALIDATION,
      OTRO: { codigo: 'OTRO', id_metodo_pago: null, activo: false, afecta_efectivo: null, valido: false, motivo: 'NO_EXISTE' }
    };
    const result = buildSegmentedArqueoComputation({
      snapshot: { catalogValidation: brokenCatalog, otrosNoEfectivo: NO_OTHER_ACTIVITY, metodos: snapshot.metodos },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });
    assert.deepEqual(result.rows.map((row) => row.metodo_pago_codigo), ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);
  });

  it('compara ids bigint como cadenas canonicas', () => {
    assert.equal(fingerprintValuesEqual('max_id_factura_cobro', '9007199254740992', '9007199254740993'), false);
    assert.equal(fingerprintValuesEqual('max_id_reversion', '9223372036854775807', '9223372036854775807'), true);
    assert.equal(fingerprintValuesEqual('max_id_movimiento_caja', '001', '1'), true);
  });

  it('11.2: redondea a dos decimales con valores minimos (0.01) sin drift de punto flotante', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot: {
        catalogValidation: VALID_CATALOG_VALIDATION,
        otrosNoEfectivo: { ventas_brutas: 0.01, reversiones: 0, ventas_netas: 0.01, metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: 0.01, reversiones: 0, ventas_netas: 0.01 }] },
        metodos: [
          { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 0.01, monto_teorico: 0.01 },
          { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 0.02, monto_teorico: 0.02 },
          { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 0.03, monto_teorico: 0.03 }
        ]
      },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0.01 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 0.02, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0.03, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });
    assert.equal(result.monto_teorico_total, 0.07);
    assert.equal(result.monto_declarado_total, 0.07);
    assert.equal(result.diferencia_total, 0);
    // Nota real de redondeo (no un defecto de este cambio): sumar filas ya
    // redondeadas con + nativo de JS puede arrastrar epsilon binario propio
    // de IEEE754 (0.01+0.02+0.03+0.01 = 0.06999999999999999, no 0.07 exacto)
    // aunque cada fila y el total ya esten correctamente redondeados a dos
    // decimales. El invariante 5.5 se cumple en terminos monetarios (mismo
    // valor al centavo) cuando la verificacion aplica el mismo redondeo de
    // dos decimales que la acumulacion interna, no con una suma cruda.
    const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
    assert.equal(
      roundMoney(result.rows.reduce((sum, row) => sum + row.monto_teorico, 0)),
      result.monto_teorico_total
    );
  });

  it('11.2: reversion parcial con reparto proporcional no deja residuos de redondeo en el total', () => {
    // 3 cobros de 33.33 aportando a un grupo agrupado (no TARJETA/TRANSFERENCIA)
    // con una reversion parcial de 50.00: el reparto proporcional por cobro
    // puede no ser exacto por cobro, pero el NETO agrupado sí debe cuadrar.
    const grossTotal = 99.99;
    const reversedTotal = 50;
    const netTotal = Number((grossTotal - reversedTotal).toFixed(2));
    const result = buildSegmentedArqueoComputation({
      snapshot: {
        catalogValidation: VALID_CATALOG_VALIDATION,
        otrosNoEfectivo: {
          ventas_brutas: grossTotal,
          reversiones: reversedTotal,
          ventas_netas: netTotal,
          metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: grossTotal, reversiones: reversedTotal, ventas_netas: netTotal }]
        },
        metodos: [
          { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 0, monto_teorico: 0 },
          { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 0, monto_teorico: 0 },
          { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 0, monto_teorico: 0 }
        ]
      },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 0 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });
    const otros = result.rows.find((row) => row.metodo_pago_codigo === OTHER_NON_CASH_METHOD_CODE);
    assert.equal(otros.monto_teorico, netTotal);
    assert.equal(otros.monto_declarado, netTotal);
    assert.equal(
      result.rows.reduce((sum, row) => sum + row.monto_declarado, 0),
      result.monto_declarado_total
    );
  });

  it('11.5: no suma OTRO ni TARJETA/TRANSFERENCIA dos veces cuando hay actividad en todos los metodos', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot: {
        catalogValidation: VALID_CATALOG_VALIDATION,
        otrosNoEfectivo: { ventas_brutas: 150, reversiones: 50, ventas_netas: 100, metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: 150, reversiones: 50, ventas_netas: 100 }] },
        metodos: [
          { id_metodo_pago: 1, codigo: 'EFECTIVO', ventas_brutas: 500, monto_teorico: 500 },
          { id_metodo_pago: 2, codigo: 'TARJETA', ventas_brutas: 200, monto_teorico: 200 },
          { id_metodo_pago: 3, codigo: 'TRANSFERENCIA', ventas_brutas: 300, monto_teorico: 300 }
        ]
      },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 500 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 2 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 3 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });
    assert.equal(result.rows.length, 4);
    assert.equal(result.rows.filter((row) => row.metodo_pago_codigo === 'TARJETA').length, 1);
    assert.equal(result.rows.filter((row) => row.metodo_pago_codigo === 'TRANSFERENCIA').length, 1);
    assert.equal(result.rows.filter((row) => row.metodo_pago_codigo === OTHER_NON_CASH_METHOD_CODE).length, 1);
    // 500 + 200 + 300 + 100 = 1100, no 1200 (que seria el caso si OTRO se
    // sumara dos veces) ni 1000 (si se perdiera el grupo agrupado).
    assert.equal(result.monto_teorico_total, 1100);
    assert.equal(result.monto_declarado_total, 1100);
  });

  it('compara conteos como enteros y dinero con dos decimales', () => {
    assert.equal(fingerprintValuesEqual('cantidad_cobros', '2', 2), true);
    assert.equal(fingerprintValuesEqual('cantidad_movimientos', '2', 3), false);
    assert.equal(fingerprintValuesEqual('total_cobros', '10.004', '10.00'), true);
    assert.equal(fingerprintValuesEqual('ventas_no_efectivo_netas', '900.004', '900.00'), true);
    assert.equal(fingerprintValuesEqual('ventas_no_efectivo_netas', '900.01', '900.02'), false);
    assert.equal(fingerprintValuesEqual('total_teorico', '10.01', '10.02'), false);
  });
});
