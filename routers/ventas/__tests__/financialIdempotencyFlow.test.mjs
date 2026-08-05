import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  IDEMPOTENCY_MODE,
  resolvePedidoPendienteIdempotencyMode,
  resolveVentaIdempotencyMode,
  validatePedidoPendienteIdempotencyKeyHeader
} from '../services/ventasRpcRoutingService.js';

const source = readFileSync(resolve('routers/ventas.js'), 'utf8');
const paymentStart = source.indexOf("router.post('/ventas/pedidos/:id/registrar-pago'");
const paymentEnd = source.indexOf("router.post('/ventas'", paymentStart);
const payment = source.slice(paymentStart, paymentEnd);
const recoveryStart = source.indexOf("router.get('/ventas/idempotency-result'");
const recovery = source.slice(recoveryStart, paymentStart);
const pendingStart = source.indexOf("router.post('/ventas/pedidos-pendientes'");
const pending = source.slice(pendingStart, recoveryStart);
const directStart = source.indexOf("router.post('/ventas'", paymentEnd);
const direct = source.slice(directStart);

class Ledger {
  constructor() { this.rows = new Map(); this.effects = []; }
  reserve(key, hash, scope) {
    const existing = this.rows.get(key);
    if (!existing) { this.rows.set(key, { key, hash, scope, status: 'IN_PROGRESS' }); return 'NEW'; }
    if (existing.hash !== hash || JSON.stringify(existing.scope) !== JSON.stringify(scope)) return 'CONFLICT';
    return existing.status === 'SUCCESS' ? 'REPLAY' : 'IN_PROGRESS';
  }
  commit(key, response, effects) { this.effects.push(...effects); Object.assign(this.rows.get(key), { status: 'SUCCESS', response }); }
  rollback(key) { this.rows.delete(key); }
}

