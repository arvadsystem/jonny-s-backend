BEGIN;

DO $$
DECLARE
  v_max_movimiento_saldo numeric;
  v_max_insumo_stock numeric;
BEGIN
  SELECT COALESCE(MAX(GREATEST(ABS(saldo_antes), ABS(saldo_despues))), 0)
    INTO v_max_movimiento_saldo
  FROM public.movimientos_inventario;

  IF v_max_movimiento_saldo >= 1000000000000 THEN
    RAISE EXCEPTION 'movimientos_inventario.saldos exceden numeric(18,6): %', v_max_movimiento_saldo;
  END IF;

  SELECT COALESCE(MAX(GREATEST(ABS(cantidad), ABS(stock_minimo))), 0)
    INTO v_max_insumo_stock
  FROM public.insumos;

  IF v_max_insumo_stock >= 1000000000000 THEN
    RAISE EXCEPTION 'insumos stock excede numeric(18,6): %', v_max_insumo_stock;
  END IF;
END $$;

DROP VIEW IF EXISTS public.v_kardex_detalle;

ALTER TABLE public.movimientos_inventario
  ALTER COLUMN saldo_antes TYPE numeric(18,6) USING saldo_antes::numeric(18,6),
  ALTER COLUMN saldo_despues TYPE numeric(18,6) USING saldo_despues::numeric(18,6);

ALTER TABLE public.insumos
  ALTER COLUMN cantidad TYPE numeric(18,6) USING cantidad::numeric(18,6),
  ALTER COLUMN stock_minimo TYPE numeric(18,6) USING stock_minimo::numeric(18,6);

DO $$
DECLARE
  v_function_def text;
BEGIN
  SELECT pg_get_functiondef('public.fn_mov_inv_apply_stock()'::regprocedure)
    INTO v_function_def;

  IF v_function_def IS NULL THEN
    RAISE EXCEPTION 'public.fn_mov_inv_apply_stock() no existe';
  END IF;

  v_function_def := replace(v_function_def, 'v_stock_actual numeric(14,4);', 'v_stock_actual numeric(18,6);');
  v_function_def := replace(v_function_def, 'v_stock_nuevo numeric(14,4);', 'v_stock_nuevo numeric(18,6);');
  v_function_def := replace(v_function_def, 'v_stock_actual  numeric(14,4);', 'v_stock_actual numeric(18,6);');
  v_function_def := replace(v_function_def, 'v_stock_nuevo  numeric(14,4);', 'v_stock_nuevo numeric(18,6);');

  IF v_function_def ~ 'v_stock_(actual|nuevo)\s+numeric\(14,4\)' THEN
    RAISE EXCEPTION 'public.fn_mov_inv_apply_stock() conserva variables numeric(14,4)';
  END IF;

  EXECUTE v_function_def;
END $$;

COMMENT ON COLUMN public.movimientos_inventario.saldo_antes IS
  'Saldo fisico previo al movimiento. Usa numeric(18,6) para no truncar consumos fraccionales de inventario.';

COMMENT ON COLUMN public.movimientos_inventario.saldo_despues IS
  'Saldo fisico posterior al movimiento. Usa numeric(18,6) para no truncar consumos fraccionales de inventario.';

COMMENT ON COLUMN public.insumos.cantidad IS
  'Stock fisico legacy del insumo. Usa numeric(18,6) para mantener precision de consumos fraccionales.';

COMMENT ON COLUMN public.insumos.stock_minimo IS
  'Stock minimo fisico legacy del insumo. Usa numeric(18,6) para mantener precision de inventario.';

COMMENT ON FUNCTION public.fn_mov_inv_apply_stock() IS
  'Aplica movimientos de inventario preservando stock fisico con variables numeric(18,6).';

CREATE VIEW public.v_kardex_detalle
WITH (security_invoker = true) AS
 SELECT m.id_movimiento,
    m.fecha_mov,
    m.tipo,
    m.cantidad,
    m.saldo_antes,
    m.saldo_despues,
    m.saldo_antes IS NULL OR m.saldo_despues IS NULL AS es_legacy,
    m.id_almacen,
    a.nombre AS nombre_almacen,
    a.id_sucursal,
    s.nombre_sucursal,
    m.id_producto,
    p.nombre_producto,
    m.id_insumo,
    i.nombre_insumo,
        CASE
            WHEN m.id_producto IS NOT NULL THEN 'Producto'::text
            ELSE 'Insumo'::text
        END AS item_tipo,
        CASE
            WHEN m.id_producto IS NOT NULL THEN m.id_producto
            ELSE m.id_insumo
        END AS item_id,
        CASE
            WHEN m.id_producto IS NOT NULL THEN p.nombre_producto
            ELSE i.nombre_insumo
        END AS item_nombre,
        CASE
            WHEN m.tipo::text = 'ENTRADA'::text THEN m.cantidad
            WHEN m.tipo::text = 'SALIDA'::text THEN - m.cantidad
            ELSE NULL::numeric
        END AS impacto,
    m.ref_origen,
    m.id_ref,
    m.descripcion,
    m.id_detalle_pedido,
    m.origen_consumo,
    m.id_movimiento_origen,
    m.id_pedido_trazabilidad
   FROM public.movimientos_inventario m
     LEFT JOIN public.almacenes a ON a.id_almacen = m.id_almacen
     LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
     LEFT JOIN public.productos p ON p.id_producto = m.id_producto
     LEFT JOIN public.insumos i ON i.id_insumo = m.id_insumo;

REVOKE ALL ON TABLE public.v_kardex_detalle FROM PUBLIC;
REVOKE ALL ON TABLE public.v_kardex_detalle FROM anon;
REVOKE ALL ON TABLE public.v_kardex_detalle FROM authenticated;
GRANT SELECT ON TABLE public.v_kardex_detalle TO service_role;

COMMIT;
