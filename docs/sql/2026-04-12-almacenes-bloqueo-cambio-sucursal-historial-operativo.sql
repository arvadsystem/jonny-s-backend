BEGIN;

DROP TRIGGER IF EXISTS trg_almacenes_block_sucursal_change_with_history ON public.almacenes;
DROP FUNCTION IF EXISTS public.fn_almacenes_block_sucursal_change_with_history();

CREATE OR REPLACE FUNCTION public.fn_almacenes_block_sucursal_change_with_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_movimientos_total BIGINT := 0;
  v_open_orders_total BIGINT := 0;
  v_productos_relacionados BIGINT := 0;
  v_insumos_relacionados BIGINT := 0;
  v_stock_productos NUMERIC := 0;
  v_stock_insumos NUMERIC := 0;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.id_sucursal IS NOT DISTINCT FROM OLD.id_sucursal THEN
    RETURN NEW;
  END IF;

  IF OLD.id_almacen IS NULL THEN
    RETURN NEW;
  END IF;

  IF to_regclass('public.movimientos_inventario') IS NOT NULL THEN
    EXECUTE '
      SELECT COUNT(*)
      FROM public.movimientos_inventario m
      WHERE m.id_almacen = $1
    '
      INTO v_movimientos_total
      USING OLD.id_almacen;
  END IF;

  IF COALESCE(v_movimientos_total, 0) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'No se puede cambiar la sucursal de este almacen porque ya registra movimientos de inventario.';
  END IF;

  IF to_regclass('public.productos_almacenes') IS NOT NULL
     AND to_regclass('public.productos') IS NOT NULL THEN
    EXECUTE '
      SELECT
        COUNT(DISTINCT pa.id_producto)::bigint,
        COALESCE(SUM(GREATEST(COALESCE(p.cantidad, 0), 0)::numeric), 0)
      FROM public.productos_almacenes pa
      INNER JOIN public.productos p
        ON p.id_producto = pa.id_producto
      WHERE pa.id_almacen = $1
    '
      INTO v_productos_relacionados, v_stock_productos
      USING OLD.id_almacen;
  ELSIF to_regclass('public.productos') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name = 'productos'
            AND c.column_name = 'id_almacen'
        ) THEN
    EXECUTE '
      SELECT
        COUNT(*)::bigint,
        COALESCE(SUM(GREATEST(COALESCE(p.cantidad, 0), 0)::numeric), 0)
      FROM public.productos p
      WHERE p.id_almacen = $1
    '
      INTO v_productos_relacionados, v_stock_productos
      USING OLD.id_almacen;
  END IF;

  IF to_regclass('public.insumos_almacenes') IS NOT NULL
     AND to_regclass('public.insumos') IS NOT NULL THEN
    EXECUTE '
      SELECT
        COUNT(DISTINCT ia.id_insumo)::bigint,
        COALESCE(SUM(GREATEST(COALESCE(i.cantidad, 0), 0)::numeric), 0)
      FROM public.insumos_almacenes ia
      INNER JOIN public.insumos i
        ON i.id_insumo = ia.id_insumo
      WHERE ia.id_almacen = $1
    '
      INTO v_insumos_relacionados, v_stock_insumos
      USING OLD.id_almacen;
  ELSIF to_regclass('public.insumos') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name = 'insumos'
            AND c.column_name = 'id_almacen'
        ) THEN
    EXECUTE '
      SELECT
        COUNT(*)::bigint,
        COALESCE(SUM(GREATEST(COALESCE(i.cantidad, 0), 0)::numeric), 0)
      FROM public.insumos i
      WHERE i.id_almacen = $1
    '
      INTO v_insumos_relacionados, v_stock_insumos
      USING OLD.id_almacen;
  END IF;

  IF COALESCE(v_stock_productos, 0) + COALESCE(v_stock_insumos, 0) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'No se puede cambiar la sucursal de este almacen porque tiene stock disponible.';
  END IF;

  IF to_regclass('public.detalle_orden_compras') IS NOT NULL
     AND to_regclass('public.orden_compras') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'detalle_orden_compras'
         AND c.column_name = 'id_almacen_destino'
     )
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'orden_compras'
         AND c.column_name = 'estado_flujo'
     ) THEN
    EXECUTE '
      SELECT COUNT(DISTINCT doc.id_orden_compra)::bigint
      FROM public.detalle_orden_compras doc
      INNER JOIN public.orden_compras oc
        ON oc.id_orden_compra = doc.id_orden_compra
      WHERE doc.id_almacen_destino = $1
        AND UPPER(COALESCE(oc.estado_flujo, '''')) IN (''PENDIENTE'', ''APROBADA'', ''EN_COMPRA'')
    '
      INTO v_open_orders_total
      USING OLD.id_almacen;
  END IF;

  IF COALESCE(v_open_orders_total, 0) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'No se puede cambiar la sucursal de este almacen porque tiene ordenes de compra en curso asociadas.';
  END IF;

  IF COALESCE(v_productos_relacionados, 0) > 0 OR COALESCE(v_insumos_relacionados, 0) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'No se puede cambiar la sucursal de este almacen porque mantiene productos o insumos vinculados.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_almacenes_block_sucursal_change_with_history
BEFORE UPDATE OF id_sucursal ON public.almacenes
FOR EACH ROW
EXECUTE FUNCTION public.fn_almacenes_block_sucursal_change_with_history();

COMMIT;
