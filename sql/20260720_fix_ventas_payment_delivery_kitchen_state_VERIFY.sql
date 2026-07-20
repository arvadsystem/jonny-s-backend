-- POST-FLIGHT READ-ONLY. Ejecutar solo despues de una aplicacion aprobada.

SELECT
  to_regprocedure('public.fn_pos_confirm_immediate_order_v1(integer,integer,jsonb,jsonb)') AS helper,
  to_regprocedure('public.registrar_venta_pos_v3(jsonb,jsonb)') AS rpc_v3;

SELECT
  position(
    'fn_pos_confirm_immediate_order_v1' IN
    pg_get_functiondef('public.registrar_venta_pos_v3(jsonb,jsonb)'::regprocedure)
  ) > 0 AS rpc_v3_usa_cierre_coherente;

SELECT
  position('PAGADO_CONFIRMADO' IN pg_get_functiondef(
    'public.fn_pos_confirm_immediate_order_v1(integer,integer,jsonb,jsonb)'::regprocedure
  )) > 0 AS confirma_pago,
  position('visible_en_cocina_at = NULL' IN pg_get_functiondef(
    'public.fn_pos_confirm_immediate_order_v1(integer,integer,jsonb,jsonb)'::regprocedure
  )) > 0 AS inicia_fuera_cocina,
  position('tipo_entrega = v_modalidad' IN pg_get_functiondef(
    'public.fn_pos_confirm_immediate_order_v1(integer,integer,jsonb,jsonb)'::regprocedure
  )) > 0 AS conserva_modalidad;

-- Validacion operativa para trabajos NUEVOS creados despues de aplicar la migracion.
-- Sustituir :id_pedido y :id_factura manualmente; no usar IDs historicos para corregir datos.
SELECT
  p.id_pedido,
  p.estado_pago,
  p.pago_confirmado_at,
  p.id_usuario_pago_confirmado,
  p.canal,
  p.tipo_entrega,
  p.visible_en_cocina_at,
  ppc.monto_total,
  ppc.monto_pagado,
  ppc.monto_pendiente,
  ppc.id_factura
FROM public.pedidos p
LEFT JOIN LATERAL (
  SELECT ppc_inner.*
  FROM public.pedidos_pago_control ppc_inner
  WHERE ppc_inner.id_pedido = p.id_pedido
  ORDER BY ppc_inner.id_pedido_pago_control DESC
  LIMIT 1
) ppc ON true
WHERE p.id_pedido = :id_pedido
  AND ppc.id_factura = :id_factura;
