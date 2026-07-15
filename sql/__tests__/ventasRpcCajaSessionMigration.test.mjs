import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve('sql/2026-06-24_harden_ventas_rpc_caja_session.sql'), 'utf8');

describe('ventas RPC caja session hardening migration', () => {
  it('protege writes directos con advisory lock, estado abierto y participante activo', () => {
    assert.match(migration, /pg_advisory_xact_lock\(8152028/);
    assert.match(migration, /VENTAS_CAJA_SESSION_CLOSED/);
    assert.match(migration, /cajas_sesiones_participantes/);
    assert.match(migration, /trg_ventas_facturas_assert_caja_session_open/);
    assert.match(migration, /trg_ventas_facturas_cobros_assert_caja_session_open/);
  });

  it('mantiene grants explicitos sin exponer las RPC a PUBLIC', () => {
    assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.registrar_venta_pos_v1\(jsonb, jsonb\) FROM PUBLIC/);
    assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.registrar_venta_pos_v2\(jsonb, jsonb\) FROM PUBLIC/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.registrar_venta_pos_v1\(jsonb, jsonb\) TO authenticated/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.registrar_venta_pos_v2\(jsonb, jsonb\) TO service_role/);
  });
});
