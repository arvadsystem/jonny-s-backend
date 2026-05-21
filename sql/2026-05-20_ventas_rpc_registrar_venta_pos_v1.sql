-- RPC V1 para registrar ventas POS en una sola llamada transaccional.
-- No ejecutar automaticamente: debe revisarse y aplicarse manualmente.
-- Si el rol de conexion del backend no es owner de la funcion, puede requerir:
-- GRANT EXECUTE ON FUNCTION public.registrar_venta_pos_v1(jsonb, jsonb) TO <backend_db_role>;

CREATE OR REPLACE FUNCTION public.registrar_venta_pos_v1(p_payload jsonb, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/Tegucigalpa', now());
  v_pedido jsonb := COALESCE(p_payload->'pedido', '{}'::jsonb);
  v_factura jsonb := COALESCE(p_payload->'factura', '{}'::jsonb);
  v_cobro jsonb := COALESCE(p_payload->'cobro', '{}'::jsonb);
  v_venta jsonb := COALESCE(p_payload->'venta', '{}'::jsonb);
  v_correlativo jsonb := COALESCE(p_payload->'correlativo', '{}'::jsonb);
  v_snapshot_fiscal jsonb := COALESCE(p_payload->'snapshot_fiscal', '{}'::jsonb);
  v_ticket_facturacion jsonb := COALESCE(p_payload->'ticket_facturacion', '{}'::jsonb);
  v_items jsonb := COALESCE(p_payload->'items', '[]'::jsonb);
  v_id_pedido integer;
  v_fecha_hora_pedido timestamp;
  v_id_factura integer;
  v_fecha_hora_facturacion timestamp;
  v_fecha_operacion date;
  v_item record;
  v_id_descuento integer;
  v_id_detalle_pedido integer;
  v_id_detalle_factura integer;
  v_detalle_pedido_refs jsonb := '{}'::jsonb;
  v_descuento_refs jsonb := '{}'::jsonb;
  v_items_response jsonb := '[]'::jsonb;
  v_context record;
  v_total_items numeric := 0;
  v_ticket_ready boolean := false;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'VENTAS_RPC_PAYLOAD_INVALIDO';
  END IF;

  IF p_actor IS NULL OR jsonb_typeof(p_actor) <> 'object' THEN
    RAISE EXCEPTION 'VENTAS_RPC_ACTOR_INVALIDO';
  END IF;

  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'VENTAS_RPC_ITEMS_REQUERIDOS';
  END IF;

  IF NULLIF(v_correlativo->>'codigo', '') IS NULL THEN
    RAISE EXCEPTION 'VENTAS_RPC_CORRELATIVO_REQUERIDO';
  END IF;

  IF (p_actor->>'id_usuario')::integer IS DISTINCT FROM (v_factura->>'id_usuario')::integer
    OR (p_actor->>'id_sucursal')::integer IS DISTINCT FROM (v_factura->>'id_sucursal')::integer
    OR (p_actor->>'id_caja')::integer IS DISTINCT FROM (v_factura->>'id_caja')::integer
    OR (p_actor->>'id_sesion_caja')::integer IS DISTINCT FROM (v_factura->>'id_sesion_caja')::integer THEN
    RAISE EXCEPTION 'VENTAS_RPC_ACTOR_SCOPE_MISMATCH';
  END IF;

  INSERT INTO public.pedidos (
    descripcion_pedido,
    descripcion_envio,
    fecha_hora_pedido,
    sub_total,
    isv,
    total,
    id_estado_pedido,
    id_sucursal,
    id_cliente,
    id_usuario,
    origen_pedido
  )
  VALUES (
    NULLIF(v_pedido->>'descripcion_pedido', ''),
    NULLIF(v_pedido->>'descripcion_envio', ''),
    v_now,
    COALESCE((v_pedido->>'sub_total')::numeric, 0),
    COALESCE((v_pedido->>'isv')::numeric, 0),
    COALESCE((v_pedido->>'total')::numeric, 0),
    (v_pedido->>'id_estado_pedido')::integer,
    (v_pedido->>'id_sucursal')::integer,
    NULLIF(v_pedido->>'id_cliente', '')::integer,
    (v_pedido->>'id_usuario')::integer,
    'CAJA'
  )
  RETURNING id_pedido, fecha_hora_pedido
  INTO v_id_pedido, v_fecha_hora_pedido;

  FOR v_item IN
    SELECT *
    FROM jsonb_to_recordset(v_items) AS item (
      item_index integer,
      tipo_item text,
      id_producto integer,
      id_receta integer,
      id_combo integer,
      id_descuento_catalogo integer,
      cantidad numeric,
      precio_unitario numeric,
      sub_total numeric,
      total_linea numeric,
      descuento numeric,
      observacion text,
      configuracion_menu jsonb,
      origen_snapshot jsonb,
      nombre_item text
    )
    ORDER BY item_index
  LOOP
    v_id_descuento := NULL;

    IF COALESCE(v_item.descuento, 0) > 0 THEN
      INSERT INTO public.descuentos (monto_descuento, id_descuento_catalogo)
      VALUES (COALESCE(v_item.descuento, 0), v_item.id_descuento_catalogo)
      RETURNING id_descuento INTO v_id_descuento;
    END IF;

    v_descuento_refs := jsonb_set(
      v_descuento_refs,
      ARRAY[v_item.item_index::text],
      COALESCE(to_jsonb(v_id_descuento), 'null'::jsonb),
      true
    );

    INSERT INTO public.detalle_pedido (
      sub_total_pedido,
      total_pedido,
      id_producto,
      id_pedido,
      id_descuento,
      estado,
      id_combo,
      id_receta,
      observacion,
      configuracion_menu
    )
    VALUES (
      COALESCE(v_item.sub_total, 0),
      COALESCE(v_item.total_linea, 0),
      v_item.id_producto,
      v_id_pedido,
      v_id_descuento,
      true,
      v_item.id_combo,
      v_item.id_receta,
      NULLIF(v_item.observacion, ''),
      v_item.configuracion_menu
    )
    RETURNING id_detalle_pedido INTO v_id_detalle_pedido;

    v_detalle_pedido_refs := jsonb_set(
      v_detalle_pedido_refs,
      ARRAY[v_item.item_index::text],
      to_jsonb(v_id_detalle_pedido),
      true
    );
  END LOOP;

  INSERT INTO public.facturas (
    id_caja,
    id_pedido,
    id_sucursal,
    id_usuario,
    id_cliente,
    codigo_venta,
    fecha_operacion,
    efectivo_entregado,
    cambio,
    fecha_hora_facturacion,
    isv_15,
    isv_18,
    id_sesion_caja
  )
  VALUES (
    (v_factura->>'id_caja')::integer,
    v_id_pedido,
    (v_factura->>'id_sucursal')::integer,
    (v_factura->>'id_usuario')::integer,
    NULLIF(v_factura->>'id_cliente', '')::integer,
    v_factura->>'codigo_venta',
    (v_factura->>'fecha_operacion')::date,
    NULLIF(v_factura->>'efectivo_entregado', '')::numeric,
    COALESCE((v_factura->>'cambio')::numeric, 0),
    v_now,
    COALESCE((v_factura->>'isv_15')::numeric, 0),
    0,
    (v_factura->>'id_sesion_caja')::integer
  )
  RETURNING id_factura, fecha_hora_facturacion, fecha_operacion
  INTO v_id_factura, v_fecha_hora_facturacion, v_fecha_operacion;

  UPDATE public.facturas
  SET
    id_config_facturacion = NULLIF(v_snapshot_fiscal->>'id_config_facturacion', '')::integer,
    id_rango_cai = NULL,
    numero_factura_fiscal = '0',
    facturacion_snapshot = COALESCE(v_snapshot_fiscal->'facturacion_snapshot', '{}'::jsonb)
  WHERE id_factura = v_id_factura;

  INSERT INTO public.facturas_cobros (
    id_factura,
    id_sesion_caja,
    id_caja,
    id_sucursal,
    id_usuario_ejecutor,
    id_metodo_pago,
    monto,
    referencia,
    fecha_cobro,
    fecha_creacion
  )
  VALUES (
    v_id_factura,
    (v_factura->>'id_sesion_caja')::integer,
    (v_factura->>'id_caja')::integer,
    (v_factura->>'id_sucursal')::integer,
    (v_factura->>'id_usuario')::integer,
    (v_cobro->>'id_metodo_pago')::integer,
    COALESCE((v_cobro->>'monto')::numeric, 0),
    NULLIF(v_cobro->>'referencia', ''),
    v_now,
    v_now
  );

  FOR v_item IN
    SELECT *
    FROM jsonb_to_recordset(v_items) AS item (
      item_index integer,
      tipo_item text,
      id_producto integer,
      id_receta integer,
      id_combo integer,
      id_descuento_catalogo integer,
      cantidad numeric,
      precio_unitario numeric,
      sub_total numeric,
      total_linea numeric,
      descuento numeric,
      observacion text,
      configuracion_menu jsonb,
      origen_snapshot jsonb,
      nombre_item text
    )
    ORDER BY item_index
  LOOP
    v_id_detalle_pedido := (v_detalle_pedido_refs->>v_item.item_index::text)::integer;
    v_id_descuento := NULLIF(v_descuento_refs->>v_item.item_index::text, 'null')::integer;

    INSERT INTO public.detalle_facturas (
      id_factura,
      id_producto,
      id_descuento,
      cantidad,
      precio_unitario,
      sub_total,
      total_detalle,
      id_pedido,
      id_detalle_pedido,
      tipo_item,
      id_receta,
      id_combo,
      origen_snapshot
    )
    VALUES (
      v_id_factura,
      v_item.id_producto,
      v_id_descuento,
      COALESCE(v_item.cantidad, 0),
      COALESCE(v_item.precio_unitario, 0),
      COALESCE(v_item.sub_total, 0),
      COALESCE(v_item.total_linea, 0),
      v_id_pedido,
      v_id_detalle_pedido,
      COALESCE(NULLIF(v_item.tipo_item, ''), 'ITEM'),
      v_item.id_receta,
      v_item.id_combo,
      COALESCE(v_item.origen_snapshot, '{}'::jsonb)
    )
    RETURNING id_detalle_factura INTO v_id_detalle_factura;

    INSERT INTO public.detalle_facturas_origen (
      id_detalle_factura,
      id_detalle_pedido,
      tipo_item,
      id_producto,
      id_receta,
      id_combo,
      origen_snapshot
    )
    VALUES (
      v_id_detalle_factura,
      v_id_detalle_pedido,
      COALESCE(NULLIF(v_item.tipo_item, ''), 'ITEM'),
      v_item.id_producto,
      v_item.id_receta,
      v_item.id_combo,
      COALESCE(v_item.origen_snapshot, '{}'::jsonb)
    )
    ON CONFLICT (id_detalle_factura)
    DO UPDATE SET
      id_detalle_pedido = EXCLUDED.id_detalle_pedido,
      tipo_item = EXCLUDED.tipo_item,
      id_producto = EXCLUDED.id_producto,
      id_receta = EXCLUDED.id_receta,
      id_combo = EXCLUDED.id_combo,
      origen_snapshot = EXCLUDED.origen_snapshot;

    v_total_items := v_total_items + COALESCE(v_item.cantidad, 0);
    v_items_response := v_items_response || jsonb_build_array(
      jsonb_build_object(
        'id_detalle', v_id_detalle_factura,
        'id_detalle_factura', v_id_detalle_factura,
        'id_detalle_pedido', v_id_detalle_pedido,
        'tipo_item', COALESCE(NULLIF(v_item.tipo_item, ''), 'ITEM'),
        'id_producto', v_item.id_producto,
        'id_combo', v_item.id_combo,
        'id_receta', v_item.id_receta,
        'nombre_item', COALESCE(v_item.origen_snapshot->>'nombre_item', v_item.nombre_item, 'Item de cocina'),
        'nombre_producto', COALESCE(v_item.origen_snapshot->>'nombre_item', v_item.nombre_item, 'Item de cocina'),
        'cantidad', COALESCE(v_item.cantidad, 0),
        'precio_unitario', COALESCE(v_item.precio_unitario, 0),
        'sub_total', COALESCE(v_item.sub_total, 0),
        'subtotal_linea', COALESCE(v_item.sub_total, 0),
        'total_linea', COALESCE(v_item.total_linea, 0),
        'descuento', COALESCE(v_item.descuento, 0),
        'descuento_linea', COALESCE(v_item.descuento, 0),
        'isv_15_linea', NULL,
        'isv_18_linea', NULL,
        'exento_linea', NULL,
        'exonerado_linea', NULL,
        'observacion', NULLIF(v_item.observacion, ''),
        'configuracion_menu', v_item.configuracion_menu,
        'componentes', COALESCE(v_item.origen_snapshot->'componentes', '[]'::jsonb),
        'complementos', COALESCE(v_item.configuracion_menu->'complementos', '[]'::jsonb),
        'salsas', COALESCE(v_item.configuracion_menu->'complementos', '[]'::jsonb),
        'extras', COALESCE(v_item.configuracion_menu->'extras', '[]'::jsonb),
        'indicaciones', COALESCE(NULLIF(v_item.observacion, ''), v_item.configuracion_menu->>'indicaciones'),
        'origen_snapshot', COALESCE(v_item.origen_snapshot, '{}'::jsonb)
      )
    );
  END LOOP;

  SELECT
    COALESCE(
      NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
      emp.nombre_empresa,
      'Consumidor final'
    ) AS cliente_nombre,
    COALESCE(NULLIF(trim(per.rtn), ''), NULLIF(trim(emp.rtn), '')) AS cliente_rtn,
    u.nombre_usuario,
    cj.nombre_caja,
    cj.codigo_caja,
    s.nombre_sucursal
  INTO v_context
  FROM (SELECT 1) base
  LEFT JOIN public.clientes c ON c.id_cliente = NULLIF(v_factura->>'id_cliente', '')::integer
  LEFT JOIN public.personas per ON per.id_persona = c.id_persona
  LEFT JOIN public.empresas emp ON emp.id_empresa = c.id_empresa
  LEFT JOIN public.usuarios u ON u.id_usuario = (v_factura->>'id_usuario')::integer
  LEFT JOIN public.cajas cj ON cj.id_caja = (v_factura->>'id_caja')::integer
  LEFT JOIN public.sucursales s ON s.id_sucursal = (v_factura->>'id_sucursal')::integer;

  v_ticket_ready := v_id_factura > 0
    AND v_id_pedido > 0
    AND jsonb_array_length(v_items_response) > 0;

  RETURN
    COALESCE(v_ticket_facturacion, '{}'::jsonb)
    || jsonb_build_object(
      'message', 'Venta creada exitosamente.',
      'id_factura', v_id_factura,
      'id_pedido', v_id_pedido,
      'numero_venta', v_correlativo->>'codigo',
      'codigo_venta', v_correlativo->>'codigo',
      'fecha', v_fecha_hora_facturacion,
      'fecha_operacion', COALESCE((v_correlativo->>'fecha_operacion')::date, v_fecha_operacion),
      'fecha_hora_pedido', v_fecha_hora_pedido,
      'fecha_hora_facturacion', v_fecha_hora_facturacion,
      'id_sucursal', (v_factura->>'id_sucursal')::integer,
      'nombre_sucursal', v_context.nombre_sucursal,
      'id_cliente', NULLIF(v_factura->>'id_cliente', '')::integer,
      'cliente_nombre', COALESCE(v_context.cliente_nombre, 'Consumidor final'),
      'cliente_rtn', v_context.cliente_rtn,
      'id_usuario', (v_factura->>'id_usuario')::integer,
      'nombre_usuario', v_context.nombre_usuario,
      'id_caja', (v_factura->>'id_caja')::integer,
      'nombre_caja', v_context.nombre_caja,
      'codigo_caja', v_context.codigo_caja,
      'id_sesion_caja', (v_factura->>'id_sesion_caja')::integer
    )
    || jsonb_build_object(
      'metodo_pago', v_venta->>'metodo_pago',
      'metodo_pago_codigo', v_venta->>'metodo_pago_codigo',
      'codigo_transaccion', NULLIF(v_venta->>'referencia_pago', ''),
      'referencia', NULLIF(v_venta->>'referencia_pago', ''),
      'efectivo_entregado', NULLIF(v_venta->>'efectivo_entregado', '')::numeric,
      'cambio', COALESCE((v_venta->>'cambio')::numeric, 0),
      'sub_total', COALESCE((v_venta->>'subtotal')::numeric, 0),
      'subtotal', COALESCE((v_venta->>'subtotal')::numeric, 0),
      'descuento_total', COALESCE((v_venta->>'descuento')::numeric, 0),
      'descuento', COALESCE((v_venta->>'descuento')::numeric, 0),
      'isv', COALESCE((v_venta->>'isv')::numeric, 0),
      'impuesto', COALESCE((v_venta->>'isv')::numeric, 0),
      'isv_15', COALESCE((v_venta->>'isv')::numeric, 0),
      'isv_18', 0,
      'total_isv', COALESCE((v_venta->>'isv')::numeric, 0),
      'gravado_15', COALESCE((v_venta->>'subtotal')::numeric, 0),
      'gravado_18', 0,
      'exento', 0,
      'exonerado', NULL,
      'total', COALESCE((v_venta->>'total')::numeric, 0),
      'total_items', v_total_items,
      'estado_pedido', 'EN_COCINA',
      'venta_directa', false,
      'ticket_ready', v_ticket_ready
    )
    || jsonb_build_object(
      'cliente', jsonb_build_object(
        'id_cliente', NULLIF(v_factura->>'id_cliente', '')::integer,
        'nombre', COALESCE(v_context.cliente_nombre, 'Consumidor final'),
        'rtn', v_context.cliente_rtn
      ),
      'caja', jsonb_build_object(
        'id_caja', (v_factura->>'id_caja')::integer,
        'nombre_caja', v_context.nombre_caja,
        'codigo_caja', v_context.codigo_caja,
        'id_sesion_caja', (v_factura->>'id_sesion_caja')::integer
      ),
      'sucursal', jsonb_build_object(
        'id_sucursal', (v_factura->>'id_sucursal')::integer,
        'nombre_sucursal', v_context.nombre_sucursal
      ),
      'pedido', jsonb_build_object(
        'id_pedido', v_id_pedido,
        'descripcion_pedido', v_pedido->>'descripcion_pedido',
        'descripcion_envio', v_pedido->>'descripcion_envio',
        'estado_pedido', 'EN_COCINA'
      ),
      'pagos', jsonb_build_array(
        jsonb_build_object(
          'metodo_pago', v_venta->>'metodo_pago',
          'metodo_pago_codigo', v_venta->>'metodo_pago_codigo',
          'monto', COALESCE((v_venta->>'total')::numeric, 0),
          'referencia', NULLIF(v_venta->>'referencia_pago', '')
        )
      ),
      'items', v_items_response,
      'fidelizacion', NULL
    );
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_venta_pos_v1(jsonb, jsonb) FROM PUBLIC;

