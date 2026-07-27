import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCloseValidationArithmeticIntegrity,
  assertCoreCatalogValid,
  buildSegmentedArqueoComputation,
  fingerprintValuesEqual,
  OTHER_NON_CASH_METHOD_CODE,
  recomputeAndAssertCloseValidation
} from '../cajaCloseComputationService.js';

// Catalogo valido de referencia (EFECTIVO=1, TARJETA=2, TRANSFERENCIA=3,
// OTRO=4), reflejando el estado real observado en QA/produccion.
const VALID_CATALOG_VALIDATION = Object.freeze({
  EFECTIVO: { codigo: 'EFECTIVO', coincidencias: 1, id_metodo_pago: 1, activo: true, afecta_efectivo: true, valido: true, motivo: null },
  TARJETA: { codigo: 'TARJETA', coincidencias: 1, id_metodo_pago: 2, activo: true, afecta_efectivo: false, valido: true, motivo: null },
  TRANSFERENCIA: { codigo: 'TRANSFERENCIA', coincidencias: 1, id_metodo_pago: 3, activo: true, afecta_efectivo: false, valido: true, motivo: null },
  OTRO: { codigo: 'OTRO', coincidencias: 1, id_metodo_pago: 4, activo: true, afecta_efectivo: false, valido: true, motivo: null }
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

const clone = (value) => JSON.parse(JSON.stringify(value));
const buildStoredValidationFixture = ({ sourceSnapshot = snapshot, payloadRows = null } = {}) => {
  const arqueos = payloadRows || [
    { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
    { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 },
    { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
  ];
  const computation = buildSegmentedArqueoComputation({
    snapshot: sourceSnapshot,
    payloadRows: arqueos,
    threshold: 0,
    requireObservacionOnDifference: true
  });
  const hayDiferencia = computation.rows.some((row) => row.diferencia !== 0);
  return {
    computation,
    validation: {
      total_teorico: computation.monto_teorico_total,
      total_declarado: computation.monto_declarado_total,
      diferencia_total: computation.diferencia_total,
      hay_diferencia: hayDiferencia,
      payload_declarado_json: { arqueos: clone(arqueos), observacion_cierre: null },
      resultado_json: {
        resumen: {
          total_teorico: computation.monto_teorico_total,
          total_declarado: computation.monto_declarado_total,
          diferencia_total: computation.diferencia_total,
          hay_diferencia: hayDiferencia
        },
        metodos: clone(computation.rows)
      }
    },
    validationMethods: computation.rows.map((row) => ({
      id_metodo_pago: row.id_metodo_pago,
      metodo_pago_codigo: row.metodo_pago_codigo,
      monto_teorico: row.monto_teorico,
      monto_declarado: row.monto_declarado,
      diferencia: row.diferencia,
      cantidad_referencias: row.cantidad_referencias,
      observacion: row.observacion,
      requiere_revision: row.requiere_revision
    }))
  };
};

describe('caja close computation', () => {
  it('rechaza observacion faltante con el metodo exacto antes de persistir', () => {
    assert.throws(
      () => buildSegmentedArqueoComputation({
        snapshot,
        payloadRows: [
          { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
          { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 },
          { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 5, observacion: '' }
        ],
        threshold: 0,
        requireObservacionOnDifference: true
      }),
      (error) => {
        assert.equal(error.httpStatus, 400);
        assert.equal(error.code, 'VENTAS_CAJAS_ARQUEO_OBSERVACION_REQUIRED');
        assert.equal(error.details.method, 'TRANSFERENCIA');
        assert.equal(error.details.metodo_pago_codigo, 'TRANSFERENCIA');
        assert.equal(error.details.field, 'observacion');
        assert.equal(error.details.focus_target, 'arqueos.TRANSFERENCIA.observacion');
        assert.equal(error.details.step, 'TRANSFERENCIA');
        assert.equal(error.details.accion_requerida, 'AGREGAR_OBSERVACION');
        assert.equal(
          error.publicMessage,
          'Existe diferencia en TRANSFERENCIA. Agrega una observación para continuar.'
        );
        return true;
      }
    );
  });

  it('no convierte una observacion faltante heredada en validacion STALE al cerrar', () => {
    const payloadRows = [
      { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
      { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 },
      { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 5, observacion: '' }
    ];
    const legacyComputation = buildSegmentedArqueoComputation({
      snapshot,
      payloadRows,
      threshold: 0,
      requireObservacionOnDifference: false
    });
    const fixture = {
      validation: {
        total_teorico: legacyComputation.monto_teorico_total,
        total_declarado: legacyComputation.monto_declarado_total,
        diferencia_total: legacyComputation.diferencia_total,
        hay_diferencia: true,
        payload_declarado_json: { arqueos: payloadRows, observacion_cierre: null },
        resultado_json: {
          resumen: {
            total_teorico: legacyComputation.monto_teorico_total,
            total_declarado: legacyComputation.monto_declarado_total,
            diferencia_total: legacyComputation.diferencia_total,
            hay_diferencia: true
          },
          metodos: legacyComputation.rows
        }
      },
      validationMethods: legacyComputation.rows
    };

    assert.throws(
      () => recomputeAndAssertCloseValidation({
        ...fixture,
        snapshot,
        threshold: 0
      }),
      (error) => error.httpStatus === 400
        && error.code === 'VENTAS_CAJAS_ARQUEO_OBSERVACION_REQUIRED'
        && error.details?.method === 'TRANSFERENCIA'
    );
  });

  it('no exige observacion en preview/validacion cuando se desactiva la regla', () => {
    const result = buildSegmentedArqueoComputation({
      snapshot,
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 9, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });

    const tarjeta = result.rows.find((row) => row.metodo_pago_codigo === 'TARJETA');
    assert.equal(tarjeta.requiere_revision, true);
    assert.equal(tarjeta.observacion_requerida, false);
  });

  it('exige exactamente EFECTIVO, TARJETA y TRANSFERENCIA como filas manuales', () => {
    const requiredCases = [
      [{ metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 }],
      [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 }
      ],
      [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
      ]
    ];
    for (const payloadRows of requiredCases) {
      assert.throws(
        () => buildSegmentedArqueoComputation({ snapshot, payloadRows, threshold: 0 }),
        (error) => error.httpStatus === 400 && error.code === 'VENTAS_CAJAS_ARQUEO_METODO_REQUIRED'
      );
    }

    assert.throws(
      () => buildSegmentedArqueoComputation({
        snapshot,
        payloadRows: [
          { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
          { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 },
          { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 },
          { metodo_pago_codigo: 'OTRO', monto_declarado: 0 }
        ],
        threshold: 0
      }),
      (error) => error.httpStatus === 400 && error.code === 'VENTAS_CAJAS_ARQUEO_METODO_INVALID'
    );

    for (const duplicateCode of ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']) {
      const payloadRows = [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 10, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 },
        { metodo_pago_codigo: duplicateCode, monto_declarado: 0 }
      ];
      assert.throws(
        () => buildSegmentedArqueoComputation({ snapshot, payloadRows, threshold: 0 }),
        (error) => error.httpStatus === 400 && error.code === 'VENTAS_CAJAS_ARQUEO_METODO_DUPLICATE'
      );
    }
  });

  it('reconstruye desde payload_declarado_json y rechaza manipulaciones coordinadas internamente consistentes', () => {
    const assertStale = (fixture) => assert.throws(
      () => recomputeAndAssertCloseValidation({
        ...fixture,
        snapshot,
        threshold: 0
      }),
      (error) => error.httpStatus === 409
        && error.code === 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
        && error.details?.motivo === 'VALIDATION_RECOMPUTATION_MISMATCH'
    );
    const mutations = [
      (fixture) => {
        const efectivo = fixture.validationMethods.find((row) => row.metodo_pago_codigo === 'EFECTIVO');
        efectivo.monto_declarado = 100;
        efectivo.diferencia = 100;
        efectivo.requiere_revision = true;
        fixture.validation.total_declarado = 110;
        fixture.validation.diferencia_total = 100;
        fixture.validation.hay_diferencia = true;
      },
      (fixture) => {
        const tarjeta = fixture.validationMethods.find((row) => row.metodo_pago_codigo === 'TARJETA');
        tarjeta.monto_declarado = 20;
        tarjeta.diferencia = 10;
        tarjeta.requiere_revision = true;
        tarjeta.cantidad_referencias = 2;
        fixture.validation.total_declarado = 20;
        fixture.validation.diferencia_total = 10;
        fixture.validation.hay_diferencia = true;
      },
      (fixture) => {
        const transferencia = fixture.validationMethods.find((row) => row.metodo_pago_codigo === 'TRANSFERENCIA');
        transferencia.monto_declarado = 5;
        transferencia.diferencia = 5;
        transferencia.requiere_revision = true;
        transferencia.observacion = 'Alterada coordinadamente';
        fixture.validation.total_declarado = 15;
        fixture.validation.diferencia_total = 5;
        fixture.validation.hay_diferencia = true;
      },
      (fixture) => {
        let declaredTotal = 0;
        for (const row of fixture.validationMethods) {
          row.monto_declarado += 10;
          row.diferencia = row.monto_declarado - row.monto_teorico;
          row.requiere_revision = row.diferencia !== 0;
          row.observacion = row.requiere_revision ? 'Alteracion completa' : null;
          declaredTotal += row.monto_declarado;
        }
        fixture.validation.total_declarado = declaredTotal;
        fixture.validation.diferencia_total = declaredTotal - fixture.validation.total_teorico;
        fixture.validation.hay_diferencia = true;
      }
    ];
    for (const mutate of mutations) {
      const fixture = buildStoredValidationFixture();
      mutate(fixture);
      assertStale(fixture);
    }
  });

  it('rechaza payload original alterado o invalido y acepta una validacion intacta', () => {
    const intact = buildStoredValidationFixture();
    assert.deepEqual(
      recomputeAndAssertCloseValidation({ ...intact, snapshot, threshold: 0 }).rows,
      intact.computation.rows
    );

    const altered = buildStoredValidationFixture();
    altered.validation.payload_declarado_json.arqueos[0].monto_declarado = 1;
    assert.throws(
      () => recomputeAndAssertCloseValidation({ ...altered, snapshot, threshold: 0 }),
      (error) => error.httpStatus === 400
        && error.code === 'VENTAS_CAJAS_ARQUEO_OBSERVACION_REQUIRED'
        && error.details?.method === 'EFECTIVO'
    );

    const invalidPayloads = [
      null,
      {},
      { arqueos: intact.validation.payload_declarado_json.arqueos.slice(0, 2) },
      { arqueos: [...intact.validation.payload_declarado_json.arqueos, clone(intact.validation.payload_declarado_json.arqueos[0])] },
      { arqueos: [...intact.validation.payload_declarado_json.arqueos.slice(0, 2), { metodo_pago_codigo: 'OTRO', monto_declarado: 0 }] },
      { arqueos: [...intact.validation.payload_declarado_json.arqueos.slice(0, 2), { metodo_pago_codigo: 'CRIPTO', monto_declarado: 0 }] }
    ];
    for (const payload of invalidPayloads) {
      const fixture = buildStoredValidationFixture();
      fixture.validation.payload_declarado_json = payload;
      assert.throws(
        () => recomputeAndAssertCloseValidation({ ...fixture, snapshot, threshold: 0 }),
        (error) => error.httpStatus === 409 && error.code === 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
    }
  });

  it('rechaza OTRO alterado coherentemente aunque encabezado y detalle sigan cuadrando', () => {
    const otherSnapshot = {
      ...snapshot,
      otrosNoEfectivo: {
        ventas_brutas: 40,
        reversiones: 0,
        ventas_netas: 40,
        metodos_agrupados: [{ codigo: 'OTRO', ventas_brutas: 40, reversiones: 0, ventas_netas: 40 }]
      }
    };
    const fixture = buildStoredValidationFixture({ sourceSnapshot: otherSnapshot });
    const otro = fixture.validationMethods.find((row) => row.metodo_pago_codigo === 'OTRO');
    otro.monto_declarado = 50;
    otro.diferencia = 10;
    otro.requiere_revision = true;
    fixture.validation.total_declarado += 10;
    fixture.validation.diferencia_total += 10;
    fixture.validation.hay_diferencia = true;
    assert.throws(
      () => recomputeAndAssertCloseValidation({ ...fixture, snapshot: otherSnapshot, threshold: 0 }),
      (error) => error.httpStatus === 409 && error.code === 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
    );
  });

  it('recalcula toda la aritmetica almacenada y rechaza cualquier manipulacion antes del cierre', () => {
    const validMethods = [
      { metodo_pago_codigo: 'EFECTIVO', monto_teorico: 100, monto_declarado: 90, diferencia: -10, requiere_revision: true },
      { metodo_pago_codigo: 'TARJETA', monto_teorico: 200, monto_declarado: 200, diferencia: 0, requiere_revision: false },
      { metodo_pago_codigo: 'TRANSFERENCIA', monto_teorico: 300, monto_declarado: 300, diferencia: 0, requiere_revision: false },
      { metodo_pago_codigo: 'OTRO', monto_teorico: 400, monto_declarado: 400, diferencia: 0, requiere_revision: false }
    ];
    const validHeader = {
      total_teorico: 1000,
      total_declarado: 990,
      diferencia_total: -10,
      hay_diferencia: true
    };
    assert.deepEqual(
      assertCloseValidationArithmeticIntegrity({ validation: validHeader, validationMethods: validMethods, threshold: 0 }),
      validHeader
    );

    const clone = (value) => JSON.parse(JSON.stringify(value));
    const manipulations = [
      ({ header, rows }) => { rows[0].monto_declarado = 91; },
      ({ header, rows }) => { rows[0].diferencia = -9; },
      ({ header }) => { header.total_declarado = 991; },
      ({ header }) => { header.diferencia_total = -9; },
      ({ rows }) => { rows[0].requiere_revision = false; },
      ({ header }) => { header.total_teorico = 999; },
      ({ rows }) => { rows[3].monto_declarado = 399; rows[3].diferencia = -1; rows[3].requiere_revision = true; }
    ];
    for (const mutate of manipulations) {
      const fixture = { header: clone(validHeader), rows: clone(validMethods) };
      mutate(fixture);
      assert.throws(
        () => assertCloseValidationArithmeticIntegrity({
          validation: fixture.header,
          validationMethods: fixture.rows,
          threshold: 0
        }),
        (error) => error.httpStatus === 409 && error.code === 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
    }
  });

  it('valida la regla automatica de OTRO cuando el teorico es negativo', () => {
    const methods = [
      { metodo_pago_codigo: 'EFECTIVO', monto_teorico: 0, monto_declarado: 0, diferencia: 0, requiere_revision: false },
      { metodo_pago_codigo: 'TARJETA', monto_teorico: 0, monto_declarado: 0, diferencia: 0, requiere_revision: false },
      { metodo_pago_codigo: 'TRANSFERENCIA', monto_teorico: 0, monto_declarado: 0, diferencia: 0, requiere_revision: false },
      { metodo_pago_codigo: 'OTRO', monto_teorico: -25, monto_declarado: 0, diferencia: 25, requiere_revision: true }
    ];
    const header = { total_teorico: -25, total_declarado: 0, diferencia_total: 25, hay_diferencia: true };
    assert.deepEqual(
      assertCloseValidationArithmeticIntegrity({ validation: header, validationMethods: methods, threshold: 100 }),
      header
    );
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
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 3000 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 0 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
      ],
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
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 2500, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
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

  it('rechaza catalogo duplicado y permite reutilizar el codigo stale en el cierre', () => {
    const duplicated = {
      ...VALID_CATALOG_VALIDATION,
      TARJETA: {
        ...VALID_CATALOG_VALIDATION.TARJETA,
        coincidencias: 2,
        valido: false,
        motivo: 'CODIGO_DUPLICADO'
      }
    };
    assert.throws(
      () => assertCoreCatalogValid(duplicated, {
        errorCode: 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE',
        publicMessage: 'Catalogo obsoleto.'
      }),
      (error) => {
        assert.equal(error.httpStatus, 409);
        assert.equal(error.code, 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
        assert.equal(error.details.codigo, 'TARJETA');
        assert.equal(error.details.coincidencias, 2);
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
