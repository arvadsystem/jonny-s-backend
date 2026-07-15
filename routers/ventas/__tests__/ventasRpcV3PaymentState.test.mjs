import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('registrar_venta_pos_v3 pago inmediato', () => {
  it('confirma el pago dentro de la RPC antes de finalizar idempotencia', async () => {
    const sql = await readFile(new URL('../../../sql/2026-07-14_ventas_complementos_incompletos_y_rpc_v3_pago.sql', import.meta.url), 'utf8');
    const paymentUpdateIndex = sql.indexOf("UPDATE public.pedidos\n  SET estado_pago = 'PAGADO_CONFIRMADO'");
    const idempotencyFinishIndex = sql.indexOf('fn_pos_finalizar_idempotencia_v1');

    assert.ok(paymentUpdateIndex >= 0);
    assert.ok(sql.includes("pago_confirmado_at = (NOW() AT TIME ZONE 'America/Tegucigalpa')"));
    assert.ok(sql.includes('id_usuario_pago_confirmado = v_id_usuario'));
    assert.ok(paymentUpdateIndex < idempotencyFinishIndex);
    assert.ok(sql.includes("'estado_pago', 'PAGADO_CONFIRMADO'"));
  });
});
