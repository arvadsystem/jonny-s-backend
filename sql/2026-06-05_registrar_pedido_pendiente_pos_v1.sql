CREATE OR REPLACE FUNCTION public.registrar_pedido_pendiente_pos_v1(
  p_payload jsonb,
  p_actor jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id_pedido integer;
  v_line jsonb;
  v_extra jsonb;
  v_id_descuento integer;
  v_id_detalle_pedido integer;
  v_configuracion_menu jsonb;
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
      COALESCE(NULLIF(v_line->>'sub_total', '')::numeric, 0),
      COALESCE(NULLIF(v_line->>'total_linea', '')::numeric, 0),
      NULLIF(v_line->>'id_producto', '')::integer,
      v_id_pedido,
      v_id_descuento,
      true,
      NULLIF(v_line->>'id_combo', '')::integer,
      NULLIF(v_line->>'id_receta', '')::integer,
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
$$;
