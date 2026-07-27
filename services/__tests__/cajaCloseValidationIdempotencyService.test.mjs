import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCloseValidationArtifacts,
  isReusableCloseValidation,
  normalizeCloseValidationPayload
} from '../cajaCloseValidationIdempotencyService.js';

const computation = {
  monto_teorico_total: 600,
  monto_declarado_total: 600,
  diferencia_total: 0,
  rows: [
    {
      id_metodo_pago: 1,
      metodo_pago_codigo: 'EFECTIVO',
      monto_teorico: 100,
      monto_declarado: 100,
      diferencia: 0,
      cantidad_referencias: null,
      observacion: null,
      resultado: 'CUADRADO',
      requiere_revision: false,
      observacion_requerida: false,
      observacion_presente: false,
      completado_automaticamente: false
    },
    {
      id_metodo_pago: 2,
      metodo_pago_codigo: 'TARJETA',
      monto_teorico: 200,
      monto_declarado: 200,
      diferencia: 0,
      cantidad_referencias: 2,
      observacion: null,
      resultado: 'CUADRADO',
      requiere_revision: false,
      observacion_requerida: false,
      observacion_presente: false,
      completado_automaticamente: false
    },
    {
      id_metodo_pago: 3,
      metodo_pago_codigo: 'TRANSFERENCIA',
      monto_teorico: 300,
      monto_declarado: 300,
      diferencia: 0,
      cantidad_referencias: 3,
      observacion: 'Atlantida',
      resultado: 'CUADRADO',
      requiere_revision: false,
      observacion_requerida: false,
      observacion_presente: true,
      completado_automaticamente: false
    }
  ]
};
const fingerprint = {
  cantidad_cobros: 3,
  max_id_factura_cobro: '9007199254740993',
  total_cobros: 600,
  cantidad_movimientos: 0,
  max_id_movimiento_caja: '0',
  total_teorico: 600,
  catalogo_efectivo: '1:1:1:1',
  catalogo_tarjeta: '1:2:1:0',
  catalogo_transferencia: '1:3:1:0'
};

const buildFixture = () => {
  const artifacts = buildCloseValidationArtifacts({
    computation,
    observacionCierre: '  Cierre   normal  ',
    operationalFingerprint: fingerprint
  });
  const candidate = {
    id_validacion_cierre: '77',
    id_sesion_caja: '14',
    id_usuario_valida: 5,
    id_cierre_caja: null,
    numero_intento: 21,
    hay_diferencia: false,
    payload_declarado_json: {
      observacion_cierre: 'Cierre normal',
      arqueos: JSON.parse(JSON.stringify([...artifacts.payloadDeclarado.arqueos].reverse()))
    },
    resultado_json: JSON.parse(JSON.stringify(artifacts.resultado)),
    metodos_persistidos_json: JSON.parse(JSON.stringify([...artifacts.persistedMethods].reverse()))
  };
  return { artifacts, candidate };
};

describe('caja close validation idempotency', () => {
  it('normaliza orden, espacios, montos y observaciones del payload declarado', () => {
    assert.deepEqual(
      normalizeCloseValidationPayload({
        observacion_cierre: '  Cierre   normal ',
        arqueos: [
          { metodo_pago_codigo: ' transferencia ', monto_declarado: '300.000', cantidad_referencias: '3', observacion: ' Atlantida ' },
          { metodo_pago_codigo: 'efectivo', monto_declarado: '100' },
          { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 2 }
        ]
      }),
      {
        arqueos: [
          { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 100, cantidad_referencias: null, observacion: null },
          { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 2, observacion: null },
          { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 3, observacion: 'Atlantida' }
        ],
        observacion_cierre: 'Cierre normal'
      }
    );
  });

  it('reutiliza la ultima validacion abierta cuando payload, huella, resumen, metodos, usuario y sesion coinciden', () => {
    const { artifacts, candidate } = buildFixture();
    assert.equal(
      isReusableCloseValidation({
        candidate,
        idSesionCaja: '14',
        idUsuarioValida: 5,
        ...artifacts
      }),
      true
    );
  });

  it('crea un nuevo intento cuando cambia payload, huella, usuario, sesion o vinculo de cierre', () => {
    const mutations = [
      ['payload', ({ candidate }) => { candidate.payload_declarado_json.arqueos[0].monto_declarado = 301; }],
      ['huella', ({ candidate }) => { candidate.resultado_json.huella_operacional.total_cobros = 601; }],
      ['usuario', ({ candidate }) => { candidate.id_usuario_valida = 6; }],
      ['sesion', ({ options }) => { options.idSesionCaja = '15'; }],
      ['vinculo', ({ candidate }) => { candidate.id_cierre_caja = '99'; }],
      ['metodos', ({ candidate }) => { candidate.metodos_persistidos_json[0].observacion = 'Otra'; }]
    ];

    for (const [label, mutate] of mutations) {
      const { artifacts, candidate } = buildFixture();
      const options = {
        candidate,
        idSesionCaja: '14',
        idUsuarioValida: 5,
        ...artifacts
      };
      mutate({ candidate, options });
      assert.equal(isReusableCloseValidation(options), false, label);
    }
  });
});
