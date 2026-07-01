BEGIN;

CREATE OR REPLACE FUNCTION public.registrar_venta_pos_v3(p_payload jsonb, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.registrar_venta_pos_v2(p_payload, p_actor);
END;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_pedido_pendiente_pos_v2(p_payload jsonb, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.registrar_pedido_pendiente_pos_v1(p_payload, p_actor);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.registrar_venta_pos_v3(jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.registrar_venta_pos_v3(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.registrar_venta_pos_v3(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_venta_pos_v3(jsonb, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.registrar_pedido_pendiente_pos_v2(jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.registrar_pedido_pendiente_pos_v2(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.registrar_pedido_pendiente_pos_v2(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_pedido_pendiente_pos_v2(jsonb, jsonb) TO service_role;

COMMIT;
