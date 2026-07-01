export const VENTA_DIRECTA_LABEL = 'VENTA DIRECTA';
export const TEGUCIGALPA_TZ = 'America/Tegucigalpa';
export const VENTAS_DEFAULT_PAGE = 1;
export const VENTAS_DEFAULT_PAGE_SIZE = 30;
export const VENTAS_MAX_PAGE_SIZE = 50;
export const VENTAS_HISTORY_ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMINISTRADOR', 'ADMIN']);
export const VENTAS_HISTORY_CAJERO_ROLE = 'CAJERO';
export const VENTAS_LIMIT_72H_CUTOFF_SQL = `(NOW() AT TIME ZONE '${TEGUCIGALPA_TZ}') - INTERVAL '72 hours'`;
export const VENTAS_DESCUENTOS_PERMISSIONS = ['VENTAS_DESCUENTOS_CATALOGO_VER'];
export const VENTAS_DESCUENTOS_WRITE_PERMISSIONS = [
  'VENTAS_DESCUENTOS_CATALOGO_CREAR',
  'VENTAS_DESCUENTOS_CATALOGO_EDITAR',
  'VENTAS_DESCUENTOS_CATALOGO_ESTADO_CAMBIAR'
];
export const DESCUENTO_TIPO_KEYS = {
  MONTO_FIJO: 'MONTO_FIJO',
  PORCENTAJE: 'PORCENTAJE'
};
export const DESCUENTO_ALCANCE_KEYS = {
  FACTURA_COMPLETA: 'FACTURA_COMPLETA',
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA'
};
export const VENTAS_DESCUENTO_APLICAR_PERMISSION = 'VENTAS_DESCUENTO_APLICAR';
export const ESTADO_PEDIDO_CODES = {
  PENDIENTE: new Set([
    'pendiente',
    'pendientes',
    'por_pagar',
    'pendiente_por_pagar',
    'pendiente_/_por_pagar',
    'pendientes_/_por_pagar'
  ]),
  EN_COCINA: new Set(['en_cocina']),
  EN_PREPARACION: new Set(['en_preparacion']),
  LISTO_PARA_ENTREGA: new Set(['listo_para_entrega']),
  CANCELADO: new Set(['cancelado', 'cancelada', 'anulado', 'anulada']),
  COMPLETADO: new Set([
    'completada',
    'completado',
    'finalizada',
    'finalizado',
    'pagada',
    'pagado',
    'cerrada',
    'cerrado',
    'lista',
    'listo'
  ]),
  NO_ENTREGADO: new Set(['no_entregado'])
};
export const PEDIDO_MENU_PAYMENT_WINDOW_MINUTES = 10;
export const PEDIDO_ESTADO_PAGO = Object.freeze({
  PENDIENTE_VALIDACION: 'PENDIENTE_VALIDACION',
  PAGADO_CONFIRMADO: 'PAGADO_CONFIRMADO',
  CANCELADO_TIMEOUT: 'CANCELADO_TIMEOUT'
});
export const VENTAS_PERF_STAGE_NAMES = [
  'auth_context_ms',
  'auth_permission_ms',
  'auth_scope_ms',
  'auth_caja_ms',
  'auth_sesion_caja_ms',
  'auth_caja_sesion_combined_ms',
  'auth_payload_context_ms',
  'auth_payload_context_combined_ms',
  'payload_build_ms',
  'totals_ms',
  'totals_catalogos_ms',
  'totals_items_ms',
  'totals_productos_ms',
  'totals_recetas_ms',
  'totals_complementos_ms',
  'totals_sauce_rules_ms',
  'totals_allowed_sauces_ms',
  'totals_descuentos_ms',
  'totals_extras_ms',
  'validation_items_ms',
  'validation_descuentos_ms',
  'validation_extras_ms',
  'catalog_prefetch_ms',
  'catalog_cache_ms',
  'totals_impuestos_ms',
  'totals_build_ms',
  'pedido_pendiente_scope_ms',
  'pedido_pendiente_idempotency_ms',
  'pedido_pendiente_build_ms',
  'pedido_pendiente_static_catalogs_ms',
  'pedido_pendiente_allowed_extras_schema_ms',
  'pedido_pendiente_allowed_extras_query_ms',
  'pedido_pendiente_hydrate_lines_ms',
  'pedido_pendiente_cuenta_dividida_plan_ms',
  'pedido_pendiente_contexto_ms',
  'pedido_pendiente_detalle_ms',
  'pedido_pendiente_contacto_ms',
  'pedido_pendiente_pago_control_ms',
  'pedido_pendiente_rpc_payload_build_ms',
  'pedido_pendiente_rpc_call_ms',
  'pedido_pendiente_rpc_total_ms',
  'pedido_pendiente_rpc_v1_call_ms',
  'pedido_pendiente_rpc_v1_total_ms',
  'pedido_pendiente_rpc_v2_call_ms',
  'pedido_pendiente_rpc_v2_total_ms',
  'pedido_pendiente_commit_ms',
  'pedido_pendiente_idempotency_success_ms',
  'pedido_pendiente_total_route_ms',
  'registrar_pago_base_context_ms',
  'registrar_pago_detalle_pedido_ms',
  'registrar_pago_scope_session_ms',
  'registrar_pago_cuenta_dividida_ms',
  'registrar_pago_contexto_ms',
  'registrar_pago_factura_cobro_ms',
  'registrar_pago_detalle_final_ms',
  'pedido_ms',
  'detalle_pedido_ms',
  'detalle_pedido_descuentos_ms',
  'detalle_pedido_lookup_ms',
  'detalle_pedido_reuse_hydrated_ms',
  'detalle_pedido_insert_ms',
  'factura_ms',
  'factura_correlativo_ms',
  'factura_correlativo_config_ms',
  'factura_correlativo_rango_ms',
  'factura_correlativo_numero_ms',
  'factura_insert_ms',
  'factura_snapshot_ms',
  'factura_snapshot_config_ms',
  'factura_snapshot_sucursal_ms',
  'factura_snapshot_build_ms',
  'detalle_factura_ms',
  'detalle_factura_descuentos_ms',
  'detalle_factura_lookup_ms',
  'detalle_factura_insert_ms',
  'detalle_factura_origen_ms',
  'cobro_ms',
  'inventario_ms',
  'fidelizacion_ms',
  'ticket_response_build_ms',
  'pre_rpc_total_ms',
  'rpc_payload_build_ms',
  'rpc_call_ms',
  'rpc_v2_payload_build_ms',
  'rpc_v2_call_ms',
  'rpc_v2_total_ms',
  'rpc_v3_payload_build_ms',
  'rpc_v3_call_ms',
  'rpc_v3_total_ms',
  'post_rpc_total_ms',
  'post_rpc_fidelizacion_ms',
  'post_rpc_response_ms',
  'node_before_rpc_ms',
  'node_after_rpc_ms',
  'rpc_total_ms',
  'commit_ms'
];
export const VENTAS_PERF_COUNTER_NAMES = [
  'cache_hits',
  'cache_misses'
];
export const PEDIDO_PENDIENTE_ESTADO_PAGO = 'PENDIENTE_PAGO';
export const PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO = 'PAGADO_CONFIRMADO';
export const PEDIDO_PENDIENTE_ESTADO_DELIVERY = 'PENDIENTE';
export const PEDIDO_PENDIENTE_CANALES = new Set(['LOCAL', 'TELEFONO', 'WHATSAPP']);
export const PEDIDO_PENDIENTE_MODALIDADES = new Set(['CONSUMO_LOCAL', 'RECOGER', 'DELIVERY']);
export const REVERSION_ALERT_EMAIL = 'gersonmz@jonnyshn.com';
export const REVERSION_FAILURE_EMAIL_COOLDOWN_MS = 60 * 1000;
export const VENTA_COMPLEMENTO_TIPO_SALSAS = 'SALSAS';
export const WINGS_SAUCE_KEYWORDS = Object.freeze(['alita', 'alitas', 'tender', 'tenders']);
export const VENTAS_FIDELIZACION_ADVISORY_LOCK_CLASS = 724201;
