import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readSql = (name) => fs.readFileSync(new URL(`../../../sql/${name}`, import.meta.url), 'utf8');

test('migracion propuesta cierra pago inmediato y conserva contexto sin tocar historicos', () => {
  const sql = readSql('20260720_fix_ventas_payment_delivery_kitchen_state.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fn_pos_confirm_immediate_order_v1/);
  assert.match(sql, /estado_pago = 'PAGADO_CONFIRMADO'/);
  assert.match(sql, /validacion_pago_vence_at = NULL/);
  assert.match(sql, /cancelado_por_timeout_at = NULL/);
  assert.match(sql, /canal = v_canal/);
  assert.match(sql, /tipo_entrega = v_modalidad/);
  assert.match(sql, /visible_en_cocina_at = NULL/);
  assert.match(sql, /INSERT INTO public\.pedidos_pago_control/);
  assert.match(sql, /fn_pos_confirm_immediate_order_v1\(v_id_pedido, v_id_factura, p_payload, p_actor\)/);
  assert.doesNotMatch(sql, /WHERE id_pedido\s*=\s*(217|218)/);
});

test('preflight y postflight son read-only y rollback restaura la definicion anterior', () => {
  const preflight = readSql('20260720_fix_ventas_payment_delivery_kitchen_state_PREFLIGHT.sql');
  const verify = readSql('20260720_fix_ventas_payment_delivery_kitchen_state_VERIFY.sql');
  const rollback = readSql('20260720_fix_ventas_payment_delivery_kitchen_state_ROLLBACK.sql');

  for (const readOnlySql of [preflight, verify]) {
    assert.doesNotMatch(readOnlySql, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
  }
  assert.match(rollback, /CREATE OR REPLACE FUNCTION public\.registrar_venta_pos_v3/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.fn_pos_confirm_immediate_order_v1/);
});
