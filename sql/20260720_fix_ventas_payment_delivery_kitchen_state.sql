-- Corrige el cierre transaccional de ventas inmediatas V3.
-- No corrige filas historicas. No ejecutar sin auditoria previa en Supabase QA.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_pos_confirm_immediate_order_v1(
  p_id_pedido integer,
  p_id_factura integer,
  p_payload jsonb,
  p_actor jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_id_usuario integer := NULLIF(p_actor->>'id_usuario', '')::integer;
  v_id_sesion_caja bigint := NULLIF(p_actor->>'id_sesion_caja', '')::bigint;
  v_total numeric(14,2) := NULLIF(p_payload#>>'{venta,total}', '')::numeric;
  v_canal text := UPPER(TRIM(COALESCE(p_payload#>>'{contexto,canal}', '')));
  v_modalidad text := UPPER(TRIM(COALESCE(p_payload#>>'{contexto,modalidad}', '')));
  v_id_estado_pago integer;
  v_id_estado_pendiente integer;
  v_id_pago_control bigint;
BEGIN
  IF p_id_pedido IS NULL OR p_id_pedido <= 0
     OR p_id_factura IS NULL OR p_id_factura <= 0
     OR v_id_usuario IS NULL OR v_id_usuario <= 0
     OR v_id_sesion_caja IS NULL OR v_id_sesion_caja <= 0
     OR v_total IS NULL OR v_total <= 0
     OR v_canal = '' OR v_modalidad = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_IMMEDIATE_ORDER_CONTEXT_INVALID';
  END IF;

  SELECT id_estado_pago_pedido
  INTO v_id_estado_pago
  FROM public.cat_pedidos_estados_pago
  WHERE UPPER(TRIM(codigo)) = 'PAGADO_CONFIRMADO'
    AND COALESCE(estado, true) = true
  LIMIT 1;

  SELECT id_estado_pedido
  INTO v_id_estado_pendiente
  FROM public.estados_pedido
  WHERE LOWER(REGEXP_REPLACE(TRIM(COALESCE(descripcion, '')), '\s+', '_', 'g'))
    IN ('pendiente', 'pendientes', 'por_pagar', 'pendiente_por_pagar', 'pendiente_/_por_pagar', 'pendientes_/_por_pagar')
  ORDER BY id_estado_pedido
  LIMIT 1;

  IF v_id_estado_pago IS NULL OR v_id_estado_pendiente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_IMMEDIATE_ORDER_CATALOG_MISSING';
  END IF;

  UPDATE public.pedidos
  SET estado_pago = 'PAGADO_CONFIRMADO',
      pago_confirmado_at = COALESCE(pago_confirmado_at, timezone('America/Tegucigalpa', now())),
      id_usuario_pago_confirmado = COALESCE(id_usuario_pago_confirmado, v_id_usuario),
      validacion_pago_vence_at = NULL,
      cancelado_por_timeout_at = NULL,
      canal = v_canal,
      tipo_entrega = v_modalidad,
      id_estado_pedido = v_id_estado_pendiente,
      visible_en_cocina_at = NULL
  WHERE id_pedido = p_id_pedido;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_IMMEDIATE_ORDER_NOT_FOUND';
  END IF;

  SELECT id_pedido_pago_control
  INTO v_id_pago_control
  FROM public.pedidos_pago_control
  WHERE id_pedido = p_id_pedido
  ORDER BY id_pedido_pago_control DESC
  LIMIT 1
  FOR UPDATE;

  IF v_id_pago_control IS NULL THEN
    INSERT INTO public.pedidos_pago_control (
      id_pedido, id_estado_pago_pedido, id_motivo_pago_pendiente,
      monto_total, monto_pagado, monto_pendiente, fecha_pago_confirmado,
      id_usuario_confirma_pago, id_sesion_caja_pago, id_factura, observacion_pago
    ) VALUES (
      p_id_pedido, v_id_estado_pago, NULL,
      v_total, v_total, 0, timezone('America/Tegucigalpa', now()),
      v_id_usuario, v_id_sesion_caja, p_id_factura, NULL
    );
  ELSE
    UPDATE public.pedidos_pago_control
    SET id_estado_pago_pedido = v_id_estado_pago,
        id_motivo_pago_pendiente = NULL,
        monto_total = v_total,
        monto_pagado = v_total,
        monto_pendiente = 0,
        fecha_pago_confirmado = COALESCE(fecha_pago_confirmado, timezone('America/Tegucigalpa', now())),
        id_usuario_confirma_pago = COALESCE(id_usuario_confirma_pago, v_id_usuario),
        id_sesion_caja_pago = COALESCE(id_sesion_caja_pago, v_id_sesion_caja),
        id_factura = COALESCE(id_factura, p_id_factura),
        fecha_actualizacion = timezone('America/Tegucigalpa', now())
    WHERE id_pedido_pago_control = v_id_pago_control;
  END IF;

  RETURN jsonb_build_object(
    'estado_pago', 'PAGADO_CONFIRMADO',
    'canal', v_canal,
    'modalidad', v_modalidad,
    'estado_pedido', 'PENDIENTE'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_venta_pos_v3(p_payload jsonb, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_id_usuario integer;
  v_id_sucursal integer;
  v_id_caja integer;
  v_id_sesion_caja bigint;
  v_idempotency_key text;
  v_request_hash text;
  v_idem jsonb;
  v_base_response jsonb;
  v_response jsonb;
  v_id_pedido integer;
  v_id_factura integer;
  v_line_map jsonb;
  v_inventory jsonb;
  v_facturacion jsonb;
  v_order_state jsonb;
  v_total numeric(14,2);
  v_pedido_total numeric(14,2);
  v_cobro_total numeric(14,2);
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR p_actor IS NULL OR jsonb_typeof(p_actor) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_RPC_PAYLOAD_INVALIDO';
  END IF;

  IF COALESCE(NULLIF(p_payload->>'schema_version', '')::integer, 0) <> 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_RPC_SCHEMA_VERSION_INVALIDA', DETAIL = 'registrar_venta_pos_v3 requiere schema_version=3.';
  END IF;

  v_id_usuario := NULLIF(p_actor->>'id_usuario', '')::integer;
  v_id_sucursal := NULLIF(p_actor->>'id_sucursal', '')::integer;
  v_id_caja := NULLIF(p_actor->>'id_caja', '')::integer;
  v_id_sesion_caja := NULLIF(p_actor->>'id_sesion_caja', '')::bigint;

  IF v_id_usuario IS NULL OR v_id_usuario <= 0
     OR v_id_sucursal IS NULL OR v_id_sucursal <= 0
     OR v_id_caja IS NULL OR v_id_caja <= 0
     OR v_id_sesion_caja IS NULL OR v_id_sesion_caja <= 0
     OR NULLIF(p_payload#>>'{factura,id_usuario}', '')::integer IS DISTINCT FROM v_id_usuario
     OR NULLIF(p_payload#>>'{factura,id_sucursal}', '')::integer IS DISTINCT FROM v_id_sucursal
     OR NULLIF(p_payload#>>'{factura,id_caja}', '')::integer IS DISTINCT FROM v_id_caja
     OR NULLIF(p_payload#>>'{factura,id_sesion_caja}', '')::bigint IS DISTINCT FROM v_id_sesion_caja THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_RPC_ACTOR_SCOPE_MISMATCH';
  END IF;

  IF jsonb_typeof(p_payload->'idempotency') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_RPC_IDEMPOTENCY_REQUERIDA';
  END IF;

  v_idempotency_key := p_payload#>>'{idempotency,key}';
  v_request_hash := p_payload#>>'{idempotency,request_hash}';
  v_idem := public.fn_pos_reservar_idempotencia_v1(v_idempotency_key, 'POST /ventas', v_request_hash, v_id_usuario, v_id_sucursal);

  IF COALESCE((v_idem->>'replay')::boolean, false) THEN
    RETURN COALESCE(v_idem->'response_body', '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
  END IF;

  v_total := NULLIF(p_payload#>>'{venta,total}', '')::numeric;
  v_pedido_total := NULLIF(p_payload#>>'{pedido,total}', '')::numeric;
  v_cobro_total := NULLIF(p_payload#>>'{cobro,monto}', '')::numeric;
  IF v_total IS NULL OR v_total <= 0
     OR v_pedido_total IS NULL OR abs(v_pedido_total - v_total) > 0.01
     OR v_cobro_total IS NULL OR abs(v_cobro_total - v_total) > 0.01 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_RPC_TOTAL_INCONSISTENTE';
  END IF;

  PERFORM public.fn_ventas_assert_caja_session_write_open(v_id_sesion_caja, v_id_caja, v_id_sucursal, v_id_usuario);
  v_base_response := public.registrar_venta_pos_v2(p_payload - 'idempotency' - 'schema_version', p_actor);
  v_id_pedido := NULLIF(v_base_response->>'id_pedido', '')::integer;
  v_id_factura := NULLIF(v_base_response->>'id_factura', '')::integer;

  IF v_id_pedido IS NULL OR v_id_pedido <= 0 OR v_id_factura IS NULL OR v_id_factura <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'POS_RPC_RESPUESTA_BASE_INVALIDA';
  END IF;

  v_facturacion := public.fn_pos_actualizar_snapshot_factura_v1(v_id_factura, v_id_sucursal);
  v_base_response := v_base_response || v_facturacion;
  v_line_map := public.fn_pos_build_line_map_v1(v_id_pedido, p_payload->'items');
  v_inventory := public.fn_pos_aplicar_inventario_v1(v_id_pedido, v_id_sucursal, p_payload->'items', v_line_map, p_actor);
  v_order_state := public.fn_pos_confirm_immediate_order_v1(v_id_pedido, v_id_factura, p_payload, p_actor);

  v_response := v_base_response || v_order_state || jsonb_build_object(
    'status', 'SUCCESS',
    'rpc_version', 'v3',
    'idempotent_replay', false,
    'line_map', v_line_map,
    'inventario', v_inventory
  );

  PERFORM public.fn_pos_finalizar_idempotencia_v1(v_idempotency_key, 'POST /ventas', v_request_hash, 201, v_response, v_id_pedido, v_id_factura, v_id_usuario, v_id_sucursal);
  RETURN v_response;
END;
$function$;

COMMIT;
