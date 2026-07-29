-- Rollback dirigido: elimina UNICAMENTE la fila con descripcion EXACTA
-- 'Cancelado' (el literal insertado por el SAFE de esta migracion), nunca
-- cualquier otra fila que normalice a CANCELADO/ANULADO por alias.
--
-- Limitacion documentada: si antes de aplicar el SAFE ya existia una fila
-- con descripcion EXACTAMENTE 'Cancelado' (no deberia ser el caso, porque
-- el SAFE es no-op cuando ya existe un equivalente), este rollback no puede
-- distinguirla de la creada por el SAFE. Se bloquea con error si hay mas de
-- una fila candidata, en vez de adivinar cual borrar.
--
-- Se bloquea de forma segura si la fila ya esta referenciada por pedidos.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  v_candidatos int;
  v_id_estado_pedido integer;
  v_referenciada boolean;
BEGIN
  IF to_regclass('public.estados_pedido') IS NULL THEN
    RAISE NOTICE 'estados_pedido no existe; rollback no-op';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_candidatos
  FROM public.estados_pedido
  WHERE descripcion = 'Cancelado';

  IF v_candidatos = 0 THEN
    RAISE NOTICE 'No existe una fila con descripcion exacta ''Cancelado''; rollback no-op';
    RETURN;
  END IF;

  IF v_candidatos > 1 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_AMBIGUOUS: existen % filas con descripcion exacta ''Cancelado''; no se puede distinguir cual creo el SAFE. Revisar manualmente.',
      v_candidatos;
  END IF;

  SELECT id_estado_pedido INTO v_id_estado_pedido
  FROM public.estados_pedido
  WHERE descripcion = 'Cancelado';

  SELECT EXISTS (
    SELECT 1 FROM public.pedidos WHERE id_estado_pedido = v_id_estado_pedido
  )
  INTO v_referenciada;

  IF v_referenciada THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_REFERENCED: id_estado_pedido=% ya esta referenciado por public.pedidos; no se elimina un estado en uso.',
      v_id_estado_pedido;
  END IF;

  DELETE FROM public.estados_pedido WHERE id_estado_pedido = v_id_estado_pedido;

  RAISE NOTICE 'estados_pedido: fila id_estado_pedido=% (Cancelado) eliminada', v_id_estado_pedido;
END
$rollback$;

COMMIT;
