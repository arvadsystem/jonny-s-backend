BEGIN;

CREATE OR REPLACE FUNCTION public.fn_mov_inv_trace_reversion_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_original public.movimientos_inventario%ROWTYPE;
  v_returned numeric(18,6);
BEGIN
  IF NEW.tipo = 'SALIDA'
     AND NEW.ref_origen IN ('PEDIDO', 'FALTANTE_COCINA') THEN
    IF NEW.id_ref IS NULL
       OR NEW.id_detalle_pedido IS NULL
       OR NEW.origen_consumo IS NULL
       OR NEW.origen_consumo NOT IN ('PRODUCTO', 'RECETA', 'EXTRA', 'SALSA')
       OR NEW.id_pedido_trazabilidad IS NULL
       OR NEW.id_pedido_trazabilidad <> NEW.id_ref
       OR (NEW.id_producto IS NULL AND NEW.id_insumo IS NULL)
       OR (NEW.id_producto IS NOT NULL AND NEW.id_insumo IS NOT NULL) THEN
      RAISE EXCEPTION 'TRACE_INVALID: salida de pedido requiere trazabilidad completa'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.tipo = 'ENTRADA'
     AND NEW.ref_origen = 'REVERSION_VENTA_INVENTARIO' THEN
    IF NEW.id_movimiento_origen IS NULL
       OR NEW.id_detalle_pedido IS NULL
       OR NEW.origen_consumo IS NULL
       OR (NEW.id_producto IS NULL AND NEW.id_insumo IS NULL)
       OR (NEW.id_producto IS NOT NULL AND NEW.id_insumo IS NOT NULL) THEN
      RAISE EXCEPTION 'REVERSION_TRACE_INVALID: entrada de reversión requiere movimiento origen y trazabilidad'
        USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO v_original
    FROM public.movimientos_inventario
    WHERE id_movimiento = NEW.id_movimiento_origen
      AND tipo = 'SALIDA'
      AND ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'REVERSION_TRACE_INVALID: movimiento origen inválido'
        USING ERRCODE = '23503';
    END IF;

    IF v_original.id_detalle_pedido IS NULL THEN
      RAISE EXCEPTION 'LEGACY_PARTIAL_BLOCKED: movimientos legacy solo admiten reversión total controlada'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.id_detalle_pedido <> v_original.id_detalle_pedido
       OR NEW.origen_consumo <> v_original.origen_consumo
       OR COALESCE(NEW.id_producto, 0) <> COALESCE(v_original.id_producto, 0)
       OR COALESCE(NEW.id_insumo, 0) <> COALESCE(v_original.id_insumo, 0)
       OR NEW.id_almacen <> v_original.id_almacen THEN
      RAISE EXCEPTION 'REVERSION_TRACE_INVALID: la entrada no coincide con la salida original'
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM(cantidad), 0)::numeric(18,6)
      INTO v_returned
    FROM public.movimientos_inventario
    WHERE tipo = 'ENTRADA'
      AND ref_origen = 'REVERSION_VENTA_INVENTARIO'
      AND id_movimiento_origen = NEW.id_movimiento_origen
      AND id_movimiento <> COALESCE(NEW.id_movimiento, -1);

    IF v_returned >= v_original.cantidad THEN
      RAISE EXCEPTION 'REVERSION_ALREADY_FULLY_RETURNED: movimiento origen agotado'
        USING ERRCODE = '23514';
    END IF;

    IF v_returned + NEW.cantidad > v_original.cantidad THEN
      RAISE EXCEPTION 'REVERSION_OVER_RETURN: la reversión excede la salida original'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_00_mov_inv_trace_reversion_guard ON public.movimientos_inventario;
CREATE TRIGGER tr_00_mov_inv_trace_reversion_guard
BEFORE INSERT OR UPDATE ON public.movimientos_inventario
FOR EACH ROW
EXECUTE FUNCTION public.fn_mov_inv_trace_reversion_guard();

ALTER TABLE public.movimientos_inventario
  DROP CONSTRAINT IF EXISTS ck_mov_inv_trace_transition_consistent,
  ADD CONSTRAINT ck_mov_inv_trace_transition_consistent
  CHECK (
    tipo <> 'SALIDA'
    OR ref_origen NOT IN ('PEDIDO', 'FALTANTE_COCINA')
    OR (
      id_ref IS NOT NULL
      AND id_pedido_trazabilidad = id_ref
      AND id_detalle_pedido IS NOT NULL
      AND origen_consumo IN ('PRODUCTO', 'RECETA', 'EXTRA', 'SALSA')
      AND ((id_producto IS NULL) <> (id_insumo IS NULL))
    )
  );

ALTER TABLE public.movimientos_inventario
  DROP CONSTRAINT IF EXISTS ck_mov_inv_reversion_trace_complete,
  ADD CONSTRAINT ck_mov_inv_reversion_trace_complete
  CHECK (
    ref_origen <> 'REVERSION_VENTA_INVENTARIO'
    OR (
      tipo = 'ENTRADA'
      AND id_movimiento_origen IS NOT NULL
      AND id_detalle_pedido IS NOT NULL
      AND origen_consumo IN ('PRODUCTO', 'RECETA', 'EXTRA', 'SALSA')
      AND ((id_producto IS NULL) <> (id_insumo IS NULL))
    )
  );

COMMENT ON FUNCTION public.fn_mov_inv_trace_reversion_guard() IS
  'QA trace guard: bloquea salidas legacy nuevas, exige trazabilidad completa y evita sobredevoluciones concurrentes.';

COMMIT;