describe('idempotencia financiera backend', () => {
  for (const value of [undefined, '', '   ', ['a', 'b'], 'a,b', 'x'.repeat(201)]) {
    it(`header invalido se rechaza antes del pool: ${Array.isArray(value) ? 'multiple' : String(value).slice(0, 8)}`, () => {
      assert.equal(validatePedidoPendienteIdempotencyKeyHeader(value).ok, false);
      assert.ok(payment.indexOf('idempotencyValidation') < payment.indexOf('pool.connect()'));
    });
  }
  it('header valido reserva sesion, usuario, sucursal y pedido', () => {
    assert.equal(validatePedidoPendienteIdempotencyKeyHeader('key-A').ok, true);
    assert.match(payment, /reserveVentasIdempotencyKey\([\s\S]*idSesionCaja: requestedSessionId[\s\S]*idPedido/);
  });
  it('sesion se valida antes de BEGIN y se revalida bajo lock', () => {
    assert.ok(payment.indexOf('resolveCajaSession({') < payment.indexOf("client.query('BEGIN')"));
    assert.match(payment, /lockCajaFinancialSession[\s\S]*validateCajaSessionOpenForFinancialWrite/);
  });
  it('misma key y hash produce replay', () => {
    const l = new Ledger(); const s = { user: 1, branch: 2, session: 3 };
    assert.equal(l.reserve('A', 'H', s), 'NEW'); l.commit('A', { id_factura: 9 }, ['F9']);
    assert.equal(l.reserve('A', 'H', s), 'REPLAY'); assert.deepEqual(l.effects, ['F9']);
  });
  it('misma key con hash o scope distinto produce conflicto', () => {
    const l = new Ledger(); l.reserve('A', 'H', { session: 3 });
    assert.equal(l.reserve('A', 'X', { session: 3 }), 'CONFLICT');
    assert.equal(l.reserve('A', 'H', { session: 4 }), 'CONFLICT');
  });
  it('reserva concurrente deja un ganador', async () => {
    const l = new Ledger(); const results = await Promise.all([1, 2].map(async () => l.reserve('A', 'H', { session: 3 })));
    assert.deepEqual(results.sort(), ['IN_PROGRESS', 'NEW']);
  });
  for (const label of ['pago completo', 'pago parcial', 'division']) {
    it(`${label} reintentado devuelve la misma factura sin otro efecto`, () => {
      const l = new Ledger(); const scope = { user: 1, branch: 2, session: 3 };
      l.reserve('A', label, scope); l.commit('A', { id_factura: 10 }, [`factura:${label}`, `cobro:${label}`]);
      assert.equal(l.reserve('A', label, scope), 'REPLAY'); assert.equal(l.effects.length, 2);
    });
  }
  for (const effect of ['factura', 'cobro', 'caja', 'inventario']) {
    it(`rollback no deja ${effect}`, () => {
      const l = new Ledger(); l.reserve('A', 'H', { session: 3 }); l.rollback('A');
      assert.equal(l.effects.includes(effect), false); assert.equal(l.rows.has('A'), false);
    });
  }
  it('SUCCESS se guarda antes de COMMIT', () => {
    assert.ok(payment.indexOf('await saveVentasIdempotencySuccess({') < payment.indexOf("await client.query('COMMIT')"));
  });
  it('recuperacion compara usuario, sucursal y sesion', () => {
    assert.match(recovery, /vik\.id_usuario = \$2[\s\S]*vik\.id_sucursal = \$3[\s\S]*COALESCE\(vik\.id_sesion_caja, f\.id_sesion_caja\) = \$4/);
  });
  it('otra operacion produce conflicto y otro scope no revela existencia', () => {
    assert.match(recovery, /if \(!row\).*NOT_FOUND/);
    assert.match(recovery, /row\.operation !== operation.*CONFLICT/);
  });
  it('historico NULL solo se recupera por factura', () => assert.match(recovery, /LEFT JOIN public\.facturas f[\s\S]*COALESCE\(vik\.id_sesion_caja, f\.id_sesion_caja\)/));
  it('respuesta de recuperacion usa allowlist sin payload original', () => {
    assert.doesNotMatch(recovery, /SELECT vik\.\*/);
    assert.doesNotMatch(recovery, /request_hash/);
  });
  it('recuperacion impide cachear SUCCESS y NOT_FOUND', () => {
    assert.match(recovery, /res\.set\('Cache-Control', 'private, no-store'\)/);
    assert.ok(recovery.indexOf("res.set('Cache-Control'") < recovery.indexOf('validatePedidoPendienteIdempotencyKeyHeader'));
  });
  it('pedido pendiente conserva su ruta e idempotencia obligatoria', () => {
    assert.match(source, /router\.post\('\/ventas\/pedidos-pendientes'[\s\S]*validatePedidoPendienteIdempotencyKeyHeader/);
  });
  it('pedido pendiente de Caja resuelve sesion antes de reservar y la conserva en SUCCESS', () => {
    assert.ok(pending.indexOf('buildPedidoPendientePayload({') < pending.indexOf('reserveIdempotencyForMode({'));
    assert.match(pending, /reserveArgs:[\s\S]*idSesionCaja: pedidoPendiente\.id_sesion_caja/);
    assert.match(pending, /saveExternalIdempotencySuccessIfNeeded\([\s\S]*idSesionCaja: pedidoPendiente\.id_sesion_caja/);
  });
  it('RPC sin contrato de sesion queda fuera de la idempotencia financiera', () => {
    assert.equal(resolveVentaIdempotencyMode({ ventasRpcV3Enabled: true, idempotencyKey: 'A' }), IDEMPOTENCY_MODE.EXTERNAL);
    assert.equal(resolvePedidoPendienteIdempotencyMode({ pedidoPendienteRpcV2Enabled: true, idempotencyKey: 'B' }), IDEMPOTENCY_MODE.EXTERNAL);
  });
  it('recuperacion incluye la creacion de pedido pendiente y exige la misma sesion', () => {
    assert.match(recovery, /'POST \/ventas\/pedidos-pendientes'/);
    assert.match(recovery, /COALESCE\(vik\.id_sesion_caja, f\.id_sesion_caja\) = \$4/);
  });
  it('venta directa exige key y persiste sesion antes de COMMIT', () => {
    assert.ok(direct.indexOf('ventaIdempotencyValidation') < direct.indexOf('pool.connect()'));
    assert.ok(direct.indexOf('validateCajaSessionOpenForFinancialWrite({') < direct.indexOf('reserveIdempotencyForMode({'));
    assert.match(direct, /idSesionCaja: venta\.id_sesion_caja[\s\S]*client\.query\('COMMIT'\)/);
  });
  it('observabilidad no imprime key ni payload en la nueva recuperacion', () => {
    assert.doesNotMatch(recovery, /console\.(?:log|error)\([^\n]*validation\.value/);
    assert.doesNotMatch(recovery, /console\.(?:log|error)\([^\n]*req\.body/);
  });
});
