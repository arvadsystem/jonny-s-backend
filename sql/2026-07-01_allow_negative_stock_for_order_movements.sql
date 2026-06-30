-- Versiona la politica de stock negativo para movimientos de pedido.
-- No ejecutar automaticamente. Migracion idempotente.
--
-- Documenta la correccion aplicada en QA:
-- - fn_mov_inv_apply_stock() permite saldo negativo para PEDIDO y FALTANTE_COCINA.
-- - Origenes arbitrarios siguen bloqueando stock insuficiente.
-- - Elimina solo chk_productos_almacenes_cantidad_nonnegative si existe.
-- - No modifica saldos historicos.

DO $$
BEGIN
  IF to_regclass('public.movimientos_inventario') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.movimientos_inventario no existe.';
  END IF;
  IF to_regclass('public.productos') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.productos no existe.';
  END IF;
  IF to_regclass('public.insumos') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.insumos no existe.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_mov_inv_apply_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_stock_actual numeric(14,4);
  v_stock_nuevo  numeric(14,4);
  v_item_almacen integer;
  v_ref_origen text;
  v_allow_negative boolean := false;
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
  v_allow_negative := NEW.tipo = 'SALIDA' AND v_ref_origen IN ('PEDIDO', 'FALTANTE_COCINA');

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
    SELECT cantidad, id_almacen
      INTO v_stock_actual, v_item_almacen
    FROM public.insumos
    WHERE id_insumo = NEW.id_insumo
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insumo % no existe', NEW.id_insumo;
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
    v_stock_nuevo := NEW.cantidad;
  ELSIF NEW.tipo = 'ENTRADA' THEN
    IF NEW.cantidad <= 0 THEN
      RAISE EXCEPTION 'La cantidad debe ser mayor que 0';
    END IF;
    v_stock_nuevo := v_stock_actual + NEW.cantidad;
  ELSE
    IF NEW.cantidad <= 0 THEN
      RAISE EXCEPTION 'La cantidad debe ser mayor que 0';
    END IF;
    IF v_stock_actual < NEW.cantidad AND NOT v_allow_negative THEN
      RAISE EXCEPTION 'Stock insuficiente. Stock actual %, salida %', v_stock_actual, NEW.cantidad;
    END IF;
    v_stock_nuevo := v_stock_actual - NEW.cantidad;
  END IF;

  NEW.saldo_antes := v_stock_actual;
  NEW.saldo_despues := v_stock_nuevo;

  IF NEW.id_producto IS NOT NULL THEN
    UPDATE public.productos
       SET cantidad = v_stock_nuevo
     WHERE id_producto = NEW.id_producto;
  ELSE
    UPDATE public.insumos
       SET cantidad = v_stock_nuevo
     WHERE id_insumo = NEW.id_insumo;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER TABLE IF EXISTS public.productos_almacenes
  DROP CONSTRAINT IF EXISTS chk_productos_almacenes_cantidad_nonnegative;

COMMENT ON FUNCTION public.fn_mov_inv_apply_stock() IS
  'Permite stock negativo solo para SALIDA con ref_origen PEDIDO o FALTANTE_COCINA; mantiene bloqueo para origenes no autorizados.';
