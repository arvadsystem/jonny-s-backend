BEGIN;

CREATE OR REPLACE FUNCTION public.registrar_pedido_pendiente_pos_v1(p_payload jsonb, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id_pedido integer;
  v_line jsonb;
  v_extra jsonb;
  v_id_descuento integer;
  v_id_detalle_pedido integer;
  v_configuracion_menu jsonb;
  v_line_cantidad integer;
  v_modalidad text := NULLIF(TRIM(p_payload->>'modalidad'), '');
  v_total numeric := COALESCE(NULLIF(p_payload->>'total', '')::numeric, 0);
BEGIN
  IF COALESCE(
    CASE
      WHEN jsonb_typeof(p_payload->'pedido_lines') = 'array'
        THEN jsonb_array_length(p_payload->'pedido_lines')
      ELSE 0
    END,
    0
  ) < 1 THEN
    RAISE EXCEPTION 'PEDIDO_PENDIENTE_SIN_LINEAS';
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
    origen_pedido,
    canal,
    estado_pago,
    tipo_entrega,
    visible_en_cocina_at
  )
  VALUES (
    p_payload->>'descripcion_pedido',
    p_payload->>'descripcion_envio',
    (NOW() AT TIME ZONE 'America/Tegucigalpa'),
    COALESCE(NULLIF(p_payload->>'subtotal', '')::numeric, 0),
    COALESCE(NULLIF(p_payload->>'isv', '')::numeric, 0),
    v_total,
    NULLIF(p_payload->>'id_estado_pedido', '')::integer,
    NULLIF(p_payload->>'id_sucursal', '')::integer,
    NULLIF(p_payload->>'id_cliente', '')::integer,
    COALESCE(NULLIF(p_payload->>'id_usuario', '')::integer, NULLIF(p_actor->>'id_usuario', '')::integer),
    'CAJA',
    p_payload->>'canal',
    'PENDIENTE_PAGO',
    v_modalidad,
    (NOW() AT TIME ZONE 'America/Tegucigalpa')
  )
  RETURNING id_pedido INTO v_id_pedido;

  FOR v_line IN
    SELECT line.value
    FROM jsonb_array_elements(COALESCE(p_payload->'pedido_lines', '[]'::jsonb)) WITH ORDINALITY AS line(value, ordinality)
    ORDER BY CASE
      WHEN NULLIF(line.value->>'item_index', '') ~ '^[0-9]+$'
        THEN (line.value->>'item_index')::integer
      ELSE line.ordinality::integer
    END
  LOOP
    v_id_descuento := NULL;
    IF COALESCE(NULLIF(v_line->>'descuento', '')::numeric, 0) > 0 THEN
      INSERT INTO public.descuentos (
        monto_descuento,
        id_descuento_catalogo
      )
      VALUES (
        COALESCE(NULLIF(v_line->>'descuento', '')::numeric, 0),
        NULLIF(v_line->>'id_descuento_catalogo', '')::integer
      )
      RETURNING id_descuento INTO v_id_descuento;
    END IF;

    v_configuracion_menu := CASE
      WHEN jsonb_typeof(v_line->'configuracion_menu') IS NOT NULL
        AND jsonb_typeof(v_line->'configuracion_menu') <> 'null'
      THEN v_line->'configuracion_menu'
      ELSE NULL
    END;

    IF NULLIF(v_line->>'cantidad', '') IS NULL
       OR NULLIF(v_line->>'cantidad', '') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'PEDIDO_LINEA_CANTIDAD_INVALIDA';
    END IF;
    v_line_cantidad := (v_line->>'cantidad')::integer;

    INSERT INTO public.detalle_pedido (
      sub_total_pedido,
      total_pedido,
      id_producto,
      id_pedido,
      id_descuento,
      estado,
      id_combo,
      id_receta,
      cantidad,
      observacion,
      configuracion_menu
    )
    VALUES (
      COALESCE(NULLIF(v_line->>'sub_total', '')::numeric, 0),
      COALESCE(NULLIF(v_line->>'total_linea', '')::numeric, 0),
      NULLIF(v_line->>'id_producto', '')::integer,
      v_id_pedido,
      v_id_descuento,
      true,
      NULLIF(v_line->>'id_combo', '')::integer,
      NULLIF(v_line->>'id_receta', '')::integer,
      v_line_cantidad,
      v_line->>'observacion',
      v_configuracion_menu
    )
    RETURNING id_detalle_pedido INTO v_id_detalle_pedido;

    FOR v_extra IN
      SELECT value
      FROM jsonb_array_elements(COALESCE(v_line->'extras_detalle', '[]'::jsonb))
    LOOP
      INSERT INTO public.detalle_pedido_extras (
        id_detalle_pedido,
        id_extra,
        codigo_extra_snapshot,
        nombre_extra_snapshot,
        cantidad,
        precio_unitario,
        subtotal,
        id_insumo,
        cant,
        id_unidad_medida,
        origen_snapshot
      )
      VALUES (
        v_id_detalle_pedido,
        NULLIF(v_extra->>'id_extra', '')::integer,
        v_extra->>'codigo',
        v_extra->>'nombre',
        COALESCE(NULLIF(v_extra->>'cantidad', '')::numeric, 1)::integer,
        COALESCE(NULLIF(v_extra->>'precio_unitario', '')::numeric, 0),
        COALESCE(NULLIF(v_extra->>'subtotal', '')::numeric, 0),
        NULLIF(v_extra->>'id_insumo', '')::integer,
        COALESCE(NULLIF(v_extra->>'cantidad_insumo', '')::numeric, 0),
        NULLIF(v_extra->>'id_unidad_medida', '')::integer,
        v_extra
      )
      ON CONFLICT (id_detalle_pedido, id_extra)
      DO UPDATE SET
        codigo_extra_snapshot = EXCLUDED.codigo_extra_snapshot,
        nombre_extra_snapshot = EXCLUDED.nombre_extra_snapshot,
        cantidad = EXCLUDED.cantidad,
        precio_unitario = EXCLUDED.precio_unitario,
        subtotal = EXCLUDED.subtotal,
        id_insumo = EXCLUDED.id_insumo,
        cant = EXCLUDED.cant,
        id_unidad_medida = EXCLUDED.id_unidad_medida,
        origen_snapshot = EXCLUDED.origen_snapshot,
        estado = true;
    END LOOP;
  END LOOP;

  INSERT INTO public.pedidos_contexto (
    id_pedido,
    id_canal_pedido,
    id_modalidad_entrega,
    id_usuario_toma,
    id_sesion_caja_origen,
    observacion_contexto
  )
  VALUES (
    v_id_pedido,
    NULLIF(p_payload->>'id_canal_pedido', '')::integer,
    NULLIF(p_payload->>'id_modalidad_entrega', '')::integer,
    COALESCE(NULLIF(p_payload->>'id_usuario', '')::integer, NULLIF(p_actor->>'id_usuario', '')::integer),
    NULLIF(p_payload->>'id_sesion_caja', '')::integer,
    p_payload->>'observacion_contexto'
  );

  INSERT INTO public.pedidos_contacto (
    id_pedido,
    nombre_contacto,
    telefono_contacto,
    telefono_normalizado,
    dni,
    rtn,
    correo
  )
  VALUES (
    v_id_pedido,
    p_payload#>>'{contacto,nombre_contacto}',
    p_payload#>>'{contacto,telefono_contacto}',
    p_payload#>>'{contacto,telefono_normalizado}',
    p_payload#>>'{contacto,dni}',
    p_payload#>>'{contacto,rtn}',
    p_payload#>>'{contacto,correo}'
  );

  INSERT INTO public.pedidos_pago_control (
    id_pedido,
    id_estado_pago_pedido,
    id_motivo_pago_pendiente,
    monto_total,
    monto_pagado,
    monto_pendiente,
    fecha_pago_confirmado,
    id_usuario_confirma_pago,
    id_sesion_caja_pago,
    id_factura,
    observacion_pago
  )
  VALUES (
    v_id_pedido,
    NULLIF(p_payload->>'id_estado_pago_pedido', '')::integer,
    NULLIF(p_payload->>'id_motivo_pago_pendiente', '')::integer,
    v_total,
    0,
    v_total,
    NULL,
    NULL,
    NULL,
    NULL,
    p_payload->>'observacion_pago'
  );

  IF v_modalidad = 'DELIVERY' THEN
    INSERT INTO public.pedidos_delivery (
      id_pedido,
      id_estado_delivery,
      costo_envio,
      nombre_receptor,
      telefono_receptor,
      direccion_entrega,
      referencia_entrega,
      observacion_delivery
    )
    VALUES (
      v_id_pedido,
      NULLIF(p_payload#>>'{delivery,id_estado_delivery}', '')::integer,
      COALESCE(NULLIF(p_payload#>>'{delivery,costo_envio}', '')::numeric, 0),
      p_payload#>>'{delivery,nombre_receptor}',
      p_payload#>>'{delivery,telefono_receptor}',
      p_payload#>>'{delivery,direccion_entrega}',
      p_payload#>>'{delivery,referencia_entrega}',
      p_payload#>>'{delivery,observacion_delivery}'
    );
  END IF;

  RETURN jsonb_build_object(
    'message', 'Pedido pendiente creado correctamente.',
    'id_pedido', v_id_pedido,
    'estado_pago', 'PENDIENTE_PAGO',
    'estado_pedido', 'EN_COCINA',
    'origen_pedido', 'CAJA',
    'canal', p_payload->>'canal',
    'modalidad', v_modalidad,
    'total', v_total,
    'monto_pendiente', v_total,
    'cuenta_dividida', NULL
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_venta_pos_v1(p_payload jsonb, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    IF v_item.cantidad IS NULL
       OR v_item.cantidad <= 0
       OR v_item.cantidad <> trunc(v_item.cantidad) THEN
      RAISE EXCEPTION 'VENTA_LINEA_CANTIDAD_INVALIDA';
    END IF;

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
      cantidad,
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
      v_item.cantidad::integer,
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
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_venta_pos_v2(p_payload jsonb, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamp := timezone('America/Tegucigalpa', now());
  v_pedido jsonb := COALESCE(p_payload->'pedido', '{}'::jsonb);
  v_factura jsonb := COALESCE(p_payload->'factura', '{}'::jsonb);
  v_cobro jsonb := COALESCE(p_payload->'cobro', '{}'::jsonb);
  v_venta jsonb := COALESCE(p_payload->'venta', '{}'::jsonb);
  v_items jsonb := COALESCE(p_payload->'items', '[]'::jsonb);

  v_id_sucursal integer;
  v_id_usuario integer;
  v_id_caja integer;
  v_id_sesion_caja bigint;
  v_id_cliente integer;

  v_config record;
  v_sucursal record;
  v_id_config_facturacion bigint;
  v_prefijo text;
  v_longitud_correlativo integer;
  v_fecha_operacion date;
  v_numero_correlativo integer;
  v_codigo_venta text;
  v_snapshot_fiscal jsonb := '{}'::jsonb;
  v_ticket_facturacion jsonb := '{}'::jsonb;

  v_id_pedido integer;
  v_fecha_hora_pedido timestamp;
  v_id_factura integer;
  v_fecha_hora_facturacion timestamp;
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

  v_id_sucursal := (v_factura->>'id_sucursal')::integer;
  v_id_usuario := (v_factura->>'id_usuario')::integer;
  v_id_caja := (v_factura->>'id_caja')::integer;
  v_id_sesion_caja := (v_factura->>'id_sesion_caja')::bigint;
  v_id_cliente := NULLIF(v_factura->>'id_cliente', '')::integer;

  IF (p_actor->>'id_usuario')::integer IS DISTINCT FROM v_id_usuario
    OR (p_actor->>'id_sucursal')::integer IS DISTINCT FROM v_id_sucursal
    OR (p_actor->>'id_caja')::integer IS DISTINCT FROM v_id_caja
    OR (p_actor->>'id_sesion_caja')::bigint IS DISTINCT FROM v_id_sesion_caja THEN
    RAISE EXCEPTION 'VENTAS_RPC_ACTOR_SCOPE_MISMATCH';
  END IF;

  SELECT
    v.id_sucursal,
    v.nombre_sucursal,
    v.texto_direccion,
    v.texto_telefono,
    v.texto_correo
  INTO v_sucursal
  FROM public.v_sucursales_info v
  WHERE v.id_sucursal = v_id_sucursal
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'FACTURACION_SNAPSHOT_SUCURSAL_NOT_FOUND';
  END IF;

  SELECT
    cfg.id_config,
    cfg.id_sucursal,
    cfg.prefijo_venta,
    cfg.prefijo_reversion,
    cfg.longitud_correlativo,
    cfg.reinicio_diario,
    cfg.modo_fiscal,
    cfg.mostrar_logo_ticket,
    cfg.ancho_ticket_mm,
    cfg.activo,
    cfg.nombre_emisor,
    cfg.rtn_emisor,
    cfg.direccion_emisor,
    cfg.telefono_emisor,
    cfg.correo_emisor,
    cfg.logo_url,
    cfg.id_archivo_logo,
    cfg.texto_encabezado_ticket,
    cfg.texto_pie_ticket,
    cfg.mostrar_rtn,
    cfg.mostrar_direccion,
    cfg.mostrar_telefono,
    cfg.mostrar_correo
  INTO v_config
  FROM public.facturacion_config_sucursal cfg
  WHERE cfg.id_sucursal = v_id_sucursal
  ORDER BY COALESCE(cfg.activo, false) DESC, cfg.id_config DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.facturacion_config_sucursal (
      id_sucursal,
      prefijo_venta,
      prefijo_reversion,
      longitud_correlativo,
      reinicio_diario,
      modo_fiscal,
      mostrar_logo_ticket,
      ancho_ticket_mm,
      activo,
      nombre_emisor,
      rtn_emisor,
      direccion_emisor,
      telefono_emisor,
      correo_emisor,
      logo_url,
      id_archivo_logo,
      texto_encabezado_ticket,
      texto_pie_ticket,
      mostrar_rtn,
      mostrar_direccion,
      mostrar_telefono,
      mostrar_correo
    )
    VALUES (
      v_id_sucursal,
      'VTA',
      'REV',
      5,
      true,
      'INTERNO',
      true,
      80,
      true,
      COALESCE(NULLIF(trim(v_sucursal.nombre_sucursal), ''), 'JONNY''S'),
      NULL,
      NULLIF(trim(v_sucursal.texto_direccion), ''),
      NULLIF(trim(v_sucursal.texto_telefono), ''),
      NULLIF(trim(v_sucursal.texto_correo), ''),
      NULL,
      NULL,
      NULL,
      'Gracias por su compra',
      true,
      true,
      true,
      false
    )
    ON CONFLICT (id_sucursal) DO NOTHING;

    SELECT
      cfg.id_config,
      cfg.id_sucursal,
      cfg.prefijo_venta,
      cfg.prefijo_reversion,
      cfg.longitud_correlativo,
      cfg.reinicio_diario,
      cfg.modo_fiscal,
      cfg.mostrar_logo_ticket,
      cfg.ancho_ticket_mm,
      cfg.activo,
      cfg.nombre_emisor,
      cfg.rtn_emisor,
      cfg.direccion_emisor,
      cfg.telefono_emisor,
      cfg.correo_emisor,
      cfg.logo_url,
      cfg.id_archivo_logo,
      cfg.texto_encabezado_ticket,
      cfg.texto_pie_ticket,
      cfg.mostrar_rtn,
      cfg.mostrar_direccion,
      cfg.mostrar_telefono,
      cfg.mostrar_correo
    INTO v_config
    FROM public.facturacion_config_sucursal cfg
    WHERE cfg.id_sucursal = v_id_sucursal
    ORDER BY COALESCE(cfg.activo, false) DESC, cfg.id_config DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_config.id_config IS NULL THEN
    RAISE EXCEPTION 'FACTURACION_CONFIG_NOT_FOUND';
  END IF;

  v_id_config_facturacion := v_config.id_config;
  v_prefijo := upper(regexp_replace(COALESCE(NULLIF(trim(v_config.prefijo_venta), ''), 'VTA'), '[^A-Za-z0-9_-]', '', 'g'));
  v_prefijo := COALESCE(NULLIF(left(v_prefijo, 10), ''), 'VTA');
  v_longitud_correlativo := LEAST(10, GREATEST(3, COALESCE(v_config.longitud_correlativo::integer, 5)));
  v_fecha_operacion := v_now::date;

  INSERT INTO public.facturacion_correlativos_diarios (
    id_sucursal,
    fecha_operacion,
    tipo_documento,
    prefijo,
    ultimo_numero
  )
  VALUES (
    v_id_sucursal,
    v_fecha_operacion,
    'VENTA',
    v_prefijo,
    1
  )
  ON CONFLICT (id_sucursal, fecha_operacion, tipo_documento)
  DO UPDATE SET
    ultimo_numero = public.facturacion_correlativos_diarios.ultimo_numero + 1,
    prefijo = EXCLUDED.prefijo,
    actualizado_en = NOW()
  RETURNING ultimo_numero
  INTO v_numero_correlativo;

  v_codigo_venta := v_prefijo || '-' || lpad(v_numero_correlativo::text, v_longitud_correlativo, '0');

  v_snapshot_fiscal :=
    jsonb_build_object(
      'version', 1,
      'origen', 'SUCURSALES_FACTURACION',
      'id_config_facturacion', v_id_config_facturacion,
      'id_sucursal', v_id_sucursal,
      'emisor', jsonb_build_object(
        'nombre_emisor', COALESCE(NULLIF(trim(v_config.nombre_emisor), ''), NULLIF(trim(v_sucursal.nombre_sucursal), ''), 'JONNY''S'),
        'rtn_emisor', NULLIF(trim(v_config.rtn_emisor), ''),
        'direccion_emisor', COALESCE(NULLIF(trim(v_config.direccion_emisor), ''), NULLIF(trim(v_sucursal.texto_direccion), '')),
        'telefono_emisor', COALESCE(NULLIF(trim(v_config.telefono_emisor), ''), NULLIF(trim(v_sucursal.texto_telefono), '')),
        'correo_emisor', COALESCE(NULLIF(trim(v_config.correo_emisor), ''), NULLIF(trim(v_sucursal.texto_correo), '')),
        'logo_url', NULLIF(trim(v_config.logo_url), '')
      ),
      'ticket', jsonb_build_object(
        'ancho_ticket_mm', CASE WHEN COALESCE(v_config.ancho_ticket_mm::integer, 80) = 58 THEN 58 ELSE 80 END,
        'mostrar_logo_ticket', COALESCE(v_config.mostrar_logo_ticket, true),
        'mostrar_rtn', COALESCE(v_config.mostrar_rtn, true),
        'mostrar_direccion', COALESCE(v_config.mostrar_direccion, true),
        'mostrar_telefono', COALESCE(v_config.mostrar_telefono, true),
        'mostrar_correo', COALESCE(v_config.mostrar_correo, false),
        'texto_encabezado_ticket', NULLIF(trim(v_config.texto_encabezado_ticket), ''),
        'texto_pie_ticket', COALESCE(NULLIF(trim(v_config.texto_pie_ticket), ''), 'Gracias por su compra')
      )
    )
    || jsonb_build_object(
      'correlativo', jsonb_build_object(
        'prefijo_venta', COALESCE(NULLIF(trim(v_config.prefijo_venta), ''), 'VTA'),
        'prefijo_reversion', COALESCE(NULLIF(trim(v_config.prefijo_reversion), ''), 'REV'),
        'longitud_correlativo', COALESCE(v_config.longitud_correlativo::integer, 5),
        'reinicio_diario', COALESCE(v_config.reinicio_diario, true)
      ),
      'fiscal', jsonb_build_object(
        'modo_fiscal', 'NO_INTEGRADO',
        'cai', '0',
        'numero_factura_fiscal', '0',
        'id_rango_cai', NULL
      ),
      'creado_en', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS')
    );

  v_ticket_facturacion := jsonb_build_object(
    'version', COALESCE((v_snapshot_fiscal->>'version')::integer, 1),
    'origen', COALESCE(v_snapshot_fiscal->>'origen', 'SUCURSALES_FACTURACION'),
    'id_config_facturacion', v_id_config_facturacion,
    'id_rango_cai', NULL,
    'numero_factura_fiscal', '0',
    'facturacion_snapshot', v_snapshot_fiscal,
    'nombre_emisor', v_snapshot_fiscal #>> '{emisor,nombre_emisor}',
    'rtn_emisor', v_snapshot_fiscal #>> '{emisor,rtn_emisor}',
    'direccion_emisor', v_snapshot_fiscal #>> '{emisor,direccion_emisor}',
    'telefono_emisor', v_snapshot_fiscal #>> '{emisor,telefono_emisor}',
    'correo_emisor', v_snapshot_fiscal #>> '{emisor,correo_emisor}',
    'logo_url', v_snapshot_fiscal #>> '{emisor,logo_url}',
    'ancho_ticket_mm', COALESCE((v_snapshot_fiscal #>> '{ticket,ancho_ticket_mm}')::integer, 80),
    'mostrar_logo_ticket', COALESCE((v_snapshot_fiscal #>> '{ticket,mostrar_logo_ticket}')::boolean, true),
    'mostrar_rtn', COALESCE((v_snapshot_fiscal #>> '{ticket,mostrar_rtn}')::boolean, true),
    'mostrar_direccion', COALESCE((v_snapshot_fiscal #>> '{ticket,mostrar_direccion}')::boolean, true),
    'mostrar_telefono', COALESCE((v_snapshot_fiscal #>> '{ticket,mostrar_telefono}')::boolean, true),
    'mostrar_correo', COALESCE((v_snapshot_fiscal #>> '{ticket,mostrar_correo}')::boolean, false),
    'texto_encabezado_ticket', v_snapshot_fiscal #>> '{ticket,texto_encabezado_ticket}',
    'texto_pie_ticket', v_snapshot_fiscal #>> '{ticket,texto_pie_ticket}',
    'modo_fiscal', 'NO_INTEGRADO',
    'cai', '0'
  );

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

    IF v_item.cantidad IS NULL
       OR v_item.cantidad <= 0
       OR v_item.cantidad <> trunc(v_item.cantidad) THEN
      RAISE EXCEPTION 'VENTA_LINEA_CANTIDAD_INVALIDA';
    END IF;

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
      cantidad,
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
      v_item.cantidad::integer,
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
    id_sesion_caja,
    id_config_facturacion,
    id_rango_cai,
    numero_factura_fiscal,
    facturacion_snapshot
  )
  VALUES (
    v_id_caja,
    v_id_pedido,
    v_id_sucursal,
    v_id_usuario,
    v_id_cliente,
    v_codigo_venta,
    v_fecha_operacion,
    NULLIF(v_factura->>'efectivo_entregado', '')::numeric,
    COALESCE((v_factura->>'cambio')::numeric, 0),
    v_now,
    COALESCE((v_factura->>'isv_15')::numeric, 0),
    0,
    v_id_sesion_caja,
    v_id_config_facturacion,
    NULL,
    '0',
    v_snapshot_fiscal
  )
  RETURNING id_factura, fecha_hora_facturacion, fecha_operacion
  INTO v_id_factura, v_fecha_hora_facturacion, v_fecha_operacion;

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
    v_id_sesion_caja,
    v_id_caja,
    v_id_sucursal,
    v_id_usuario,
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
  LEFT JOIN public.clientes c ON c.id_cliente = v_id_cliente
  LEFT JOIN public.personas per ON per.id_persona = c.id_persona
  LEFT JOIN public.empresas emp ON emp.id_empresa = c.id_empresa
  LEFT JOIN public.usuarios u ON u.id_usuario = v_id_usuario
  LEFT JOIN public.cajas cj ON cj.id_caja = v_id_caja
  LEFT JOIN public.sucursales s ON s.id_sucursal = v_id_sucursal;

  v_ticket_ready := v_id_factura > 0
    AND v_id_pedido > 0
    AND jsonb_array_length(v_items_response) > 0;

  RETURN
    COALESCE(v_ticket_facturacion, '{}'::jsonb)
    || jsonb_build_object(
      'message', 'Venta creada exitosamente.',
      'id_factura', v_id_factura,
      'id_pedido', v_id_pedido,
      'numero_venta', v_codigo_venta,
      'codigo_venta', v_codigo_venta,
      'fecha', v_fecha_hora_facturacion,
      'fecha_operacion', v_fecha_operacion,
      'fecha_hora_pedido', v_fecha_hora_pedido,
      'fecha_hora_facturacion', v_fecha_hora_facturacion,
      'id_sucursal', v_id_sucursal,
      'nombre_sucursal', v_context.nombre_sucursal,
      'id_cliente', v_id_cliente,
      'cliente_nombre', COALESCE(v_context.cliente_nombre, 'Consumidor final'),
      'cliente_rtn', v_context.cliente_rtn,
      'id_usuario', v_id_usuario,
      'nombre_usuario', v_context.nombre_usuario,
      'id_caja', v_id_caja,
      'nombre_caja', v_context.nombre_caja,
      'codigo_caja', v_context.codigo_caja,
      'id_sesion_caja', v_id_sesion_caja
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
        'id_cliente', v_id_cliente,
        'nombre', COALESCE(v_context.cliente_nombre, 'Consumidor final'),
        'rtn', v_context.cliente_rtn
      ),
      'caja', jsonb_build_object(
        'id_caja', v_id_caja,
        'nombre_caja', v_context.nombre_caja,
        'codigo_caja', v_context.codigo_caja,
        'id_sesion_caja', v_id_sesion_caja
      ),
      'sucursal', jsonb_build_object(
        'id_sucursal', v_id_sucursal,
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
$function$
;

COMMIT;
