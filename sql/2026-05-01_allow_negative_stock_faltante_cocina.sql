-- Permitir stock negativo auditado solo para faltantes de cocina.
-- Regla: mantener validacion estricta de stock para todos los origenes,
-- excepto cuando ref_origen = 'FALTANTE_COCINA'.

CREATE OR REPLACE FUNCTION public.fn_mov_inv_apply_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_stock_actual integer;
  v_stock_nuevo  integer;
  v_item_almacen integer;
  v_ref_origen text;
BEGIN
  IF (NEW.id_producto IS NULL AND NEW.id_insumo IS NULL)
     OR (NEW.id_producto IS NOT NULL AND NEW.id_insumo IS NOT NULL) THEN
    RAISE EXCEPTION 'Debe especificar SOLO id_producto o SOLO id_insumo';
  END IF;

  IF NEW.tipo NOT IN ('ENTRADA','SALIDA','AJUSTE') THEN
    RAISE EXCEPTION 'Tipo inválido: %', NEW.tipo;
  END IF;

  IF NEW.cantidad IS NULL OR NEW.cantidad < 0 THEN
    RAISE EXCEPTION 'Cantidad inválida (debe ser >= 0)';
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
    RAISE EXCEPTION 'El item pertenece al almacén %, pero el movimiento indica almacén %',
      v_item_almacen, NEW.id_almacen;
  END IF;

  IF NEW.tipo IN ('ENTRADA','SALIDA') AND NEW.cantidad <= 0 THEN
    RAISE EXCEPTION 'Para ENTRADA/SALIDA la cantidad debe ser > 0';
  END IF;

  IF NEW.tipo = 'ENTRADA' THEN
    v_stock_nuevo := v_stock_actual + NEW.cantidad;

  ELSIF NEW.tipo = 'SALIDA' THEN
    IF v_stock_actual < NEW.cantidad AND v_ref_origen <> 'FALTANTE_COCINA' THEN
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
  ELSE
    UPDATE public.insumos
       SET cantidad = v_stock_nuevo
     WHERE id_insumo = NEW.id_insumo;
  END IF;

  RETURN NEW;
END;
$function$;
