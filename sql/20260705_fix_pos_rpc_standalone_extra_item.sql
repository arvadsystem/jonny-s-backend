CREATE OR REPLACE FUNCTION public.fn_pos_aplicar_inventario_v1(p_id_pedido integer, p_id_sucursal integer, p_items jsonb, p_line_map jsonb, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_item jsonb;
  v_consumo jsonb;
  v_snapshot jsonb;
  v_config jsonb;
  v_config_extras jsonb;
  v_config_salsas jsonb;
  v_selected_entry jsonb;
  v_selected_inventory jsonb;

  v_line_ref text;
  v_item_index integer;
  v_item_tipo text;
  v_item_id_producto integer;
  v_item_id_receta integer;
  v_item_id_extra integer;
  v_item_cantidad numeric(18,6);
  v_id_detalle_pedido integer;
  v_consumos_count integer;

  v_product_consumptions integer;
  v_recipe_consumptions integer;
  v_extra_consumptions integer;
  v_salsa_consumptions integer;
  v_expected_extras integer;
  v_expected_salsas integer;
  v_distinct_count integer;
  v_recipe_component_count integer;
  v_missing_recipe_component boolean;
  v_duplicate_recipe_group boolean;

  v_origen text;
  v_tipo_recurso text;
  v_id_producto integer;
  v_id_insumo integer;
  v_id_almacen integer;
  v_cantidad numeric(18,6);
  v_id_extra integer;
  v_id_salsa integer;
  v_resolved jsonb;
  v_resolved_id integer;
  v_modo_stock text;

  v_configured_id integer;
  v_configured_qty numeric(18,6);
  v_configured_unit integer;
  v_configured_resolved jsonb;
  v_expected_qty numeric(18,6);
  v_base_qty_per_unit numeric(18,6);
  v_selected_qty numeric(18,6);
  v_entry_count integer;
  v_assignment_count integer;
  v_recipe_match boolean;

  v_snapshot_qty numeric(18,6);
  v_snapshot_resource integer;
  v_snapshot_warehouse integer;
  v_snapshot_entity integer;
  v_snapshot_selected_qty numeric(18,6);

  v_movements jsonb := '[]'::jsonb;
  v_stock record;
  v_stock_actual numeric(18,6);
  v_stock_minimo numeric(18,6);
  v_disponible numeric(18,6);
  v_inserted integer := 0;
  v_product_count integer := 0;
  v_insumo_count integer := 0;
  v_actor_user integer;
BEGIN
  IF p_id_pedido IS NULL OR p_id_pedido <= 0
     OR p_id_sucursal IS NULL OR p_id_sucursal <= 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'POS_RPC_PEDIDO_INVALIDO';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0
     OR p_line_map IS NULL OR jsonb_typeof(p_line_map) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'POS_RPC_ITEMS_REQUERIDOS';
  END IF;

  v_actor_user := NULLIF(p_actor->>'id_usuario', '')::integer;
  IF v_actor_user IS NULL OR v_actor_user <= 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'POS_RPC_ACTOR_SCOPE_MISMATCH';
  END IF;

  PERFORM 1
  FROM public.pedidos p
  WHERE p.id_pedido = p_id_pedido
    AND p.id_sucursal = p_id_sucursal;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'POS_RPC_PEDIDO_INVALIDO',
      DETAIL = format('id_pedido=%s; id_sucursal=%s', p_id_pedido, p_id_sucursal);
  END IF;

  PERFORM pg_advisory_xact_lock(8152030, p_id_pedido);

  PERFORM 1
  FROM public.movimientos_inventario mi
  WHERE mi.id_ref = p_id_pedido
    AND upper(btrim(COALESCE(mi.ref_origen, ''))) IN ('PEDIDO', 'FALTANTE_COCINA')
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'POS_RPC_INVENTARIO_YA_PROCESADO',
      DETAIL = format('id_pedido=%s', p_id_pedido);
  END IF;

  FOR v_item IN
    SELECT item.value
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, ordinality)
    ORDER BY
      CASE
        WHEN NULLIF(item.value->>'item_index', '') ~ '^[0-9]+$'
          THEN (item.value->>'item_index')::integer
        ELSE item.ordinality::integer
      END
  LOOP
    v_line_ref := btrim(COALESCE(v_item->>'line_ref', ''));
    v_item_index := NULLIF(v_item->>'item_index', '')::integer;
    v_item_tipo := upper(btrim(COALESCE(v_item->>'tipo_item', '')));
    v_item_id_producto := NULLIF(v_item->>'id_producto', '')::integer;
    v_item_id_receta := NULLIF(v_item->>'id_receta', '')::integer;
    v_item_id_extra := NULLIF(v_item->>'id_extra', '')::integer;
    v_item_cantidad := NULLIF(v_item->>'cantidad', '')::numeric;
    v_config := CASE WHEN jsonb_typeof(v_item->'configuracion_menu') = 'object'
      THEN v_item->'configuracion_menu' ELSE '{}'::jsonb END;
    v_config_extras := CASE WHEN jsonb_typeof(v_config->'extras') = 'array'
      THEN v_config->'extras' ELSE '[]'::jsonb END;
    v_config_salsas := CASE WHEN jsonb_typeof(v_config->'complementos') = 'array'
      THEN v_config->'complementos' ELSE '[]'::jsonb END;

    v_product_consumptions := 0;
    v_recipe_consumptions := 0;
    v_extra_consumptions := 0;
    v_salsa_consumptions := 0;
    v_expected_extras := jsonb_array_length(v_config_extras);
    v_expected_salsas := jsonb_array_length(v_config_salsas);

    IF v_line_ref = '' OR v_item_index IS NULL OR v_item_index < 0
       OR v_item_cantidad IS NULL OR v_item_cantidad <= 0
       OR v_item_cantidad <> trunc(v_item_cantidad) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'POS_RPC_ITEM_INVALIDO',
        DETAIL = COALESCE(v_item::text, 'NULL');
    END IF;

    IF v_item_tipo NOT IN ('PRODUCTO', 'RECETA', 'ITEM')
       OR ((v_item_id_producto IS NOT NULL)::integer
           + (v_item_id_receta IS NOT NULL)::integer
           + (v_item_id_extra IS NOT NULL)::integer) <> 1
       OR (v_item_tipo = 'PRODUCTO' AND v_item_id_producto IS NULL)
       OR (v_item_tipo = 'RECETA' AND v_item_id_receta IS NULL)
       OR (v_item_tipo = 'ITEM' AND v_item_id_extra IS NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'POS_RPC_ITEM_INVALIDO',
        DETAIL = format('line_ref=%s; tipo_item=%s', v_line_ref, v_item_tipo);
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_config_extras) e(value)
      GROUP BY NULLIF(e.value->>'id_extra', '')::integer
      HAVING COUNT(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_config_salsas) s(value)
      GROUP BY COALESCE(NULLIF(s.value->>'id_salsa', '')::integer, NULLIF(s.value->>'id_complemento', '')::integer)
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'POS_RPC_CONFIGURACION_MENU_DUPLICADA',
        DETAIL = format('line_ref=%s', v_line_ref);
    END IF;

    IF v_item_tipo = 'RECETA' THEN
      PERFORM 1 FROM public.recetas r
      WHERE r.id_receta = v_item_id_receta AND COALESCE(r.estado, true) IS TRUE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001', MESSAGE = 'POS_RPC_RECETA_INVALIDA',
          DETAIL = format('line_ref=%s; id_receta=%s', v_line_ref, v_item_id_receta);
      END IF;
    END IF;

    SELECT (lm.value->>'id_detalle_pedido')::integer
    INTO v_id_detalle_pedido
    FROM jsonb_array_elements(p_line_map) AS lm(value)
    WHERE lm.value->>'line_ref' = v_line_ref
      AND (lm.value->>'item_index')::integer = v_item_index
    LIMIT 1;

    IF v_id_detalle_pedido IS NULL OR v_id_detalle_pedido <= 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'POS_RPC_TRAZABILIDAD_INVALIDA',
        DETAIL = format('line_ref=%s; item_index=%s', v_line_ref, v_item_index);
    END IF;

    PERFORM 1 FROM public.detalle_pedido dp
    WHERE dp.id_pedido = p_id_pedido
      AND dp.id_detalle_pedido = v_id_detalle_pedido
      AND COALESCE(dp.estado, true) IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'POS_RPC_TRAZABILIDAD_INVALIDA',
        DETAIL = format('id_pedido=%s; id_detalle_pedido=%s', p_id_pedido, v_id_detalle_pedido);
    END IF;

    IF jsonb_typeof(v_item->'consumos') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'POS_RPC_CONSUMOS_REQUERIDOS',
        DETAIL = format('line_ref=%s', v_line_ref);
    END IF;
    v_consumos_count := jsonb_array_length(v_item->'consumos');
    IF v_consumos_count = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001', MESSAGE = 'POS_RPC_CONSUMOS_REQUERIDOS',
        DETAIL = format('line_ref=%s', v_line_ref);
    END IF;

    FOR v_consumo IN
      SELECT consumo.value FROM jsonb_array_elements(v_item->'consumos') AS consumo(value)
    LOOP
      v_origen := upper(btrim(COALESCE(v_consumo->>'origen_consumo', '')));
      v_tipo_recurso := lower(btrim(COALESCE(v_consumo->>'tipo_recurso', '')));
      v_id_producto := NULLIF(v_consumo->>'id_producto', '')::integer;
      v_id_insumo := NULLIF(v_consumo->>'id_insumo', '')::integer;
      v_id_almacen := NULLIF(v_consumo->>'id_almacen', '')::integer;
      v_cantidad := NULLIF(v_consumo->>'cantidad', '')::numeric;
      v_id_extra := NULLIF(v_consumo->>'id_extra', '')::integer;
      v_id_salsa := NULLIF(v_consumo->>'id_salsa', '')::integer;
      v_snapshot := COALESCE(v_consumo->'snapshot', '{}'::jsonb);

      IF v_origen NOT IN ('PRODUCTO', 'RECETA', 'EXTRA', 'SALSA')
         OR v_tipo_recurso NOT IN ('producto', 'insumo')
         OR v_id_almacen IS NULL OR v_id_almacen <= 0
         OR v_cantidad IS NULL OR v_cantidad <= 0
         OR ((v_id_producto IS NOT NULL)::integer + (v_id_insumo IS NOT NULL)::integer) <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001', MESSAGE = 'POS_RPC_CONSUMO_INVALIDO',
          DETAIL = format('line_ref=%s; consumo=%s', v_line_ref, v_consumo::text);
      END IF;

      IF (v_tipo_recurso = 'producto' AND (v_origen <> 'PRODUCTO' OR v_id_producto IS NULL))
         OR (v_tipo_recurso = 'insumo' AND (v_origen = 'PRODUCTO' OR v_id_insumo IS NULL)) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001', MESSAGE = 'POS_RPC_ORIGEN_RECURSO_INCOMPATIBLE',
          DETAIL = format('line_ref=%s; origen=%s; tipo=%s', v_line_ref, v_origen, v_tipo_recurso);
      END IF;

      IF v_tipo_recurso = 'producto' THEN
        v_product_consumptions := v_product_consumptions + 1;
        IF v_item_tipo <> 'PRODUCTO'
           OR v_item_id_producto IS NULL
           OR v_id_producto IS DISTINCT FROM v_item_id_producto
           OR abs(v_cantidad - v_item_cantidad) > 0.000001 THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_PRODUCTO_CONSUMO_INCONSISTENTE',
            DETAIL = format('line_ref=%s', v_line_ref);
        END IF;

        v_resolved := public.fn_pos_resolver_producto_inventario_v1(v_id_producto, v_id_almacen, p_id_sucursal);
        v_resolved_id := (v_resolved->>'id_producto')::integer;
        v_modo_stock := v_resolved->>'modo_stock';

        v_movements := v_movements || jsonb_build_array(jsonb_build_object(
          'tipo_recurso', 'producto', 'modo_stock', v_modo_stock,
          'id_producto', v_resolved_id, 'id_insumo', NULL,
          'id_almacen', v_id_almacen, 'cantidad', v_cantidad,
          'id_detalle_pedido', v_id_detalle_pedido,
          'origen_consumo', 'PRODUCTO', 'line_ref', v_line_ref
        ));
        CONTINUE;
      END IF;

      v_resolved := public.fn_pos_resolver_insumo_inventario_v1(v_id_insumo, v_id_almacen, p_id_sucursal);
      v_resolved_id := (v_resolved->>'id_insumo')::integer;
      v_modo_stock := v_resolved->>'modo_stock';

      IF v_origen = 'RECETA' THEN
        v_recipe_consumptions := v_recipe_consumptions + 1;
        IF v_item_tipo <> 'RECETA' OR v_item_id_receta IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_RECETA_CONSUMO_INCONSISTENTE',
            DETAIL = format('line_ref=%s', v_line_ref);
        END IF;

        SELECT COALESCE(SUM(dr.cant), 0)::numeric(18,6) * v_item_cantidad
        INTO v_expected_qty
        FROM public.detalle_recetas dr
        WHERE dr.id_receta = v_item_id_receta
          AND COALESCE(dr.estado, true) IS TRUE
          AND dr.cant > 0
          AND (
            dr.id_insumo = v_id_insumo
            OR dr.id_insumo = v_resolved_id
            OR EXISTS (
              SELECT 1 FROM public.insumos_mapeo_maestro mm
              WHERE mm.id_insumo_legacy = dr.id_insumo
                AND mm.id_almacen_origen = v_id_almacen
                AND mm.id_insumo_maestro = v_resolved_id
                AND upper(btrim(COALESCE(mm.estado_migracion, ''))) = 'VALIDADO'
            )
          );

        IF v_expected_qty IS NULL OR v_expected_qty <= 0
           OR abs(v_expected_qty - v_cantidad) > 0.000001 THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_RECETA_CONSUMO_INCONSISTENTE',
            DETAIL = format('line_ref=%s; esperado=%s; recibido=%s', v_line_ref, COALESCE(v_expected_qty::text,'NULL'), v_cantidad);
        END IF;

      ELSIF v_origen = 'EXTRA' THEN
        v_extra_consumptions := v_extra_consumptions + 1;
        IF v_id_extra IS NULL OR v_id_extra <= 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
            DETAIL = format('line_ref=%s; falta id_extra', v_line_ref);
        END IF;

        IF v_item_tipo = 'ITEM' THEN
          IF v_item_id_extra IS DISTINCT FROM v_id_extra OR v_expected_extras > 1 OR v_expected_salsas <> 0 THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
              DETAIL = format('line_ref=%s; extra independiente inconsistente', v_line_ref);
          END IF;

          IF v_expected_extras = 1 THEN
            SELECT COUNT(*)::integer, (jsonb_agg(e.value)->0)
            INTO v_entry_count, v_selected_entry
            FROM jsonb_array_elements(v_config_extras) e(value)
            WHERE NULLIF(e.value->>'id_extra', '')::integer = v_item_id_extra;

            IF v_entry_count <> 1 THEN
              RAISE EXCEPTION USING
                ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
                DETAIL = format('line_ref=%s; id_extra=%s no coincide con item independiente', v_line_ref, v_item_id_extra);
            END IF;

            IF NULLIF(v_selected_entry->>'cantidad_total', '') IS NOT NULL
               AND abs(NULLIF(v_selected_entry->>'cantidad_total', '')::numeric - v_item_cantidad) > 0.000001 THEN
              RAISE EXCEPTION USING
                ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
                DETAIL = format('line_ref=%s; id_extra=%s; cantidad_total no coincide con item', v_line_ref, v_item_id_extra);
            END IF;
          END IF;

          v_selected_qty := v_item_cantidad;
        ELSIF v_item_tipo = 'RECETA' THEN
          SELECT COUNT(*)::integer, (jsonb_agg(e.value)->0)
          INTO v_entry_count, v_selected_entry
          FROM jsonb_array_elements(v_config_extras) e(value)
          WHERE NULLIF(e.value->>'id_extra', '')::integer = v_id_extra;

          IF v_entry_count <> 1 THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
              DETAIL = format('line_ref=%s; id_extra=%s no seleccionado', v_line_ref, v_id_extra);
          END IF;

          PERFORM 1 FROM public.menu_extra_receta mer
          WHERE mer.id_extra = v_id_extra
            AND mer.id_receta = v_item_id_receta
            AND COALESCE(mer.estado, true) IS TRUE;
          IF NOT FOUND THEN
            RAISE EXCEPTION USING
              ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_NO_PERMITIDO',
              DETAIL = format('line_ref=%s; id_receta=%s; id_extra=%s', v_line_ref, v_item_id_receta, v_id_extra);
          END IF;

          v_selected_qty := COALESCE(
            NULLIF(v_selected_entry->>'cantidad_total', '')::numeric,
            NULLIF(v_selected_entry->>'cantidad', '')::numeric * v_item_cantidad
          );
        ELSE
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_NO_PERMITIDO',
            DETAIL = format('line_ref=%s; tipo_item=%s', v_line_ref, v_item_tipo);
        END IF;

        IF v_selected_qty IS NULL OR v_selected_qty <= 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
            DETAIL = format('line_ref=%s; id_extra=%s; cantidad_total invalida', v_line_ref, v_id_extra);
        END IF;

        SELECT me.id_insumo, me.cant, me.id_unidad_medida
        INTO v_configured_id, v_configured_qty, v_configured_unit
        FROM public.menu_extras me
        WHERE me.id_extra = v_id_extra AND COALESCE(me.estado, true) IS TRUE
        LIMIT 1;

        IF v_configured_id IS NULL OR v_configured_qty IS NULL OR v_configured_qty <= 0 OR v_configured_unit IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
            DETAIL = format('line_ref=%s; id_extra=%s sin inventario valido', v_line_ref, v_id_extra);
        END IF;

        SELECT COUNT(*)::integer INTO v_assignment_count
        FROM public.menu_extra_almacenes mea
        INNER JOIN public.almacenes a ON a.id_almacen = mea.id_almacen
          AND a.id_sucursal = p_id_sucursal AND COALESCE(a.estado, true) IS TRUE
        WHERE mea.id_extra = v_id_extra AND COALESCE(mea.estado, true) IS TRUE;
        IF v_assignment_count = 0 THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_NO_DISPONIBLE_SUCURSAL',
            DETAIL = format('line_ref=%s; id_extra=%s', v_line_ref, v_id_extra);
        END IF;

        v_configured_resolved := public.fn_pos_resolver_insumo_inventario_v1(v_configured_id, v_id_almacen, p_id_sucursal);
        IF (v_configured_resolved->>'id_insumo')::integer IS DISTINCT FROM v_resolved_id THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
            DETAIL = format('line_ref=%s; id_extra=%s; insumo no coincide', v_line_ref, v_id_extra);
        END IF;

        v_base_qty_per_unit := public.fn_pos_convertir_cantidad_base_v1(v_resolved_id, v_configured_qty, v_configured_unit);
        v_expected_qty := v_base_qty_per_unit * v_selected_qty;
        IF abs(v_expected_qty - v_cantidad) > 0.000001 THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001', MESSAGE = 'POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
            DETAIL = format('line_ref=%s; id_extra=%s; esperado=%s; recibido=%s', v_line_ref, v_id_extra, v_expected_qty, v_cantidad);
        END IF;

        IF jsonb_typeof(v_snapshot) <> 'object' THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_EXTRA_SNAPSHOT_INVALIDO';
        END IF;
        v_snapshot_entity := NULLIF(v_snapshot->>'id_extra', '')::integer;
        v_snapshot_resource := NULLIF(v_snapshot->>'id_insumo', '')::integer;
        v_snapshot_warehouse := NULLIF(v_snapshot->>'id_almacen', '')::integer;
        v_snapshot_qty := NULLIF(v_snapshot->>'cantidad_base_total', '')::numeric;
        v_snapshot_selected_qty := NULLIF(v_snapshot->>'cantidad_total', '')::numeric;

        IF v_snapshot_entity IS DISTINCT FROM v_id_extra
           OR v_snapshot_resource IS NULL
           OR v_snapshot_warehouse IS DISTINCT FROM v_id_almacen
           OR v_snapshot_qty IS NULL OR abs(v_snapshot_qty - v_expected_qty) > 0.000001
           OR (v_snapshot_selected_qty IS NOT NULL AND abs(v_snapshot_selected_qty - v_selected_qty) > 0.000001) THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001', MESSAGE='POS_RPC_EXTRA_SNAPSHOT_INVALIDO',
            DETAIL=format('line_ref=%s; id_extra=%s',v_line_ref,v_id_extra);
        END IF;
        v_configured_resolved := public.fn_pos_resolver_insumo_inventario_v1(v_snapshot_resource, v_id_almacen, p_id_sucursal);
        IF (v_configured_resolved->>'id_insumo')::integer IS DISTINCT FROM v_resolved_id THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_EXTRA_SNAPSHOT_INVALIDO';
        END IF;

      ELSIF v_origen = 'SALSA' THEN
        v_salsa_consumptions := v_salsa_consumptions + 1;
        IF v_item_tipo <> 'RECETA' OR v_id_salsa IS NULL OR v_id_salsa <= 0 THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO',
            DETAIL=format('line_ref=%s',v_line_ref);
        END IF;

        SELECT COUNT(*)::integer, (jsonb_agg(s.value)->0)
        INTO v_entry_count, v_selected_entry
        FROM jsonb_array_elements(v_config_salsas) s(value)
        WHERE COALESCE(NULLIF(s.value->>'id_salsa','')::integer, NULLIF(s.value->>'id_complemento','')::integer) = v_id_salsa;
        IF v_entry_count <> 1 THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO',
            DETAIL=format('line_ref=%s; id_salsa=%s no seleccionada',v_line_ref,v_id_salsa);
        END IF;

        PERFORM 1 FROM public.receta_salsa rs
        WHERE rs.id_receta=v_item_id_receta AND rs.id_salsa=v_id_salsa AND COALESCE(rs.estado,true) IS TRUE;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_NO_PERMITIDA',
            DETAIL=format('line_ref=%s; id_receta=%s; id_salsa=%s',v_line_ref,v_item_id_receta,v_id_salsa);
        END IF;

        SELECT s.id_insumo, s.cantidad_porcion, s.id_unidad_consumo
        INTO v_configured_id, v_configured_qty, v_configured_unit
        FROM public.salsas s
        INNER JOIN public.salsa_sucursales ss ON ss.id_salsa=s.id_salsa
          AND ss.id_sucursal=p_id_sucursal AND ss.estado IS TRUE AND ss.publicada IS TRUE
        WHERE s.id_salsa=v_id_salsa AND COALESCE(s.estado,true) IS TRUE
        LIMIT 1;
        IF v_configured_id IS NULL OR v_configured_qty IS NULL OR v_configured_qty <= 0 OR v_configured_unit IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO',
            DETAIL=format('line_ref=%s; id_salsa=%s sin inventario valido',v_line_ref,v_id_salsa);
        END IF;

        v_selected_inventory := CASE WHEN jsonb_typeof(v_selected_entry->'inventario')='object'
          THEN v_selected_entry->'inventario' ELSE '{}'::jsonb END;
        v_selected_qty := COALESCE(
          NULLIF(v_selected_inventory->>'porciones_total','')::numeric,
          NULLIF(v_selected_inventory->>'porciones_por_orden','')::numeric * v_item_cantidad
        );
        IF v_selected_qty IS NULL OR v_selected_qty <= 0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO',
            DETAIL=format('line_ref=%s; id_salsa=%s; porciones invalidas',v_line_ref,v_id_salsa);
        END IF;

        v_configured_resolved := public.fn_pos_resolver_insumo_inventario_v1(v_configured_id, v_id_almacen, p_id_sucursal);
        IF (v_configured_resolved->>'id_insumo')::integer IS DISTINCT FROM v_resolved_id THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO';
        END IF;
        v_base_qty_per_unit := public.fn_pos_convertir_cantidad_base_v1(v_resolved_id, v_configured_qty, v_configured_unit);
        v_expected_qty := v_base_qty_per_unit * v_selected_qty;
        IF abs(v_expected_qty-v_cantidad)>0.000001 THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO',
            DETAIL=format('line_ref=%s; id_salsa=%s; esperado=%s; recibido=%s',v_line_ref,v_id_salsa,v_expected_qty,v_cantidad);
        END IF;

        v_snapshot_entity := NULLIF(v_selected_inventory->>'id_salsa','')::integer;
        v_snapshot_resource := NULLIF(v_selected_inventory->>'id_insumo','')::integer;
        v_snapshot_warehouse := NULLIF(v_selected_inventory->>'id_almacen','')::integer;
        v_snapshot_qty := NULLIF(v_selected_inventory->>'cantidad_base_total','')::numeric;
        IF v_snapshot_entity IS DISTINCT FROM v_id_salsa OR v_snapshot_resource IS NULL
           OR v_snapshot_warehouse IS DISTINCT FROM v_id_almacen
           OR v_snapshot_qty IS NULL OR abs(v_snapshot_qty-v_expected_qty)>0.000001 THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO',
            DETAIL=format('line_ref=%s; id_salsa=%s; configuracion_menu inconsistente',v_line_ref,v_id_salsa);
        END IF;
        v_configured_resolved := public.fn_pos_resolver_insumo_inventario_v1(v_snapshot_resource,v_id_almacen,p_id_sucursal);
        IF (v_configured_resolved->>'id_insumo')::integer IS DISTINCT FROM v_resolved_id THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO';
        END IF;

        IF jsonb_typeof(v_snapshot)<>'object' THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO';
        END IF;
        v_snapshot_entity := NULLIF(v_snapshot->>'id_salsa','')::integer;
        v_snapshot_resource := NULLIF(v_snapshot->>'id_insumo','')::integer;
        v_snapshot_warehouse := NULLIF(v_snapshot->>'id_almacen','')::integer;
        v_snapshot_qty := NULLIF(v_snapshot->>'cantidad_base_total','')::numeric;
        IF v_snapshot_entity IS DISTINCT FROM v_id_salsa OR v_snapshot_resource IS NULL
           OR v_snapshot_warehouse IS DISTINCT FROM v_id_almacen
           OR v_snapshot_qty IS NULL OR abs(v_snapshot_qty-v_expected_qty)>0.000001 THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO';
        END IF;
        v_configured_resolved := public.fn_pos_resolver_insumo_inventario_v1(v_snapshot_resource,v_id_almacen,p_id_sucursal);
        IF (v_configured_resolved->>'id_insumo')::integer IS DISTINCT FROM v_resolved_id THEN
          RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_INVALIDO';
        END IF;
      END IF;

      v_movements := v_movements || jsonb_build_array(jsonb_build_object(
        'tipo_recurso','insumo','modo_stock',v_modo_stock,
        'id_producto',NULL,'id_insumo',v_resolved_id,
        'id_almacen',v_id_almacen,'cantidad',v_cantidad,
        'id_detalle_pedido',v_id_detalle_pedido,
        'origen_consumo',v_origen,'line_ref',v_line_ref
      ));
    END LOOP;

    IF v_item_tipo='PRODUCTO' THEN
      IF v_product_consumptions<>1 OR v_recipe_consumptions<>0 OR v_extra_consumptions<>0 OR v_salsa_consumptions<>0
         OR v_expected_extras<>0 OR v_expected_salsas<>0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_CONSUMOS_INCOMPLETOS', DETAIL=format('line_ref=%s',v_line_ref);
      END IF;
    ELSIF v_item_tipo='ITEM' THEN
      IF v_product_consumptions<>0 OR v_recipe_consumptions<>0 OR v_extra_consumptions<>1 OR v_salsa_consumptions<>0
         OR v_expected_extras>1 OR v_expected_salsas<>0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_CONSUMOS_INCOMPLETOS', DETAIL=format('line_ref=%s',v_line_ref);
      END IF;
    ELSE
      SELECT COUNT(*)::integer INTO v_recipe_component_count
      FROM public.detalle_recetas dr
      WHERE dr.id_receta=v_item_id_receta AND COALESCE(dr.estado,true) IS TRUE AND dr.id_insumo IS NOT NULL AND dr.cant>0;
      IF v_recipe_component_count=0 OR v_product_consumptions<>0 OR v_recipe_consumptions=0
         OR v_extra_consumptions<>v_expected_extras OR v_salsa_consumptions<>v_expected_salsas THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_CONSUMOS_INCOMPLETOS', DETAIL=format('line_ref=%s',v_line_ref);
      END IF;

      SELECT EXISTS(
        SELECT 1
        FROM public.detalle_recetas dr
        WHERE dr.id_receta=v_item_id_receta AND COALESCE(dr.estado,true) IS TRUE AND dr.id_insumo IS NOT NULL AND dr.cant>0
          AND NOT EXISTS(
            SELECT 1
            FROM jsonb_to_recordset(v_movements) AS m(
              tipo_recurso text, modo_stock text, id_producto integer, id_insumo integer,
              id_almacen integer, cantidad numeric, id_detalle_pedido integer,
              origen_consumo text, line_ref text
            )
            WHERE m.id_detalle_pedido=v_id_detalle_pedido AND m.origen_consumo='RECETA'
              AND (
                dr.id_insumo=m.id_insumo
                OR EXISTS(
                  SELECT 1 FROM public.insumos_mapeo_maestro mm
                  WHERE mm.id_insumo_legacy=dr.id_insumo AND mm.id_almacen_origen=m.id_almacen
                    AND mm.id_insumo_maestro=m.id_insumo
                    AND upper(btrim(COALESCE(mm.estado_migracion,'')))='VALIDADO'
                )
              )
          )
      ) INTO v_missing_recipe_component;
      IF v_missing_recipe_component THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_RECETA_CONSUMO_INCOMPLETO', DETAIL=format('line_ref=%s',v_line_ref);
      END IF;

      SELECT EXISTS(
        SELECT 1
        FROM jsonb_to_recordset(v_movements) AS m(
          tipo_recurso text, modo_stock text, id_producto integer, id_insumo integer,
          id_almacen integer, cantidad numeric, id_detalle_pedido integer,
          origen_consumo text, line_ref text
        )
        WHERE m.id_detalle_pedido=v_id_detalle_pedido AND m.origen_consumo='RECETA'
        GROUP BY m.id_insumo,m.id_almacen HAVING COUNT(*)>1
      ) INTO v_duplicate_recipe_group;
      IF v_duplicate_recipe_group THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_RECETA_CONSUMO_DUPLICADO',
          DETAIL=format('line_ref=%s; los componentes equivalentes deben enviarse agregados',v_line_ref);
      END IF;

      SELECT COUNT(DISTINCT NULLIF(c.value->>'id_extra','')::integer)::integer INTO v_distinct_count
      FROM jsonb_array_elements(v_item->'consumos') c(value) WHERE upper(btrim(COALESCE(c.value->>'origen_consumo','')))='EXTRA';
      IF v_distinct_count<>v_extra_consumptions THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_EXTRA_SNAPSHOT_DUPLICADO', DETAIL=format('line_ref=%s',v_line_ref);
      END IF;
      SELECT COUNT(DISTINCT NULLIF(c.value->>'id_salsa','')::integer)::integer INTO v_distinct_count
      FROM jsonb_array_elements(v_item->'consumos') c(value) WHERE upper(btrim(COALESCE(c.value->>'origen_consumo','')))='SALSA';
      IF v_distinct_count<>v_salsa_consumptions THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_SALSA_SNAPSHOT_DUPLICADO', DETAIL=format('line_ref=%s',v_line_ref);
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_movements)=0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_CONSUMOS_REQUERIDOS';
  END IF;

  FOR v_stock IN
    SELECT m.tipo_recurso,m.modo_stock,m.id_producto,m.id_insumo,m.id_almacen,SUM(m.cantidad)::numeric(18,6) requerido
    FROM jsonb_to_recordset(v_movements) AS m(
      tipo_recurso text, modo_stock text, id_producto integer, id_insumo integer,
      id_almacen integer, cantidad numeric, id_detalle_pedido integer,
      origen_consumo text, line_ref text
    )
    GROUP BY m.tipo_recurso,m.modo_stock,m.id_producto,m.id_insumo,m.id_almacen
    ORDER BY CASE WHEN m.tipo_recurso='producto' THEN 1 ELSE 2 END, COALESCE(m.id_producto,m.id_insumo),m.id_almacen
  LOOP
    v_stock_actual:=NULL; v_stock_minimo:=NULL;
    IF v_stock.tipo_recurso='producto' AND v_stock.modo_stock='LOCAL' THEN
      SELECT COALESCE(pa.cantidad,0)::numeric(18,6),COALESCE(pa.stock_minimo,0)::numeric(18,6)
      INTO v_stock_actual,v_stock_minimo FROM public.productos_almacenes pa
      WHERE pa.id_producto=v_stock.id_producto AND pa.id_almacen=v_stock.id_almacen AND COALESCE(pa.estado,true) IS TRUE FOR UPDATE;
    ELSIF v_stock.tipo_recurso='producto' THEN
      SELECT COALESCE(pr.cantidad,0)::numeric(18,6),COALESCE(pr.stock_minimo,0)::numeric(18,6)
      INTO v_stock_actual,v_stock_minimo FROM public.productos pr
      WHERE pr.id_producto=v_stock.id_producto AND pr.id_almacen=v_stock.id_almacen AND COALESCE(pr.estado,true) IS TRUE FOR UPDATE;
    ELSIF v_stock.modo_stock='LOCAL' THEN
      SELECT COALESCE(ia.cantidad,0)::numeric(18,6),COALESCE(ia.stock_minimo,0)::numeric(18,6)
      INTO v_stock_actual,v_stock_minimo FROM public.insumos_almacenes ia
      WHERE ia.id_insumo=v_stock.id_insumo AND ia.id_almacen=v_stock.id_almacen AND COALESCE(ia.estado,true) IS TRUE FOR UPDATE;
    ELSE
      SELECT COALESCE(i.cantidad,0)::numeric(18,6),COALESCE(i.stock_minimo,0)::numeric(18,6)
      INTO v_stock_actual,v_stock_minimo FROM public.insumos i
      WHERE i.id_insumo=v_stock.id_insumo AND i.id_almacen=v_stock.id_almacen AND COALESCE(i.estado,true) IS TRUE FOR UPDATE;
    END IF;

    IF NOT FOUND OR v_stock_actual IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_RECURSO_INVALIDO',
        DETAIL=format('tipo=%s; id=%s; almacen=%s',v_stock.tipo_recurso,COALESCE(v_stock.id_producto,v_stock.id_insumo),v_stock.id_almacen);
    END IF;
    v_disponible:=v_stock_actual-COALESCE(v_stock_minimo,0);
    IF v_disponible<v_stock.requerido THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='POS_RPC_STOCK_INSUFICIENTE',
        DETAIL=format('tipo=%s; id=%s; almacen=%s; requerido=%s; disponible=%s; stock=%s; minimo=%s',
          v_stock.tipo_recurso,COALESCE(v_stock.id_producto,v_stock.id_insumo),v_stock.id_almacen,v_stock.requerido,v_disponible,v_stock_actual,v_stock_minimo);
    END IF;
  END LOOP;

  INSERT INTO public.movimientos_inventario(
    tipo,cantidad,id_almacen,id_producto,id_insumo,id_detalle_pedido,origen_consumo,
    ref_origen,id_ref,id_pedido_trazabilidad,descripcion
  )
  SELECT 'SALIDA',SUM(m.cantidad)::numeric(18,6),m.id_almacen,m.id_producto,m.id_insumo,
    m.id_detalle_pedido,m.origen_consumo,'PEDIDO',p_id_pedido,p_id_pedido,
    format('Descuento RPC por pedido #%s (detalle %s, origen %s, usuario %s)',p_id_pedido,m.id_detalle_pedido,m.origen_consumo,v_actor_user)
  FROM jsonb_to_recordset(v_movements) AS m(
    tipo_recurso text, modo_stock text, id_producto integer, id_insumo integer,
    id_almacen integer, cantidad numeric, id_detalle_pedido integer,
    origen_consumo text, line_ref text
  )
  GROUP BY m.id_almacen,m.id_producto,m.id_insumo,m.id_detalle_pedido,m.origen_consumo
  ORDER BY m.id_detalle_pedido,m.origen_consumo,m.id_almacen,COALESCE(m.id_producto,m.id_insumo);
  GET DIAGNOSTICS v_inserted=ROW_COUNT;

  SELECT COUNT(DISTINCT (m.id_producto,m.id_almacen))::integer INTO v_product_count
  FROM jsonb_to_recordset(v_movements) AS m(
    tipo_recurso text, modo_stock text, id_producto integer, id_insumo integer,
    id_almacen integer, cantidad numeric, id_detalle_pedido integer,
    origen_consumo text, line_ref text
  ) WHERE m.id_producto IS NOT NULL;
  SELECT COUNT(DISTINCT (m.id_insumo,m.id_almacen))::integer INTO v_insumo_count
  FROM jsonb_to_recordset(v_movements) AS m(
    tipo_recurso text, modo_stock text, id_producto integer, id_insumo integer,
    id_almacen integer, cantidad numeric, id_detalle_pedido integer,
    origen_consumo text, line_ref text
  ) WHERE m.id_insumo IS NOT NULL;

  RETURN jsonb_build_object('movimientos_generados',v_inserted,'productos_afectados',COALESCE(v_product_count,0),'insumos_afectados',COALESCE(v_insumo_count,0));
END;
$function$;
