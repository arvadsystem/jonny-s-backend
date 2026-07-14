-- Seguridad para excepciones de complementos y cierre atomico de ventas inmediatas V3.
-- Aditivo e idempotente. No ejecutar en produccion sin el proceso de despliegue aprobado.

BEGIN;

INSERT INTO public.permisos (nombre_permiso)
SELECT 'VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR'
);

INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
JOIN public.permisos p
  ON UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR'
WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN ('ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN')
  AND NOT EXISTS (
    SELECT 1
    FROM public.roles_permisos rp
    WHERE rp.id_rol = r.id_rol
      AND rp.id_permiso = p.id_permiso
  );

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

  -- V3 representa una venta inmediata: pedido, factura, cobro e inventario quedan confirmados en esta transaccion.
  UPDATE public.pedidos
  SET estado_pago = 'PAGADO_CONFIRMADO',
      pago_confirmado_at = (NOW() AT TIME ZONE 'America/Tegucigalpa'),
      id_usuario_pago_confirmado = v_id_usuario
  WHERE id_pedido = v_id_pedido;

  v_response := v_base_response || jsonb_build_object(
    'status', 'SUCCESS',
    'estado_pago', 'PAGADO_CONFIRMADO',
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

-- Verificacion QA:
-- SELECT estado_pago, pago_confirmado_at, id_usuario_pago_confirmado FROM public.pedidos WHERE id_pedido = :id_pedido;
-- SELECT nombre_permiso FROM public.permisos WHERE nombre_permiso = 'VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR';
