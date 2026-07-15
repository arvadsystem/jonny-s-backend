import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IDEMPOTENCY_MODE,
  hasCuentaDivididaPayload,
  reserveIdempotencyForMode,
  resolvePedidoPendienteIdempotencyMode,
  saveExternalIdempotencyFailureIfNeeded,
  saveExternalIdempotencySuccessIfNeeded,
  shouldRunRpcPostCommitSideEffects,
  shouldUsePedidoPendienteRpcV2
} from '../services/ventasRpcRoutingService.js';

const createCalls = () => ({
  reserve: 0,
  success: 0,
  failure: 0,
  rpcV2: 0,
  legacy: 0,
  inventory: 0,
  rollback: 0,
  commit: 0
});

describe('pedido pendiente RPC idempotency selection', () => {
  it('selecciona rpc-managed solo para V2 sin cuenta dividida', () => {
    assert.equal(resolvePedidoPendienteIdempotencyMode({
      pedidoPendienteRpcV2Enabled: true,
      cuentaDivididaSolicitada: false,
      idempotencyKey: 'idem-1'
    }), IDEMPOTENCY_MODE.RPC);
  });

  it('selecciona externa para V2 con cuenta dividida', () => {
    assert.equal(resolvePedidoPendienteIdempotencyMode({
      pedidoPendienteRpcV2Enabled: true,
      cuentaDivididaSolicitada: true,
      idempotencyKey: 'idem-1'
    }), IDEMPOTENCY_MODE.EXTERNAL);
  });

  it('selecciona externa para V1 y legacy', () => {
    assert.equal(resolvePedidoPendienteIdempotencyMode({
      pedidoPendienteRpcV2Enabled: false,
      cuentaDivididaSolicitada: false,
      idempotencyKey: 'idem-1'
    }), IDEMPOTENCY_MODE.EXTERNAL);
  });

  it('estructura invalida pero detectable de cuenta dividida usa externa', () => {
    const body = { cuenta_dividida: [] };
    assert.equal(hasCuentaDivididaPayload(body), true);
    assert.equal(resolvePedidoPendienteIdempotencyMode({
      pedidoPendienteRpcV2Enabled: true,
      cuentaDivididaSolicitada: hasCuentaDivididaPayload(body),
      idempotencyKey: 'idem-1'
    }), IDEMPOTENCY_MODE.EXTERNAL);
  });

  it('cuenta dividida con V2 activa conserva reserva, replay, conflicto y success externos', async () => {
    const calls = createCalls();
    const reservation = await reserveIdempotencyForMode({
      mode: IDEMPOTENCY_MODE.EXTERNAL,
      idempotencyKey: 'idem-1',
      reserveExternal: async () => {
        calls.reserve += 1;
        return { reserved: true, idempotencyKey: 'idem-1' };
      }
    });
    await saveExternalIdempotencySuccessIfNeeded({
      reservation,
      saveSuccess: async () => { calls.success += 1; }
    });
    calls.legacy += 1;
    assert.equal(calls.reserve, 1);
    assert.equal(calls.success, 1);
    assert.equal(calls.rpcV2, 0);
    assert.equal(calls.legacy, 1);

    const replay = await reserveIdempotencyForMode({
      mode: IDEMPOTENCY_MODE.EXTERNAL,
      idempotencyKey: 'idem-1',
      reserveExternal: async () => ({ replay: true, responseBody: { id_pedido: 10 }, httpStatus: 201 })
    });
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.responseBody, { id_pedido: 10 });

    const conflict = await reserveIdempotencyForMode({
      mode: IDEMPOTENCY_MODE.EXTERNAL,
      idempotencyKey: 'idem-1',
      reserveExternal: async () => ({ conflict: true, code: 'IDEMPOTENCY_KEY_REUSED' })
    });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('cuenta dividida con error antes de COMMIT marca FAILED externo y no llama RPC V2', async () => {
    const calls = createCalls();
    const reservation = { reserved: true, idempotencyKey: 'idem-1' };
    calls.rollback += 1;
    await saveExternalIdempotencyFailureIfNeeded({
      reservation,
      saveFailure: async () => { calls.failure += 1; }
    });
    assert.equal(calls.failure, 1);
    assert.equal(calls.rollback, 1);
    assert.equal(calls.rpcV2, 0);
  });

  it('pedido normal V2 no usa idempotencia externa ni fallback legacy', async () => {
    const calls = createCalls();
    const reservation = await reserveIdempotencyForMode({
      mode: IDEMPOTENCY_MODE.RPC,
      idempotencyKey: 'idem-1',
      reserveExternal: async () => { calls.reserve += 1; }
    });
    assert.equal(reservation.rpcManaged, true);
    assert.equal(calls.reserve, 0);
    assert.equal(shouldUsePedidoPendienteRpcV2({
      pedidoPendienteRpcV2Enabled: true,
      cuentaDivisionPlan: null,
      pedidoLines: [{ item_index: 0 }]
    }), true);
    calls.rpcV2 += 1;
    calls.rollback += 1;
    await saveExternalIdempotencyFailureIfNeeded({
      reservation,
      saveFailure: async () => { calls.failure += 1; }
    });
    await saveExternalIdempotencySuccessIfNeeded({
      reservation,
      saveSuccess: async () => { calls.success += 1; }
    });
    assert.equal(calls.rpcV2, 1);
    assert.equal(calls.reserve, 0);
    assert.equal(calls.success, 0);
    assert.equal(calls.failure, 0);
    assert.equal(calls.legacy, 0);
    assert.equal(calls.inventory, 0);
    assert.equal(calls.rollback, 1);
  });

  it('replay RPC no habilita efectos secundarios post-commit', () => {
    assert.equal(shouldRunRpcPostCommitSideEffects({ idempotent_replay: true }), false);
    assert.equal(shouldRunRpcPostCommitSideEffects({ idempotent_replay: false }), true);
  });
});
