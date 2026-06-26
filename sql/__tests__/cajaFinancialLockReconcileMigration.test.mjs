import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve('sql/2026-06-26_reconcile_caja_financial_lock.sql'), 'utf8');

describe('caja financial lock reconcile migration', () => {
  it('reproduce el lock financiero esperado de QA', () => {
    assert.match(migration, /BEGIN;/);
    assert.match(migration, /COMMIT;/);
    assert.match(migration, /SELECT ~p_id_sesion_caja/);
    assert.match(migration, /8152028/);
    assert.match(migration, /clock_timestamp/);
    assert.match(migration, /pg_sleep\(0\.025\)/);
    assert.match(migration, /pg_try_advisory_xact_lock/);
    assert.match(migration, /SET search_path = pg_catalog, public/);
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.fn_ventas_lock_caja_financial_session\(bigint, integer\) FROM anon/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.registrar_venta_pos_v1\(jsonb, jsonb\) TO authenticated/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.registrar_venta_pos_v2\(jsonb, jsonb\) TO service_role/);
  });

  it('no usa la estrategia incompleta anterior', () => {
    assert.doesNotMatch(migration, /SELECT p_id_sesion_caja;/);
    assert.doesNotMatch(migration, /set_config\('lock_timeout'\)/);
    assert.match(migration, /LOOP[\s\S]*pg_try_advisory_xact_lock[\s\S]*clock_timestamp/);
  });
});
