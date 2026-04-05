BEGIN;

-- AM: endurece pivotes a mono-almacen real por item y elimina filas extra heredadas.
DO $$
BEGIN
  IF to_regclass('public.productos_almacenes') IS NOT NULL THEN
    WITH ranked AS (
      SELECT
        pa.ctid AS row_id,
        ROW_NUMBER() OVER (
          PARTITION BY pa.id_producto
          ORDER BY
            CASE WHEN p.id_almacen IS NOT NULL AND pa.id_almacen = p.id_almacen THEN 0 ELSE 1 END,
            pa.fecha_asignacion ASC,
            pa.id_almacen ASC
        ) AS rn
      FROM public.productos_almacenes pa
      LEFT JOIN public.productos p ON p.id_producto = pa.id_producto
    )
    DELETE FROM public.productos_almacenes pa
    USING ranked r
    WHERE pa.ctid = r.row_id
      AND r.rn > 1;

    INSERT INTO public.productos_almacenes (id_producto, id_almacen)
    SELECT p.id_producto, p.id_almacen
    FROM public.productos p
    WHERE p.id_almacen IS NOT NULL
    ON CONFLICT (id_producto, id_almacen) DO NOTHING;

    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_productos_almacenes_id_producto ON public.productos_almacenes (id_producto)';
  END IF;
END $$;

-- AM: endurece pivotes de insumos a 1 almacen real por item con deduplicacion defensiva.
DO $$
BEGIN
  IF to_regclass('public.insumos_almacenes') IS NOT NULL THEN
    WITH ranked AS (
      SELECT
        ia.ctid AS row_id,
        ROW_NUMBER() OVER (
          PARTITION BY ia.id_insumo
          ORDER BY
            CASE WHEN i.id_almacen IS NOT NULL AND ia.id_almacen = i.id_almacen THEN 0 ELSE 1 END,
            ia.fecha_asignacion ASC,
            ia.id_almacen ASC
        ) AS rn
      FROM public.insumos_almacenes ia
      LEFT JOIN public.insumos i ON i.id_insumo = ia.id_insumo
    )
    DELETE FROM public.insumos_almacenes ia
    USING ranked r
    WHERE ia.ctid = r.row_id
      AND r.rn > 1;

    INSERT INTO public.insumos_almacenes (id_insumo, id_almacen)
    SELECT i.id_insumo, i.id_almacen
    FROM public.insumos i
    WHERE i.id_almacen IS NOT NULL
    ON CONFLICT (id_insumo, id_almacen) DO NOTHING;

    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_insumos_almacenes_id_insumo ON public.insumos_almacenes (id_insumo)';
  END IF;
END $$;

-- AM: validador central para bloquear incoherencias entre almacen destino en OC/compra y almacen real del item.
CREATE OR REPLACE FUNCTION public.fn_oc_validate_item_almacen_destino()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_tipo text;
  v_id_item integer;
  v_id_almacen_actual integer;
  v_id_almacen_destino integer;
  v_id_detalle integer;
BEGIN
  v_id_almacen_destino := NEW.id_almacen_destino;

  IF NEW.id_producto IS NOT NULL THEN
    v_item_tipo := 'producto';
    v_id_item := NEW.id_producto;
    SELECT p.id_almacen
    INTO v_id_almacen_actual
    FROM public.productos p
    WHERE p.id_producto = NEW.id_producto
    LIMIT 1;
  ELSIF NEW.id_insumo IS NOT NULL THEN
    v_item_tipo := 'insumo';
    v_id_item := NEW.id_insumo;
    SELECT i.id_almacen
    INTO v_id_almacen_actual
    FROM public.insumos i
    WHERE i.id_insumo = NEW.id_insumo
    LIMIT 1;
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

  IF v_id_almacen_destino IS NOT NULL
     AND v_id_almacen_actual IS NOT NULL
     AND v_id_almacen_destino <> v_id_almacen_actual THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0001',
        MESSAGE = 'WAREHOUSE_ITEM_MISMATCH',
        DETAIL = format(
          'id_detalle=%s item_tipo=%s id_item=%s id_almacen_destino=%s id_almacen_actual=%s',
          COALESCE(v_id_detalle::text, 'NULL'),
          COALESCE(v_item_tipo, 'NULL'),
          COALESCE(v_id_item::text, 'NULL'),
          COALESCE(v_id_almacen_destino::text, 'NULL'),
          COALESCE(v_id_almacen_actual::text, 'NULL')
        );
  END IF;

  RETURN NEW;
END;
$$;

-- AM: aplica validacion en detalle de OC antes de insertar/editar lineas.
DROP TRIGGER IF EXISTS trg_doc_validate_item_almacen_destino ON public.detalle_orden_compras;
CREATE TRIGGER trg_doc_validate_item_almacen_destino
BEFORE INSERT OR UPDATE OF id_producto, id_insumo, id_almacen_destino
ON public.detalle_orden_compras
FOR EACH ROW
EXECUTE FUNCTION public.fn_oc_validate_item_almacen_destino();

-- AM: aplica validacion en detalle de compra para proteger abastecimiento.
DROP TRIGGER IF EXISTS trg_dc_validate_item_almacen_destino ON public.detalle_compras;
CREATE TRIGGER trg_dc_validate_item_almacen_destino
BEFORE INSERT OR UPDATE OF id_producto, id_insumo, id_almacen_destino
ON public.detalle_compras
FOR EACH ROW
EXECUTE FUNCTION public.fn_oc_validate_item_almacen_destino();

COMMIT;
