-- Close the remaining backend-only financial/inventory persistence from Data API roles.
-- Preserve service_role grants because the server-side integration depends on them.
-- Repetible: REVOKE, ENABLE RLS and ALTER FUNCTION SET are idempotent.

REVOKE ALL PRIVILEGES ON TABLE
  public.productos_almacenes,
  public.facturacion_rangos_cai,
  public.cat_metodos_pago,
  public.fidelizacion_saldos_cliente,
  public.fidelizacion_canjes,
  public.fidelizacion_canjes_detalle,
  public.fidelizacion_ajustes_pendientes,
  public.fidelizacion_configuracion_sucursal,
  public.fidelizacion_productos_canjeables_sucursal
FROM PUBLIC, anon, authenticated;

ALTER TABLE public.productos_almacenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturacion_rangos_cai ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cat_metodos_pago ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_saldos_cliente ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_canjes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_canjes_detalle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_ajustes_pendientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_configuracion_sucursal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_productos_canjeables_sucursal ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON SEQUENCE
  public.cat_metodos_pago_id_metodo_pago_seq,
  public.facturacion_rangos_cai_id_rango_cai_seq,
  public.fidelizacion_ajustes_pendientes_id_ajuste_seq,
  public.fidelizacion_canjes_detalle_id_detalle_canje_seq,
  public.fidelizacion_canjes_id_canje_seq,
  public.fidelizacion_configuracion_sucursal_id_configuracion_seq,
  public.fidelizacion_productos_canjeables_sucursal_id_registro_seq
FROM PUBLIC, anon, authenticated;

-- Objects created in public by postgres become private-by-default for Data API roles.
-- service_role is intentionally retained pending a separate dependency audit.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Both implementations use public-qualified application objects. pg_catalog first
-- prevents shadowing of built-ins while public retains the established helper lookup.
ALTER FUNCTION public.registrar_pedido_pendiente_pos_v1(jsonb, jsonb)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.registrar_pedido_pendiente_pos_v2(jsonb, jsonb)
  SET search_path = pg_catalog, public;

REVOKE EXECUTE
ON FUNCTION public.registrar_pedido_pendiente_pos_v1(jsonb, jsonb)
FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE
ON FUNCTION public.registrar_pedido_pendiente_pos_v2(jsonb, jsonb)
FROM PUBLIC, anon, authenticated;
