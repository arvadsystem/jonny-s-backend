-- Align public.pedidos.id_pedido sequence with historical inventory references.
-- Artifact only: do not execute automatically and do not insert into schema_migrations.
-- WHY:
--   Legacy movimientos_inventario rows may reference old pedido IDs in id_ref even when
--   the original pedido no longer exists. The pedidos sequence must never reuse those IDs.
-- SAFETY:
--   This migration only advances the sequence when needed. It does not modify, delete,
--   rewrite, or backfill historical inventory movements.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE public.pedidos IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_sequence_name text;
  v_sequence_regclass regclass;
  v_max_pedido bigint;
  v_max_inventory_ref bigint;
  v_sequence_last bigint;
  v_safe_value bigint;
  v_seq_schema text;
  v_seq_name text;
BEGIN
  IF to_regclass('public.pedidos') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.pedidos no existe.';
  END IF;

  IF to_regclass('public.movimientos_inventario') IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.movimientos_inventario no existe.';
  END IF;

  SELECT pg_get_serial_sequence('public.pedidos', 'id_pedido')
    INTO v_sequence_name;

  IF v_sequence_name IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: public.pedidos.id_pedido no usa una secuencia compatible.';
  END IF;

  v_sequence_regclass := to_regclass(v_sequence_name);
  IF v_sequence_regclass IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: la secuencia % no existe.', v_sequence_name;
  END IF;

  SELECT COALESCE(MAX(id_pedido), 0)
    INTO v_max_pedido
  FROM public.pedidos;

  SELECT COALESCE(MAX(id_ref), 0)
    INTO v_max_inventory_ref
  FROM public.movimientos_inventario
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND id_ref IS NOT NULL;

  SELECT n.nspname, c.relname
    INTO v_seq_schema, v_seq_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = v_sequence_regclass;

  SELECT last_value
    INTO v_sequence_last
  FROM pg_sequences
  WHERE schemaname = v_seq_schema
    AND sequencename = v_seq_name;

  IF v_sequence_last IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: no se pudo leer last_value de la secuencia %.', v_sequence_name;
  END IF;

  v_safe_value := GREATEST(v_max_pedido, v_max_inventory_ref, v_sequence_last);

  PERFORM setval(v_sequence_name, v_safe_value, true);

  IF v_safe_value < v_max_pedido OR v_safe_value < v_max_inventory_ref OR v_safe_value < v_sequence_last THEN
    RAISE EXCEPTION 'Validacion fallida: safe_value (%) redujo un piso calculado.', v_safe_value;
  END IF;

  -- With is_called=true, nextval() will return last_value + increment_by.
  -- We do not call nextval() here because validation must not consume a pedido ID.
  IF (v_safe_value + 1) <= GREATEST(v_max_pedido, v_max_inventory_ref) THEN
    RAISE EXCEPTION 'Validacion fallida: el proximo id_pedido no supera el historial de pedidos/inventario.';
  END IF;

  RAISE NOTICE 'Secuencia % alineada: max_pedidos=%, max_inventory_order_ref=%, sequence_last=%, safe_value=%.',
    v_sequence_name,
    v_max_pedido,
    v_max_inventory_ref,
    v_sequence_last,
    v_safe_value;
END;
$$;

COMMIT;
