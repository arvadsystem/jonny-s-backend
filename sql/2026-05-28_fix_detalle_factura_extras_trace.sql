-- Corrige trazabilidad de extras facturados sin duplicar registros.
-- Si origen_snapshot no trae id_detalle_pedido_extra, se infiere desde detalle_facturas.id_detalle_pedido + id_extra.

CREATE OR REPLACE FUNCTION public.fn_sync_detalle_factura_extras_from_origen_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_extras JSONB;
  v_extra JSONB;

  v_id_extra INTEGER;
  v_id_detalle_pedido_extra BIGINT;
  v_cantidad INTEGER;
  v_precio_unitario NUMERIC(12,2);
  v_subtotal NUMERIC(12,2);

  v_codigo TEXT;
  v_nombre TEXT;

  v_id_insumo INTEGER;
  v_cant NUMERIC(12,4);
  v_id_unidad_medida INTEGER;

  v_raw_id_extra TEXT;
  v_raw_id_detalle_pedido_extra TEXT;
  v_raw_cantidad TEXT;
  v_raw_precio TEXT;
  v_raw_subtotal TEXT;
  v_raw_id_insumo TEXT;
  v_raw_cant TEXT;
  v_raw_id_unidad_medida TEXT;
BEGIN
  IF NEW.origen_snapshot IS NULL
     OR jsonb_typeof(NEW.origen_snapshot->'extras') <> 'array' THEN
    DELETE FROM public.detalle_factura_extras
    WHERE id_detalle_factura = NEW.id_detalle_factura;
    RETURN NEW;
  END IF;

  v_extras := NEW.origen_snapshot->'extras';

  DELETE FROM public.detalle_factura_extras dfe
  WHERE dfe.id_detalle_factura = NEW.id_detalle_factura
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_extras) AS item
      WHERE COALESCE(item.value->>'id_extra', item.value->>'id_menu_extra', item.value->>'id', '') ~ '^[0-9]+$'
        AND COALESCE(item.value->>'id_extra', item.value->>'id_menu_extra', item.value->>'id')::INTEGER = dfe.id_extra
    );

  FOR v_extra IN
    SELECT value
    FROM jsonb_array_elements(v_extras)
  LOOP
    v_raw_id_extra := COALESCE(
      v_extra->>'id_extra',
      v_extra->>'id_menu_extra',
      v_extra->>'id'
    );

    IF v_raw_id_extra IS NULL OR v_raw_id_extra !~ '^[0-9]+$' THEN
      CONTINUE;
    END IF;

    v_id_extra := v_raw_id_extra::INTEGER;

    v_raw_id_detalle_pedido_extra := v_extra->>'id_detalle_pedido_extra';
    v_id_detalle_pedido_extra := CASE
      WHEN v_raw_id_detalle_pedido_extra ~ '^[0-9]+$'
        THEN v_raw_id_detalle_pedido_extra::BIGINT
      ELSE NULL
    END;

    IF v_id_detalle_pedido_extra IS NULL AND NEW.id_detalle_pedido IS NOT NULL THEN
      SELECT dpe.id_detalle_pedido_extra
      INTO v_id_detalle_pedido_extra
      FROM public.detalle_pedido_extras dpe
      WHERE dpe.id_detalle_pedido = NEW.id_detalle_pedido
        AND dpe.id_extra = v_id_extra
        AND COALESCE(dpe.estado, true) = true
      ORDER BY dpe.id_detalle_pedido_extra
      LIMIT 1;
    END IF;

    v_raw_cantidad := COALESCE(v_extra->>'cantidad', v_extra->>'qty', '1');
    v_cantidad := CASE
      WHEN v_raw_cantidad ~ '^[0-9]+$' THEN GREATEST(v_raw_cantidad::INTEGER, 1)
      ELSE 1
    END;

    v_raw_precio := COALESCE(
      v_extra->>'precio_unitario',
      v_extra->>'precio_adicional',
      v_extra->>'precio',
      '0'
    );

    v_precio_unitario := CASE
      WHEN v_raw_precio ~ '^[0-9]+(\.[0-9]+)?$' THEN ROUND(v_raw_precio::NUMERIC, 2)
      ELSE 0
    END;

    v_raw_subtotal := COALESCE(v_extra->>'subtotal', v_extra->>'total', NULL);

    v_subtotal := CASE
      WHEN v_raw_subtotal IS NOT NULL AND v_raw_subtotal ~ '^[0-9]+(\.[0-9]+)?$'
        THEN ROUND(v_raw_subtotal::NUMERIC, 2)
      ELSE ROUND((v_precio_unitario * v_cantidad)::NUMERIC, 2)
    END;

    v_codigo := NULLIF(TRIM(COALESCE(v_extra->>'codigo', v_extra->>'codigo_extra', '')), '');

    v_nombre := NULLIF(
      TRIM(
        COALESCE(
          v_extra->>'nombre_extra',
          v_extra->>'nombre',
          v_extra->>'descripcion',
          ''
        )
      ),
      ''
    );

    IF v_nombre IS NULL THEN
      v_nombre := 'Extra';
    END IF;

    v_raw_id_insumo := v_extra->>'id_insumo';
    v_id_insumo := CASE
      WHEN v_raw_id_insumo ~ '^[0-9]+$' THEN v_raw_id_insumo::INTEGER
      ELSE NULL
    END;

    v_raw_cant := v_extra->>'cant';
    v_cant := CASE
      WHEN v_raw_cant ~ '^[0-9]+(\.[0-9]+)?$' THEN v_raw_cant::NUMERIC
      ELSE NULL
    END;

    v_raw_id_unidad_medida := v_extra->>'id_unidad_medida';
    v_id_unidad_medida := CASE
      WHEN v_raw_id_unidad_medida ~ '^[0-9]+$' THEN v_raw_id_unidad_medida::INTEGER
      ELSE NULL
    END;

    INSERT INTO public.detalle_factura_extras (
      id_detalle_factura,
      id_detalle_pedido_extra,
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
      NEW.id_detalle_factura,
      v_id_detalle_pedido_extra,
      v_id_extra,
      v_codigo,
      v_nombre,
      v_cantidad,
      v_precio_unitario,
      v_subtotal,
      v_id_insumo,
      v_cant,
      v_id_unidad_medida,
      v_extra
    )
    ON CONFLICT (id_detalle_factura, id_extra)
    DO UPDATE SET
      id_detalle_pedido_extra = COALESCE(EXCLUDED.id_detalle_pedido_extra, detalle_factura_extras.id_detalle_pedido_extra),
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

  RETURN NEW;
END;
$function$;

UPDATE public.detalle_factura_extras dfe
SET id_detalle_pedido_extra = dpe.id_detalle_pedido_extra
FROM public.detalle_facturas df
JOIN public.detalle_pedido_extras dpe
  ON dpe.id_detalle_pedido = df.id_detalle_pedido
 AND COALESCE(dpe.estado, true) = true
WHERE dfe.id_detalle_factura = df.id_detalle_factura
  AND dfe.id_extra = dpe.id_extra
  AND dfe.id_detalle_pedido_extra IS NULL;
