import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(__dirname, '../20260705_z_global_branch_extras_pos_rpc.sql'),
  'utf8'
);

describe('ventas global extras POS RPC migration', () => {
  it('does not authorize recipe extras through menu_extra_receta', () => {
    assert.equal(
      /FROM\s+public\.menu_extra_receta/i.test(migration),
      false,
      'fn_pos_aplicar_inventario_v1 must not query menu_extra_receta for authorization'
    );
    assert.equal(
      /MESSAGE\s*=\s*'POS_RPC_EXTRA_NO_PERMITIDO'/i.test(migration),
      false,
      'recipe extra absence must not emit POS_RPC_EXTRA_NO_PERMITIDO'
    );
  });

  it('preserves branch assignment, legacy movement replay, and negative stock semantics', () => {
    assert.match(migration, /FROM\s+public\.menu_extra_almacenes\s+mea/i);
    assert.match(migration, /mea\.id_almacen\s*=\s*v_id_almacen/i);
    assert.match(migration, /v_assignment_count\s*<>\s*1/i);
    assert.match(migration, /id_extra=%s;\s+id_almacen=%s;\s+id_sucursal=%s/i);
    assert.match(migration, /id_pedido_trazabilidad\s*=\s*p_id_pedido/i);
    assert.match(migration, /id_ref\s*=\s*dp\.id_detalle_pedido/i);
    assert.match(migration, /permite que el saldo quede negativo/i);
    assert.doesNotMatch(migration, /MESSAGE\s*=\s*'POS_RPC_STOCK_INSUFICIENTE'/i);
  });

  it('documents menu_extra_receta as visual recommendation only', () => {
    assert.match(migration, /COMMENT ON TABLE public\.menu_extra_receta IS/i);
    assert.match(migration, /No restringe la venta/i);
    assert.match(migration, /COMMENT ON COLUMN public\.menu_extra_receta\.orden IS/i);
    assert.match(migration, /COMMENT ON COLUMN public\.menu_extra_receta\.estado IS/i);
  });
});
