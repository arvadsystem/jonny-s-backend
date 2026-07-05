import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const migrationPath = new URL('../../../sql/20260705_fix_pos_rpc_standalone_extra_item.sql', import.meta.url);

const readMigration = () => readFile(migrationPath, 'utf8');

describe('standalone extra inventory RPC migration', () => {
  it('protege el contrato ITEM sin relajar producto, receta ni stock', async () => {
    const sql = await readMigration();
    const itemBranchStart = sql.indexOf("IF v_item_tipo = 'ITEM' THEN");
    const recetaBranchStart = sql.indexOf("ELSIF v_item_tipo = 'RECETA' THEN", itemBranchStart);
    const itemBranch = sql.slice(itemBranchStart, recetaBranchStart);
    const finalItemValidationStart = sql.indexOf("ELSIF v_item_tipo='ITEM' THEN");
    const finalRecipeValidationStart = sql.indexOf('ELSE', finalItemValidationStart);
    const finalItemValidation = sql.slice(finalItemValidationStart, finalRecipeValidationStart);

    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fn_pos_aplicar_inventario_v1/);
    assert.match(itemBranch, /v_expected_extras > 1/);
    assert.match(itemBranch, /v_item_id_extra IS DISTINCT FROM v_id_extra/);
    assert.match(itemBranch, /WHERE NULLIF\(e\.value->>'id_extra', ''\)::integer = v_item_id_extra/);
    assert.match(itemBranch, /cantidad_total/);
    assert.match(finalItemValidation, /v_extra_consumptions<>1/);
    assert.match(finalItemValidation, /v_expected_extras>1/);
    assert.match(sql, /POS_RPC_STOCK_INSUFICIENTE/);
    assert.match(sql, /IF v_item_tipo='PRODUCTO' THEN/);
    assert.match(sql, /v_recipe_component_count=0 OR v_product_consumptions<>0 OR v_recipe_consumptions=0/);
  });
});
