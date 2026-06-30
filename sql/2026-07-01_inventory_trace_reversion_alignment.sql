-- Consolidated inventory trace/reversion alignment.
-- Artifact only: do not execute automatically and do not insert into schema_migrations.
--
-- Mirrors the manually aligned QA state:
-- - id_pedido_trazabilidad is a normal nullable integer column.
-- - PEDIDO and FALTANTE_COCINA share one physical identity for traced SALIDA rows.
-- - Reversion trace guards are present and validated.
-- - fn_mov_inv_apply_stock() is verified only; this migration never replaces it.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_conflicts bigint := 0;
  v_function_oid oid;
  v_function_source text;
  v_generation text;
BEGIN
  IF to_regclass('public.movimientos_inventario') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.movimientos_inventario no existe.';
  END IF;

  IF to_regclass('public.productos_almacenes') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.productos_almacenes no existe.';
  END IF;

  IF to_regclass('public.insumos_almacenes') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.insumos_almacenes no existe.';
  END IF;

  IF to_regclass('public.productos_mapeo_maestro') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.productos_mapeo_maestro no existe.';
  END IF;

  IF to_regclass('public.insumos_mapeo_maestro') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.insumos_mapeo_maestro no existe.';
  END IF;

  SELECT p.oid, pg_get_functiondef(p.oid)
    INTO v_function_oid, v_function_source
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'fn_mov_inv_apply_stock'
  LIMIT 1;

  IF v_function_oid IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.fn_mov_inv_apply_stock() no existe.';
  END IF;

  IF v_function_source !~* 'FALTANTE_COCINA' OR v_function_source !~* 'PEDIDO' THEN
    RAISE EXCEPTION 'Preflight fallido: fn_mov_inv_apply_stock() no documenta PEDIDO/FALTANTE_COCINA.';
  END IF;

  IF v_function_source !~* 'productos_mapeo_maestro'
     OR v_function_source !~* 'productos_almacenes'
     OR v_function_source !~* 'insumos_mapeo_maestro'
     OR v_function_source !~* 'insumos_almacenes' THEN
    RAISE EXCEPTION 'Preflight fallido: fn_mov_inv_apply_stock() no conserva catalogo maestro/tablas por almacen.';
  END IF;

  IF v_function_source !~* 'numeric\(18,6\)' THEN
    RAISE EXCEPTION 'Preflight fallido: fn_mov_inv_apply_stock() no conserva precision numeric(18,6).';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'movimientos_inventario'
      AND NOT t.tgisinternal
      AND pg_get_triggerdef(t.oid) ILIKE '%fn_mov_inv_apply_stock%'
  ) THEN
    RAISE EXCEPTION 'Preflight fallido: trigger de fn_mov_inv_apply_stock() no encontrado.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_mov_inv_trace_reversion_guard'
  ) THEN
    RAISE EXCEPTION 'Preflight fallido: public.fn_mov_inv_trace_reversion_guard() no existe.';
  END IF;

  SELECT COALESCE(c.generation_expression, 'NEVER')
    INTO v_generation
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'movimientos_inventario'
    AND c.column_name = 'id_pedido_trazabilidad'
  LIMIT 1;

  IF v_generation IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: id_pedido_trazabilidad no existe.';
  END IF;

  IF v_generation <> 'NEVER' THEN
    ALTER TABLE public.movimientos_inventario
      ALTER COLUMN id_pedido_trazabilidad DROP EXPRESSION;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.productos_almacenes'::regclass
      AND conname = 'chk_productos_almacenes_cantidad_nonnegative'
  ) THEN
    RAISE EXCEPTION 'Preflight fallido: chk_productos_almacenes_cantidad_nonnegative todavia existe.';
  END IF;

  SELECT COUNT(*)
    INTO v_conflicts
  FROM (
    SELECT id_ref, id_detalle_pedido, tipo, origen_consumo, id_insumo, COUNT(*) AS total
    FROM public.movimientos_inventario
    WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
      AND tipo = 'SALIDA'
      AND id_ref IS NOT NULL
      AND id_detalle_pedido IS NOT NULL
      AND origen_consumo IS NOT NULL
      AND id_insumo IS NOT NULL
    GROUP BY id_ref, id_detalle_pedido, tipo, origen_consumo, id_insumo
    HAVING COUNT(*) > 1
  ) conflicts;

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'Conflictos equivalentes de insumo PEDIDO/FALTANTE_COCINA: %.', v_conflicts;
  END IF;

  SELECT COUNT(*)
    INTO v_conflicts
  FROM (
    SELECT id_ref, id_detalle_pedido, tipo, origen_consumo, id_producto, COUNT(*) AS total
    FROM public.movimientos_inventario
    WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
      AND tipo = 'SALIDA'
      AND id_ref IS NOT NULL
      AND id_detalle_pedido IS NOT NULL
      AND origen_consumo IS NOT NULL
      AND id_producto IS NOT NULL
    GROUP BY id_ref, id_detalle_pedido, tipo, origen_consumo, id_producto
    HAVING COUNT(*) > 1
  ) conflicts;

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION 'Conflictos equivalentes de producto PEDIDO/FALTANTE_COCINA: %.', v_conflicts;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.movimientos_inventario'::regclass
      AND conname = 'ck_mov_inv_pedido_trace_scope'
  ) THEN
    ALTER TABLE public.movimientos_inventario
      ADD CONSTRAINT ck_mov_inv_pedido_trace_scope
      CHECK (
        ref_origen NOT IN ('PEDIDO', 'FALTANTE_COCINA')
        OR (
          tipo = 'SALIDA'
          AND id_ref IS NOT NULL
          AND id_pedido_trazabilidad IS NOT NULL
          AND id_pedido_trazabilidad = id_ref
          AND id_detalle_pedido IS NOT NULL
          AND origen_consumo IS NOT NULL
        )
      )
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.movimientos_inventario
  VALIDATE CONSTRAINT ck_mov_inv_pedido_trace_scope;

DROP INDEX IF EXISTS public.ux_mov_inv_linea_salida_insumo;
DROP INDEX IF EXISTS public.ux_mov_inv_linea_salida_producto;

CREATE UNIQUE INDEX ux_mov_inv_linea_salida_insumo
  ON public.movimientos_inventario (id_ref, id_detalle_pedido, tipo, origen_consumo, id_insumo)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NOT NULL
    AND origen_consumo IS NOT NULL
    AND id_insumo IS NOT NULL;

CREATE UNIQUE INDEX ux_mov_inv_linea_salida_producto
  ON public.movimientos_inventario (id_ref, id_detalle_pedido, tipo, origen_consumo, id_producto)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NOT NULL
    AND origen_consumo IS NOT NULL
    AND id_producto IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN ('ux_mov_inv_linea_salida_insumo', 'ux_mov_inv_linea_salida_producto')
      AND indexdef ILIKE '%ref_origen,%'
  ) THEN
    RAISE EXCEPTION 'Validacion final fallida: ref_origen quedo dentro de la clave de indice.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.movimientos_inventario'::regclass
      AND conname = 'ck_mov_inv_trace_transition_consistent'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'Validacion final fallida: ck_mov_inv_trace_transition_consistent no esta validada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.movimientos_inventario'::regclass
      AND conname = 'ck_mov_inv_reversion_trace_complete'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'Validacion final fallida: ck_mov_inv_reversion_trace_complete no esta validada.';
  END IF;
END $$;

COMMIT;
