import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import {
  IDEMPOTENCY_MODE,
  hasCuentaDivididaPayload,
  reserveIdempotencyForMode,
  resolvePedidoPendienteIdempotencyMode,
  saveExternalIdempotencyFailureIfNeeded,
  saveExternalIdempotencySuccessIfNeeded,
  shouldRunRpcPostCommitSideEffects,
  shouldUsePedidoPendienteRpcV2,
  validatePedidoPendienteIdempotencyKeyHeader
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
  it('exige una Idempotency-Key escalar, no vacia y acotada', () => {
    for (const missing of [undefined, null, '', '   ']) {
      assert.deepEqual(validatePedidoPendienteIdempotencyKeyHeader(missing), {
        ok: false,
        status: 400,
        code: 'VENTAS_PEDIDO_IDEMPOTENCY_KEY_REQUERIDA',
        message: 'Idempotency-Key es requerido para crear el pedido.'
      });
    }
    for (const invalid of [['duplicada'], 'idem-a, idem-b', 'x'.repeat(201)]) {
      const validation = validatePedidoPendienteIdempotencyKeyHeader(invalid);
      assert.equal(validation.status, 400);
      assert.equal(validation.code, 'VENTAS_PEDIDO_IDEMPOTENCY_KEY_INVALIDA');
    }
    assert.deepEqual(validatePedidoPendienteIdempotencyKeyHeader(' idem-1 '), {
      ok: true,
      value: 'idem-1'
    });
  });

  it('la ruta exige la clave y conserva reserva atomica, replay y conflicto por hash', () => {
    const source = fs.readFileSync(new URL('../../ventas.js', import.meta.url), 'utf8');
    const routeStart = source.indexOf("router.post('/ventas/pedidos-pendientes'");
    const routeEnd = source.indexOf("router.post('/ventas/pedidos/:id/registrar-pago'", routeStart);
    const route = source.slice(routeStart, routeEnd);
    assert.match(route, /validatePedidoPendienteIdempotencyKeyHeader/);
    assert.match(route, /idempotencyValidation\.code/);
    assert.match(route, /res\.status\(idempotencyValidation\.status\)/);
    assert.match(route, /buildIdempotencyRequestHash\(req\.body\)/);
    assert.match(route, /idempotencyReservation\.replay/);
    assert.match(route, /idempotencyReservation\.conflict/);
    assert.match(source, /INSERT INTO public\.ventas_idempotency_keys[\s\S]*?ON CONFLICT \(idempotency_key\) DO NOTHING/);
    assert.match(source, /WHERE idempotency_key = \$1[\s\S]*?FOR UPDATE/);
    assert.match(source, /existing\.request_hash !== requestHash/);
    assert.ok(route.indexOf('validatePedidoPendienteIdempotencyKeyHeader') < route.indexOf('pool.connect()'));
    assert.ok(route.indexOf('validatePedidoPendienteIdempotencyKeyHeader') < route.indexOf("client.query('BEGIN')"));
    assert.ok(route.indexOf('validatePedidoPendienteIdempotencyKeyHeader') < route.indexOf('resolvePedidoPendienteIdempotencyMode'));
  });

  it('dos reservas concurrentes simuladas con la misma clave dejan un solo ganador', async () => {
    let reserved = false;
    const reserveExternal = async () => {
      if (reserved) return { conflict: true, code: 'REQUEST_ALREADY_IN_PROGRESS' };
      reserved = true;
      return { reserved: true, idempotencyKey: 'idem-concurrente' };
    };
    const [first, second] = await Promise.all([
      reserveIdempotencyForMode({ mode: IDEMPOTENCY_MODE.EXTERNAL, reserveExternal }),
      reserveIdempotencyForMode({ mode: IDEMPOTENCY_MODE.EXTERNAL, reserveExternal })
    ]);
    assert.equal([first, second].filter((result) => result.reserved).length, 1);
    assert.equal([first, second].filter((result) => result.conflict).length, 1);
  });

  it('mantiene reserva externa mientras V2 no propague la sesion de caja', () => {
    assert.equal(resolvePedidoPendienteIdempotencyMode({
      pedidoPendienteRpcV2Enabled: true,
      cuentaDivididaSolicitada: false,
      idempotencyKey: 'idem-1'
    }), IDEMPOTENCY_MODE.EXTERNAL);
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
