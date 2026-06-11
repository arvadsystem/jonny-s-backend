-- Microfase 3B - Inventario de insumos maestros por sucursal.
-- Archivo para revision manual. No ejecutar automaticamente.

BEGIN;

ALTER TABLE public.insumos_almacenes
  DROP CONSTRAINT IF EXISTS chk_insumos_almacenes_cantidad_no_negativa;

CREATE OR REPLACE FUNCTION public.fn_mov_inv_apply_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_stock_actual numeric(14,4);
  v_stock_nuevo numeric(14,4);
  v_item_almacen integer;
  v_ref_origen text;
  v_allow_negative boolean := false;
  v_id_insumo_original integer;
  v_id_insumo_maestro integer;
  v_id_insumo_legacy integer;
  v_mapping_count integer := 0;
  v_has_insumo_mapping boolean := false;
BEGIN
  IF (NEW.id_producto IS NULL AND NEW.id_insumo IS NULL)
     OR (NEW.id_producto IS NOT NULL AND NEW.id_insumo IS NOT NULL) THEN
    RAISE EXCEPTION 'Debe especificar SOLO id_producto o SOLO id_insumo';
  END IF;

  IF NEW.tipo NOT IN ('ENTRADA','SALIDA','AJUSTE') THEN
    RAISE EXCEPTION 'Tipo invalido: %', NEW.tipo;
  END IF;

  IF NEW.cantidad IS NULL OR NEW.cantidad < 0 THEN
    RAISE EXCEPTION 'Cantidad invalida (debe ser >= 0)';
  END IF;

  v_ref_origen := UPPER(TRIM(COALESCE(NEW.ref_origen, '')));

  IF NEW.id_producto IS NOT NULL THEN
    SELECT cantidad, id_almacen
      INTO v_stock_actual, v_item_almacen
    FROM public.productos
    WHERE id_producto = NEW.id_producto
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % no existe', NEW.id_producto;
    END IF;
  ELSE
    v_id_insumo_original := NEW.id_insumo;

    SELECT
      COUNT(*)::integer,
      MIN(mm.id_insumo_maestro)::integer,
      MIN(mm.id_insumo_legacy)::integer
      INTO v_mapping_count, v_id_insumo_maestro, v_id_insumo_legacy
    FROM public.insumos_mapeo_maestro mm
    WHERE mm.id_almacen_origen = NEW.id_almacen
      AND (
        mm.id_insumo_maestro = v_id_insumo_original
        OR mm.id_insumo_legacy = v_id_insumo_original
      );

    IF v_mapping_count = 1 THEN
      v_has_insumo_mapping := true;
      NEW.id_insumo := v_id_insumo_maestro;

      SELECT ia.cantidad, ia.id_almacen
        INTO v_stock_actual, v_item_almacen
      FROM public.insumos_almacenes ia
      WHERE ia.id_insumo = v_id_insumo_maestro
        AND ia.id_almacen = NEW.id_almacen
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Insumo maestro % no tiene stock local en almacen %',
          v_id_insumo_maestro, NEW.id_almacen;
      END IF;
    ELSIF v_mapping_count > 1 THEN
      RAISE EXCEPTION 'Insumo % tiene mas de una equivalencia para el almacen %',
        NEW.id_insumo, NEW.id_almacen;
    ELSE
      SELECT cantidad, id_almacen
        INTO v_stock_actual, v_item_almacen
      FROM public.insumos
      WHERE id_insumo = NEW.id_insumo
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Insumo % no existe', NEW.id_insumo;
      END IF;
    END IF;
  END IF;

  IF v_item_almacen IS NULL THEN
    RAISE EXCEPTION 'El item no tiene id_almacen asignado';
  END IF;

  IF v_item_almacen <> NEW.id_almacen THEN
    RAISE EXCEPTION 'El item pertenece al almacen %, pero el movimiento indica almacen %',
      v_item_almacen, NEW.id_almacen;
  END IF;

  IF NEW.tipo = 'AJUSTE' THEN
    IF NEW.cantidad < 0 THEN
      RAISE EXCEPTION 'La existencia final debe ser mayor o igual a 0';
    END IF;
  ELSE
    IF NEW.cantidad <= 0 THEN
      RAISE EXCEPTION 'La cantidad debe ser mayor que 0';
    END IF;
  END IF;

  IF NEW.tipo = 'ENTRADA' THEN
    v_stock_nuevo := v_stock_actual + NEW.cantidad;

  ELSIF NEW.tipo = 'SALIDA' THEN
    v_allow_negative := v_ref_origen = 'FALTANTE_COCINA';

    IF NOT v_allow_negative
       AND v_ref_origen = 'PEDIDO'
       AND NEW.id_ref IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.pedidos p
        INNER JOIN public.estados_pedido ep
          ON ep.id_estado_pedido = p.id_estado_pedido
        WHERE p.id_pedido = NEW.id_ref
          AND REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') = 'EN_COCINA'
      )
      INTO v_allow_negative;
    END IF;

    IF v_stock_actual < NEW.cantidad AND NOT v_allow_negative THEN
      RAISE EXCEPTION 'Stock insuficiente. Stock actual %, salida %', v_stock_actual, NEW.cantidad;
    END IF;
    v_stock_nuevo := v_stock_actual - NEW.cantidad;

  ELSE
    v_stock_nuevo := NEW.cantidad;
  END IF;

  NEW.saldo_antes := v_stock_actual;
  NEW.saldo_despues := v_stock_nuevo;

  IF NEW.id_producto IS NOT NULL THEN
    UPDATE public.productos
       SET cantidad = v_stock_nuevo
     WHERE id_producto = NEW.id_producto;
  ELSIF v_has_insumo_mapping THEN
    UPDATE public.insumos_almacenes
       SET cantidad = v_stock_nuevo,
           fecha_actualizacion = now()
     WHERE id_insumo = v_id_insumo_maestro
       AND id_almacen = NEW.id_almacen;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se pudo actualizar stock local del insumo maestro % en almacen %',
        v_id_insumo_maestro, NEW.id_almacen;
    END IF;

    UPDATE public.insumos
       SET cantidad = v_stock_nuevo
     WHERE id_insumo = v_id_insumo_legacy;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se pudo sincronizar stock heredado del insumo %',
        v_id_insumo_legacy;
    END IF;
  ELSE
    UPDATE public.insumos
       SET cantidad = v_stock_nuevo
     WHERE id_insumo = NEW.id_insumo;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
