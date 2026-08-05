-- Close backend-only financial persistence from Supabase Data API roles.
-- Repetible: REVOKE and ENABLE ROW LEVEL SECURITY are safe when already applied.
-- Intentionally no public RLS policies and no FORCE ROW LEVEL SECURITY.

REVOKE ALL PRIVILEGES ON TABLE
  public.pedidos,
  public.detalle_pedido,
  public.detalle_pedido_extras,
  public.pedidos_contexto,
  public.pedidos_contacto,
  public.pedidos_delivery,
  public.pedidos_pago_control,
  public.pedidos_inventario_alertas,
  public.facturas,
  public.detalle_facturas,
  public.detalle_facturas_origen,
  public.detalle_factura_extras,
  public.facturas_cobros,
  public.cajas_movimientos,
  public.cajas_sesiones,
  public.ventas_cuenta_divisiones,
  public.ventas_cuenta_division_items,
  public.descuentos,
  public.facturacion_config_sucursal,
  public.facturacion_correlativos_diarios,
  public.fidelizacion_acumulacion_facturas_estado,
  public.fidelizacion_movimientos
FROM PUBLIC, anon, authenticated;

ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_pedido ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_pedido_extras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_contexto ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_contacto ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_pago_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_inventario_alertas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_facturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_facturas_origen ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detalle_factura_extras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturas_cobros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cajas_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cajas_sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas_cuenta_divisiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ventas_cuenta_division_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.descuentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturacion_config_sucursal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturacion_correlativos_diarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_acumulacion_facturas_estado ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelizacion_movimientos ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON SEQUENCE
  public.pedidos_id_pedido_seq,
  public.detalle_pedido_id_detalle_pedido_seq,
  public.detalle_pedido_extras_id_detalle_pedido_extra_seq,
  public.pedidos_contexto_id_pedido_contexto_seq,
  public.pedidos_contacto_id_pedido_contacto_seq,
  public.pedidos_delivery_id_pedido_delivery_seq,
  public.pedidos_pago_control_id_pedido_pago_control_seq,
  public.pedidos_inventario_alertas_id_alerta_seq,
  public.facturas_id_factura_seq,
  public.detalle_facturas_id_detalle_factura_seq,
  public.detalle_facturas_origen_id_origen_seq,
  public.detalle_factura_extras_id_detalle_factura_extra_seq,
  public.facturas_cobros_id_factura_cobro_seq,
  public.cajas_movimientos_id_movimiento_caja_seq,
  public.cajas_sesiones_id_sesion_caja_seq,
  public.ventas_cuenta_divisiones_id_cuenta_division_seq,
  public.ventas_cuenta_division_items_id_cuenta_division_item_seq,
  public.descuentos_id_descuento_seq,
  public.facturacion_config_sucursal_id_config_seq,
  public.facturacion_correlativos_diarios_id_correlativo_seq,
  public.fidelizacion_movimientos_id_movimiento_seq
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE
ON FUNCTION public.registrar_venta_pos_v1(jsonb, jsonb)
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE
ON FUNCTION public.registrar_venta_pos_v2(jsonb, jsonb)
FROM PUBLIC, anon, authenticated;
