import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const sqlPath = new URL('../../sql/2026-06-30_align_pedidos_sequence_with_inventory_history.sql', import.meta.url);

const loadSql = async () => readFile(sqlPath, 'utf8');

describe('pedido sequence alignment migration static contract', () => {
  it('bloquea pedidos y movimientos antes de calcular maximos', async () => {
    const sql = await loadSql();
    assert.match(sql, /LOCK\s+TABLE\s+public\.pedidos\s*,\s*public\.movimientos_inventario\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE\s*;/is);
    assert.ok(sql.indexOf('LOCK TABLE') < sql.indexOf('SELECT COALESCE(MAX(id_pedido), 0)'));
    assert.ok(sql.indexOf('LOCK TABLE') < sql.indexOf('SELECT COALESCE(MAX(id_ref), 0)'));
  });

  it('no consume ids y valida is_called con next_candidate', async () => {
    const sql = await loadSql();
    assert.doesNotMatch(sql, /nextval\s*\(/i);
    assert.match(sql, /is_called::boolean/i);
    assert.match(sql, /WHEN\s+v_sequence_is_called\s+THEN\s+v_sequence_last\s+\+\s+v_sequence_increment/is);
    assert.match(sql, /ELSE\s+v_sequence_last/is);
  });

  it('evita setval cuando next_candidate ya supera history_floor', async () => {
    const sql = await loadSql();
    const safeBranchIndex = sql.indexOf('IF v_sequence_next_candidate > v_history_floor THEN');
    const returnIndex = sql.indexOf('RETURN;', safeBranchIndex);
    const safeValueIndex = sql.indexOf('v_safe_value := v_history_floor;');
    const setvalIndex = sql.indexOf('PERFORM setval');
    assert.ok(safeBranchIndex > -1);
    assert.ok(returnIndex > safeBranchIndex);
    assert.ok(safeValueIndex > returnIndex);
    assert.ok(setvalIndex > safeValueIndex);
  });

  it('alinea con history_floor solo si necesita avanzar', async () => {
    const sql = await loadSql();
    assert.match(sql, /v_safe_value\s*:=\s*v_history_floor\s*;/);
    assert.match(sql, /\(v_safe_value\s+\+\s+v_sequence_increment\)\s+>\s+v_sequence_max/);
    assert.match(sql, /PERFORM\s+setval\(v_sequence_name,\s*v_safe_value,\s*true\)/i);
  });
});
