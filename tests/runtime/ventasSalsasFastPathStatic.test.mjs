import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('ventas salsas fast path static contract', () => {
  it('no desactiva RPC por salsas y usa funciones versionadas cuando existen', async () => {
    const source = await readFile(new URL('../../routers/ventas.js', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /legacy_salsas_inventario/);
    assert.doesNotMatch(source, /rpc_skip_reason\s*=\s*['"]salsas_inventario['"]/);
    assert.match(source, /registrar_venta_pos_v3\(jsonb,jsonb\)/);
    assert.match(source, /registrar_pedido_pendiente_pos_v2\(jsonb,jsonb\)/);
    assert.match(source, /rpc_v3_missing/);
    assert.match(source, /rpc_v2_missing/);
  });

  it('hidrata inventario de recetas una sola vez en POST ventas', async () => {
    const source = await readFile(new URL('../../routers/ventas.js', import.meta.url), 'utf8');
    const routeStart = source.indexOf("router.post('/ventas',");
    assert.notEqual(routeStart, -1);
    const routeSource = source.slice(routeStart);
    const hydrateCalls = routeSource.match(/attachRecipeInventorySnapshotsToLines/g) || [];

    assert.equal(hydrateCalls.length, 1);
    assert.match(routeSource, /venta\.pedido_lines = venta\.all_lines/);
  });

  it('declara migracion SQL no destructiva para RPC de salsas', async () => {
    const migration = await readFile(
      new URL('../../sql/2026-07-01_ventas_salsas_fast_paths.sql', import.meta.url),
      'utf8'
    );

    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.registrar_venta_pos_v3\(p_payload jsonb, p_actor jsonb\)/);
    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.registrar_pedido_pendiente_pos_v2\(p_payload jsonb, p_actor jsonb\)/);
    assert.match(migration, /RETURN public\.registrar_venta_pos_v2\(p_payload, p_actor\);/);
    assert.match(migration, /RETURN public\.registrar_pedido_pendiente_pos_v1\(p_payload, p_actor\);/);
    assert.doesNotMatch(migration, /nextval\s*\(/i);
    assert.doesNotMatch(migration, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i);
    assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.registrar_venta_pos_v3\(jsonb, jsonb\) FROM PUBLIC/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.registrar_pedido_pendiente_pos_v2\(jsonb, jsonb\) TO service_role/);
  });
});
