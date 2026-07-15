import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeVentasRpc } from '../services/ventasRpcExecutionService.js';
import {
  buildRpcManagedIdempotencyReservation,
  saveExternalIdempotencyFailureIfNeeded,
  saveExternalIdempotencySuccessIfNeeded
} from '../services/ventasRpcRoutingService.js';

const createPerf = () => ({
  added: [],
  now: () => 1,
  add(name) { this.added.push(name); }
});

describe('ventas RPC execution flow', () => {
  it('venta V3 falla con rollback conceptual sin fallback ni idempotencia externa', async () => {
    const calls = { rpc: 0, rollback: 0, legacy: 0, v2: 0, v1: 0, inventory: 0, failure: 0 };
    const reservation = buildRpcManagedIdempotencyReservation('idem-1');
    const client = {
      async query() {
        calls.rpc += 1;
        throw new Error('POS_RPC_STOCK_INSUFICIENTE detalle interno');
      }
    };
    await assert.rejects(
      executeVentasRpc({
        client,
        sql: 'SELECT public.registrar_venta_pos_v3($1::jsonb, $2::jsonb) AS response',
        payload: {},
        actor: {},
        perf: createPerf(),
        callMetric: 'rpc_v3_call_ms',
        expectedVersion: 'v3',
        invalidCode: 'VENTAS_RPC_V3_RESPONSE_INVALID'
      }),
      (error) => {
        calls.rollback += 1;
        assert.equal(error.httpStatus, 409);
        assert.equal(error.code, 'POS_RPC_STOCK_INSUFICIENTE');
        return true;
      }
    );
    await saveExternalIdempotencyFailureIfNeeded({
      reservation,
      saveFailure: async () => { calls.failure += 1; }
    });
    assert.equal(calls.rpc, 1);
    assert.equal(calls.rollback, 1);
    assert.equal(calls.legacy + calls.v2 + calls.v1, 0);
    assert.equal(calls.inventory, 0);
    assert.equal(calls.failure, 0);
  });

  it('pedido pendiente V2 falla sin fallback legacy ni idempotencia externa', async () => {
    const calls = { rpc: 0, rollback: 0, legacy: 0, inventory: 0, failure: 0 };
    const reservation = buildRpcManagedIdempotencyReservation('idem-1');
    const client = {
      async query() {
        calls.rpc += 1;
        throw new Error('POS_RPC_EXTRA_NO_PERMITIDO:line-0');
      }
    };
    await assert.rejects(
      executeVentasRpc({
        client,
        sql: 'SELECT public.registrar_pedido_pendiente_pos_v2($1::jsonb, $2::jsonb) AS response',
        payload: {},
        actor: {},
        perf: createPerf(),
        callMetric: 'pedido_pendiente_rpc_v2_call_ms',
        expectedVersion: 'v2',
        invalidCode: 'PEDIDO_PENDIENTE_RPC_V2_RESPONSE_INVALID'
      }),
      (error) => {
        calls.rollback += 1;
        assert.equal(error.httpStatus, 409);
        assert.equal(error.code, 'POS_RPC_EXTRA_NO_PERMITIDO');
        return true;
      }
    );
    await saveExternalIdempotencyFailureIfNeeded({
      reservation,
      saveFailure: async () => { calls.failure += 1; }
    });
    assert.equal(calls.rpc, 1);
    assert.equal(calls.rollback, 1);
    assert.equal(calls.legacy, 0);
    assert.equal(calls.inventory, 0);
    assert.equal(calls.failure, 0);
  });

  it('respuesta V3 conserva contrato minimo esperado', async () => {
    const response = {
      message: 'Venta creada exitosamente.',
      id_pedido: 10,
      id_factura: 20,
      codigo_venta: 'VTA-1',
      total: 125,
      ticket_ready: true,
      facturacion_snapshot: { cai: 'x' },
      inventario: { movimientos_generados: 3 },
      rpc_version: 'v3',
      idempotent_replay: false,
      fidelizacion: null
    };
    const result = await executeVentasRpc({
      client: { async query() { return { rows: [{ response }] }; } },
      sql: 'SELECT public.registrar_venta_pos_v3($1::jsonb, $2::jsonb) AS response',
      payload: {},
      actor: {},
      perf: createPerf(),
      callMetric: 'rpc_v3_call_ms',
      expectedVersion: 'v3',
      invalidCode: 'VENTAS_RPC_V3_RESPONSE_INVALID'
    });
    for (const key of ['id_pedido', 'id_factura', 'codigo_venta', 'total', 'inventario', 'rpc_version', 'idempotent_replay', 'fidelizacion']) {
      assert.ok(Object.hasOwn(result, key), `falta ${key}`);
    }
    assert.equal(result.ticket_ready, true);
    assert.ok(result.facturacion_snapshot);
  });

  it('respuesta pendiente V2 conserva contrato minimo esperado y no guarda success externo en replay', async () => {
    const calls = { success: 0 };
    const response = {
      message: 'Pedido pendiente creado correctamente.',
      id_pedido: 30,
      estado_pago: 'PENDIENTE_PAGO',
      estado_pedido: 'EN_COCINA',
      origen_pedido: 'CAJA',
      canal: 'LOCAL',
      modalidad: 'CONSUMO_LOCAL',
      total: 75,
      monto_pendiente: 75,
      inventario: { movimientos_generados: 1 },
      rpc_version: 'v2',
      idempotent_replay: true
    };
    const result = await executeVentasRpc({
      client: { async query() { return { rows: [{ response }] }; } },
      sql: 'SELECT public.registrar_pedido_pendiente_pos_v2($1::jsonb, $2::jsonb) AS response',
      payload: {},
      actor: {},
      perf: createPerf(),
      callMetric: 'pedido_pendiente_rpc_v2_call_ms',
      expectedVersion: 'v2',
      invalidCode: 'PEDIDO_PENDIENTE_RPC_V2_RESPONSE_INVALID'
    });
    await saveExternalIdempotencySuccessIfNeeded({
      reservation: buildRpcManagedIdempotencyReservation('idem-1'),
      saveSuccess: async () => { calls.success += 1; }
    });
    for (const key of ['message', 'id_pedido', 'estado_pago', 'estado_pedido', 'origen_pedido', 'canal', 'modalidad', 'total', 'monto_pendiente', 'inventario', 'rpc_version', 'idempotent_replay']) {
      assert.ok(Object.hasOwn(result, key), `falta ${key}`);
    }
    assert.equal(calls.success, 0);
  });
});
