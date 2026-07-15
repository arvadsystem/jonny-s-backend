import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapVentasRpcError } from '../services/ventasRpcExecutionService.js';

const cases = [
  ['POS_RPC_PAYLOAD_INVALIDO', 400, 'La solicitud de venta contiene datos invalidos.'],
  ['POS_RPC_ACTOR_SCOPE_MISMATCH', 403, 'No tienes autorizacion para completar esta operacion.'],
  ['POS_RPC_IDEMPOTENCY_CONFLICT', 409, 'No se pudo completar la operacion por una inconsistencia de inventario o configuracion.'],
  ['POS_RPC_STOCK_INSUFICIENTE', 409, 'No se pudo completar la operacion por una inconsistencia de inventario o configuracion.'],
  ['POS_RPC_SALSA_SNAPSHOT_INVALIDO', 409, 'No se pudo completar la operacion por una inconsistencia de inventario o configuracion.'],
  ['POS_RPC_EXTRA_NO_PERMITIDO', 409, 'No se pudo completar la operacion por una inconsistencia de inventario o configuracion.'],
  ['POS_RPC_RECETA_CONSUMO_INCONSISTENTE', 409, 'No se pudo completar la operacion por una inconsistencia de inventario o configuracion.'],
  ['POS_RPC_RESPUESTA_BASE_INVALIDA', 500, 'No se pudo completar la venta por RPC.'],
  ['POS_RPC_IDEMPOTENCY_FINALIZACION_FALLO', 500, 'No se pudo completar la venta por RPC.'],
  ['POS_RPC_DESCONOCIDO_NUEVO', 500, 'No se pudo completar la venta por RPC.']
];

describe('mapVentasRpcError', () => {
  for (const [code, status, publicMessage] of cases) {
    it(`${code} -> ${status}`, () => {
      const mapped = mapVentasRpcError({
        message: `${code}: detalle interno tabla public.secreta`,
        stack: 'stack interno'
      });
      assert.equal(mapped.httpStatus, status);
      assert.equal(mapped.code, code);
      assert.equal(mapped.publicMessage, publicMessage);
      assert.doesNotMatch(mapped.publicMessage, /tabla|stack|detalle interno|public\./i);
    });
  }

  it('extrae codigo desde mensaje con espacio', () => {
    const mapped = mapVentasRpcError({ message: 'POS_RPC_STOCK_INSUFICIENTE detalle adicional' });
    assert.equal(mapped.code, 'POS_RPC_STOCK_INSUFICIENTE');
    assert.equal(mapped.httpStatus, 409);
  });

  it('extrae codigo desde mensaje con dos puntos', () => {
    const mapped = mapVentasRpcError({ message: 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO:line-1' });
    assert.equal(mapped.code, 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO');
    assert.equal(mapped.httpStatus, 409);
  });

  it('no convierte errores PostgreSQL sin POS_RPC en codigo publico', () => {
    const mapped = mapVentasRpcError({ code: '23505', message: 'duplicate key value violates unique constraint' });
    assert.equal(mapped.httpStatus, 500);
    assert.equal(mapped.code, 'POS_RPC_ERROR');
    assert.equal(mapped.publicMessage, 'No se pudo completar la venta por RPC.');
  });
});
