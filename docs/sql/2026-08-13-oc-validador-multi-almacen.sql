BEGIN;

CREATE OR REPLACE FUNCTION public.fn_oc_validate_item_almacen_destino()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item_tipo text;
  v_id_item_input integer;
  v_id_item_maestro integer;
  v_mapping_count integer := 0;
  v_id_almacen_destino integer;
  v_id_detalle integer;
  v_asignacion_activa boolean := false;
BEGIN
  v_id_almacen_destino := NEW.id_almacen_destino;

  IF v_id_almacen_destino IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.id_producto IS NOT NULL THEN
    v_item_tipo := 'producto';
    v_id_item_input := NEW.id_producto;

    SELECT
      COUNT(DISTINCT pm.id_producto_maestro)::integer,
      MIN(pm.id_producto_maestro)::integer
    INTO v_mapping_count, v_id_item_maestro
    FROM public.productos_mapeo_maestro pm
    WHERE pm.id_producto_legacy = v_id_item_input
       OR pm.id_producto_maestro = v_id_item_input;

    IF v_mapping_count > 1 THEN
      RAISE EXCEPTION
        USING
          ERRCODE = 'P0001',
          MESSAGE = 'WAREHOUSE_ITEM_MISMATCH',
          DETAIL = format(
            'id_detalle=%s item_tipo=%s id_item=%s id_almacen_destino=%s id_almacen_actual=%s',
            'NULL',
            v_item_tipo,
            v_id_item_input,
            v_id_almacen_destino,
            'MAPEO_INCONSISTENTE'
          );
    END IF;

    v_id_item_maestro := COALESCE(v_id_item_maestro, v_id_item_input);

    SELECT EXISTS (
      SELECT 1
      FROM public.productos p
      INNER JOIN public.productos_almacenes pa
        ON pa.id_producto = p.id_producto
      INNER JOIN public.almacenes a
        ON a.id_almacen = pa.id_almacen
      WHERE p.id_producto = v_id_item_maestro
        AND pa.id_almacen = v_id_almacen_destino
        AND COALESCE(p.estado, true) = true
        AND COALESCE(pa.estado, true) = true
        AND COALESCE(a.estado, true) = true
    )
    INTO v_asignacion_activa;

  ELSIF NEW.id_insumo IS NOT NULL THEN
    v_item_tipo := 'insumo';
    v_id_item_input := NEW.id_insumo;

    SELECT
      COUNT(DISTINCT im.id_insumo_maestro)::integer,
      MIN(im.id_insumo_maestro)::integer
    INTO v_mapping_count, v_id_item_maestro
    FROM public.insumos_mapeo_maestro im
    WHERE im.id_insumo_legacy = v_id_item_input
       OR im.id_insumo_maestro = v_id_item_input;

    IF v_mapping_count > 1 THEN
      RAISE EXCEPTION
        USING
          ERRCODE = 'P0001',
          MESSAGE = 'WAREHOUSE_ITEM_MISMATCH',
          DETAIL = format(
            'id_detalle=%s item_tipo=%s id_item=%s id_almacen_destino=%s id_almacen_actual=%s',
            'NULL',
            v_item_tipo,
            v_id_item_input,
            v_id_almacen_destino,
            'MAPEO_INCONSISTENTE'
          );
    END IF;

    v_id_item_maestro := COALESCE(v_id_item_maestro, v_id_item_input);

    SELECT EXISTS (
      SELECT 1
      FROM public.insumos i
      INNER JOIN public.insumos_almacenes ia
        ON ia.id_insumo = i.id_insumo
      INNER JOIN public.almacenes a
        ON a.id_almacen = ia.id_almacen
      WHERE i.id_insumo = v_id_item_maestro
        AND ia.id_almacen = v_id_almacen_destino
        AND COALESCE(i.estado, true) = true
        AND COALESCE(ia.estado, true) = true
        AND COALESCE(a.estado, true) = true
    )
    INTO v_asignacion_activa;

  ELSE
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'detalle_orden_compras' THEN
    v_id_detalle := NEW.id_detalle_orden;
  ELSIF TG_TABLE_NAME = 'detalle_compras' THEN
    v_id_detalle := NEW.id_detalle_compra;
  ELSE
    v_id_detalle := NULL;
  END IF;

  IF NOT COALESCE(v_asignacion_activa, false) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0001',
        MESSAGE = 'WAREHOUSE_ITEM_MISMATCH',
        DETAIL = format(
          'id_detalle=%s item_tipo=%s id_item=%s id_almacen_destino=%s id_almacen_actual=%s',
          COALESCE(v_id_detalle::text, 'NULL'),
          COALESCE(v_item_tipo, 'NULL'),
          COALESCE(v_id_item_input::text, 'NULL'),
          COALESCE(v_id_almacen_destino::text, 'NULL'),
          'NO_ASIGNADO'
        );
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
