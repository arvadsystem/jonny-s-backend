import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSegmentedArqueoComputation,
  fingerprintValuesEqual
} from '../cajaCloseComputationService.js';

const snapshot = {
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

  it('compara ids bigint como cadenas canonicas', () => {
    assert.equal(fingerprintValuesEqual('max_id_factura_cobro', '9007199254740992', '9007199254740993'), false);
    assert.equal(fingerprintValuesEqual('max_id_reversion', '9223372036854775807', '9223372036854775807'), true);
    assert.equal(fingerprintValuesEqual('max_id_movimiento_caja', '001', '1'), true);
  });

  it('compara conteos como enteros y dinero con dos decimales', () => {
    assert.equal(fingerprintValuesEqual('cantidad_cobros', '2', 2), true);
    assert.equal(fingerprintValuesEqual('cantidad_movimientos', '2', 3), false);
    assert.equal(fingerprintValuesEqual('total_cobros', '10.004', '10.00'), true);
    assert.equal(fingerprintValuesEqual('total_teorico', '10.01', '10.02'), false);
  });
});
