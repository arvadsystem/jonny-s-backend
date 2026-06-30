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

LOCK TABLE
  public.pedidos,
  public.movimientos_inventario
IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_sequence_name text;
  v_sequence_regclass regclass;
  v_max_pedido bigint;
  v_max_inventory_ref bigint;
  v_sequence_last bigint;
  v_sequence_is_called boolean;
  v_sequence_increment bigint;
  v_sequence_cycle boolean;
  v_sequence_max bigint;
  v_sequence_next_candidate bigint;
  v_history_floor bigint;
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

  SELECT seq.seqincrement::bigint, seq.seqcycle::boolean, seq.seqmax::bigint
    INTO v_sequence_increment, v_sequence_cycle, v_sequence_max
  FROM pg_sequence seq
  WHERE seq.seqrelid = v_sequence_regclass;

  EXECUTE format(
    'SELECT last_value::bigint, is_called::boolean FROM %I.%I',
    v_seq_schema,
    v_seq_name
  )
  INTO v_sequence_last, v_sequence_is_called;

  IF v_sequence_last IS NULL OR v_sequence_is_called IS NULL THEN
    RAISE EXCEPTION 'Preflight fallido: no se pudo leer last_value/is_called de la secuencia %.', v_sequence_name;
  END IF;

  IF v_sequence_increment IS NULL OR v_sequence_increment <= 0 THEN
    RAISE EXCEPTION 'Preflight fallido: la secuencia % tiene incremento inseguro (%).', v_sequence_name, v_sequence_increment;
  END IF;

  IF v_sequence_cycle IS TRUE THEN
    RAISE EXCEPTION 'Preflight fallido: la secuencia % tiene CYCLE activo.', v_sequence_name;
  END IF;

  v_history_floor := GREATEST(v_max_pedido, v_max_inventory_ref);
  v_sequence_next_candidate := CASE
    WHEN v_sequence_is_called THEN v_sequence_last + v_sequence_increment
    ELSE v_sequence_last
  END;

  IF v_sequence_next_candidate > v_sequence_max THEN
    RAISE EXCEPTION 'Preflight fallido: la secuencia % esta agotada; next_candidate=%, max_value=%.',
      v_sequence_name,
      v_sequence_next_candidate,
      v_sequence_max;
  END IF;

  IF v_sequence_next_candidate > v_history_floor THEN
    RAISE NOTICE 'Secuencia % ya esta segura: max_pedidos=%, max_inventory_order_ref=%, sequence_last=%, is_called=%, increment_by=%, next_candidate=%, history_floor=%.',
      v_sequence_name,
      v_max_pedido,
      v_max_inventory_ref,
      v_sequence_last,
      v_sequence_is_called,
      v_sequence_increment,
      v_sequence_next_candidate,
      v_history_floor;
    RETURN;
  END IF;

  v_safe_value := v_history_floor;

  IF (v_safe_value + v_sequence_increment) > v_sequence_max THEN
    RAISE EXCEPTION 'Preflight fallido: alinear % a % agotaria la secuencia; max_value=%.',
      v_sequence_name,
      v_safe_value,
      v_sequence_max;
  END IF;

  PERFORM setval(v_sequence_name, v_safe_value, true);

  IF v_safe_value < v_max_pedido OR v_safe_value < v_max_inventory_ref THEN
    RAISE EXCEPTION 'Validacion fallida: safe_value (%) redujo el historial calculado.', v_safe_value;
  END IF;

  -- With is_called=true, the next generated value will be last_value + increment_by.
  -- Validation must not consume a pedido ID.
  IF (v_safe_value + v_sequence_increment) <= v_history_floor THEN
    RAISE EXCEPTION 'Validacion fallida: el proximo id_pedido no supera el historial de pedidos/inventario.';
  END IF;

  RAISE NOTICE 'Secuencia % alineada: max_pedidos=%, max_inventory_order_ref=%, sequence_last=%, is_called=%, increment_by=%, safe_value=%.',
    v_sequence_name,
    v_max_pedido,
    v_max_inventory_ref,
    v_sequence_last,
    v_sequence_is_called,
    v_sequence_increment,
    v_safe_value;
END;
$$;

COMMIT;
