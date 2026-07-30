-- Rollback INTENCIONALMENTE SIN DELETE AUTOMATICO.
--
-- Motivo: public.estados_pedido no tiene ninguna columna de auditoria de
-- origen (quien/que proceso creo cada fila, ni una marca durable y segura
-- que distinga "fila insertada por el SAFE de esta migracion" de "fila
-- CANCELADO que ya existia antes, coincidentemente con la misma
-- descripcion"). Un DELETE automatico basado solo en
-- descripcion='Cancelado' podria borrar un estado operativo preexistente
-- si el SAFE fue no-op (el SAFE ya reporta no-op explicitamente cuando
-- detecta un CANCELADO/CANCELADA/ANULADO/ANULADA previo, ver
-- 20260728_estado_pedido_cancelado_SAFE.sql), y eso es exactamente lo que
-- este rollback debe evitar sin excepcion.
--
-- Este archivo por tanto NO ejecuta ningun DELETE. Deja evidencia de
-- solo-lectura para que un operador decida manualmente:
--   1) Si el SAFE companero reporto (via su salida/log real de ejecucion)
--      "ya contiene un estado equivalente a CANCELADO; migracion en modo
--      no-op": NO HAY NADA QUE REVERTIR. No borrar nada.
--   2) Si el SAFE companero reporto (via su salida/log real de ejecucion)
--      "fila CANCELADO insertada" en ESTE entorno especifico: un operador
--      puede borrar manualmente esa fila especifica por
--      id_estado_pedido, tras confirmar con
--      20260728_estado_pedido_cancelado_VERIFY.sql que ningun pedido ya
--      la referencia.
-- La unica fuente confiable de "quien creo la fila" es el registro externo
-- de la ejecucion del SAFE (log/ticket/bitacora de despliegue), no el
-- estado de la base de datos en si.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback_manual_only$
DECLARE
  v_candidatos integer := 0;
  v_referenciados integer := 0;
BEGIN
  IF to_regclass('public.estados_pedido') IS NULL THEN
    RAISE NOTICE 'estados_pedido no existe; nada que reportar';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_candidatos
  FROM public.estados_pedido
  WHERE UPPER(TRIM(descripcion)) IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA');

  IF to_regclass('public.pedidos') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_referenciados
    FROM public.pedidos p
    INNER JOIN public.estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
    WHERE UPPER(TRIM(ep.descripcion)) IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA');
  END IF;

  RAISE NOTICE 'ROLLBACK_MANUAL_REQUERIDO: este archivo no borra filas de estados_pedido. Filas equivalentes a CANCELADO encontradas: %. Pedidos que ya las referencian: %. Confirmar con el log de ejecucion del SAFE si la fila fue creada por esta migracion antes de borrar nada manualmente; si hay pedidos referenciandola, NO BORRAR.', v_candidatos, v_referenciados;
END
$rollback_manual_only$;

COMMIT;
