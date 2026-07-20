-- PRE-FLIGHT READ-ONLY. No modifica datos ni definiciones.

SELECT
  to_regprocedure('public.registrar_venta_pos_v2(jsonb,jsonb)') AS rpc_v2,
  to_regprocedure('public.registrar_venta_pos_v3(jsonb,jsonb)') AS rpc_v3,
  to_regclass('public.pedidos') AS pedidos,
  to_regclass('public.pedidos_contexto') AS pedidos_contexto,
  to_regclass('public.pedidos_pago_control') AS pedidos_pago_control;

SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'pedidos' AND column_name = ANY(ARRAY[
      'estado_pago', 'pago_confirmado_at', 'id_usuario_pago_confirmado',
      'validacion_pago_vence_at', 'cancelado_por_timeout_at', 'canal',
      'tipo_entrega', 'id_estado_pedido', 'visible_en_cocina_at'
    ]))
    OR (table_name = 'pedidos_pago_control' AND column_name = ANY(ARRAY[
      'id_pedido_pago_control', 'id_pedido', 'id_estado_pago_pedido',
      'id_motivo_pago_pendiente', 'monto_total', 'monto_pagado',
      'monto_pendiente', 'fecha_pago_confirmado', 'id_usuario_confirma_pago',
      'id_sesion_caja_pago', 'id_factura', 'observacion_pago', 'fecha_actualizacion'
    ]))
  )
ORDER BY table_name, column_name;

SELECT codigo, estado
FROM public.cat_pedidos_estados_pago
WHERE UPPER(TRIM(codigo)) IN (
  'PENDIENTE_PAGO',
  'PAGADO_CONFIRMADO',
  'CANCELADO_POR_NO_PAGO',
  'PAGO_ANULADO'
)
ORDER BY codigo;

SELECT id_estado_pedido, descripcion
FROM public.estados_pedido
WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(descripcion, '')), '\s+', '_', 'g'))
  IN ('pendiente', 'en_cocina')
ORDER BY id_estado_pedido;

SELECT pg_get_functiondef('public.registrar_venta_pos_v3(jsonb,jsonb)'::regprocedure) AS definicion_rpc_v3;
