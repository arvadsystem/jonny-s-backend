-- Rollback INTENCIONALMENTE SIN BORRADO AUTOMATICO.
--
-- Motivo: cat_fidelizacion_tipos_movimiento y cat_fidelizacion_origenes_movimiento
-- no tienen ninguna columna que distinga "fila creada por el SAFE de esta
-- migracion" de "fila que ya existia antes" (no hay campo de auditoria de
-- origen, ni fecha de creacion confirmada en el esquema real, que no esta
-- versionado en este repo). Segun confirmacion del entorno QA, REVERSO y
-- REVERSO_FACTURA YA EXISTIAN ahi antes de esta migracion -> un DELETE
-- automatico por codigo, en QA, borraria filas que esta migracion nunca creo
-- y que services/ventasReversionService.js:revertLoyaltyForFactura necesita
-- para funcionar (su ausencia degrada a
-- LOYALTY_REVERSAL_CATALOG_MISSING de forma silenciosa, sin bloquear la
-- reversion financiera, pero rompiendo la reversion de puntos).
--
-- Este archivo por tanto NO ejecuta ningun DELETE. Deja evidencia de
-- solo-lectura para que un operador decida manualmente, caso por caso:
--   1) Si el SAFE companero reporto "no-op" (la fila ya existia): no hay
--      nada que revertir. No borrar nada.
--   2) Si el SAFE companero reporto "insertada" en ESTE entorno especifico
--      (evidencia: se guardo la salida de esa ejecucion o el entorno es
--      distinto de QA, donde se confirmo que ya existian): un operador
--      puede borrar manualmente esa fila especifica por id_tipo_movimiento /
--      id_origen_movimiento, tras confirmar con
--      20260728_fidelizacion_catalogos_reverso_VERIFY.sql que ningun
--      fidelizacion_movimientos ya referencia esos codigos.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback_manual_only$
DECLARE
  v_movimientos_reverso integer := 0;
BEGIN
  IF to_regclass('public.cat_fidelizacion_tipos_movimiento') IS NULL
     OR to_regclass('public.cat_fidelizacion_origenes_movimiento') IS NULL THEN
    RAISE NOTICE 'Catalogos de fidelizacion ausentes; nada que reportar';
    RETURN;
  END IF;

  IF to_regclass('public.fidelizacion_movimientos') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_movimientos_reverso
    FROM public.fidelizacion_movimientos fm
    INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
      ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
    WHERE UPPER(TRIM(tm.codigo)) = 'REVERSO';
  END IF;

  RAISE NOTICE 'ROLLBACK_MANUAL_REQUERIDO: este archivo no borra filas de catalogo. Movimientos existentes que ya usan REVERSO: %. Si es 0 y se confirmo que el entorno actual (no QA) las creo esta migracion, un operador puede borrarlas manualmente con DELETE dirigido por codigo tras revisar el VERIFY companero. Si es mayor que 0, NO BORRAR: hay reversiones de puntos reales que dependen de ese catalogo.', v_movimientos_reverso;
END
$rollback_manual_only$;

COMMIT;
