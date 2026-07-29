-- Siembra CONDICIONAL de los codigos COMPENSACION
-- (cat_fidelizacion_tipos_movimiento) y AJUSTE_PENDIENTE
-- (cat_fidelizacion_origenes_movimiento), que Fase 4 (seccion 3.6 del
-- ticket, compensacion FIFO de ajustes pendientes en
-- services/fidelizacionService.js:addSaldoPoints) usa para registrar el
-- movimiento auditable de compensacion: "de esta acumulacion, N puntos se
-- aplicaron a pagar una deuda pendiente de una reversion anterior".
--
-- Mismo patron exacto que 20260728_fidelizacion_catalogos_reverso_SAFE.sql:
-- para cada codigo distingue 0 filas (INSERT activo), 1 fila activa
-- (no-op), 1 fila inactiva (ABORTA, no reactiva sin autorizacion) y 2+
-- filas (ABORTA por ambiguedad).
--
-- El codigo de aplicacion (Fase 4) SOLO crea el movimiento de compensacion
-- dedicado cuando ambos catalogos existen y estan activos (verificado en
-- runtime via getCatalogRowByCode); si no, el ajuste pendiente se sigue
-- registrando/actualizando igual en fidelizacion_ajustes_pendientes, pero
-- la compensacion queda documentada unicamente en la observacion del
-- movimiento de acumulacion (no bloquea la acumulacion).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $tipos_movimiento$
DECLARE
  v_coincidencias integer;
  v_activo boolean;
  v_columnas_desconocidas text;
  v_tiene_estado boolean;
BEGIN
  IF to_regclass('public.cat_fidelizacion_tipos_movimiento') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.cat_fidelizacion_tipos_movimiento no existe';
  END IF;

  SELECT COUNT(*) INTO v_coincidencias
  FROM public.cat_fidelizacion_tipos_movimiento
  WHERE UPPER(TRIM(codigo)) = 'COMPENSACION';

  IF v_coincidencias > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas en cat_fidelizacion_tipos_movimiento con codigo normalizado COMPENSACION; no se puede determinar cual es la valida sin intervencion manual.',
      v_coincidencias;
  END IF;

  IF v_coincidencias = 1 THEN
    SELECT COALESCE(estado, true) INTO v_activo
    FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'COMPENSACION';

    IF v_activo THEN
      RAISE NOTICE 'cat_fidelizacion_tipos_movimiento.COMPENSACION ya existe y esta activo; no-op';
    ELSE
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_tipos_movimiento.COMPENSACION existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
    END IF;
  ELSE
    SELECT string_agg(column_name, ', ' ORDER BY column_name)
    INTO v_columnas_desconocidas
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cat_fidelizacion_tipos_movimiento'
      AND column_name NOT IN ('id_tipo_movimiento', 'codigo', 'estado')
      AND is_nullable = 'NO'
      AND column_default IS NULL;

    IF v_columnas_desconocidas IS NOT NULL THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: cat_fidelizacion_tipos_movimiento tiene columnas NOT NULL sin DEFAULT no contempladas: %. No se inserta a ciegas; revisar manualmente.',
        v_columnas_desconocidas;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cat_fidelizacion_tipos_movimiento'
        AND column_name = 'estado'
    ) INTO v_tiene_estado;

    IF v_tiene_estado THEN
      INSERT INTO public.cat_fidelizacion_tipos_movimiento (codigo, estado) VALUES ('COMPENSACION', true);
    ELSE
      INSERT INTO public.cat_fidelizacion_tipos_movimiento (codigo) VALUES ('COMPENSACION');
    END IF;

    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento: fila COMPENSACION insertada (entorno carecia de ella)';
  END IF;
END
$tipos_movimiento$;

DO $origenes_movimiento$
DECLARE
  v_coincidencias integer;
  v_activo boolean;
  v_columnas_desconocidas text;
  v_tiene_estado boolean;
BEGIN
  IF to_regclass('public.cat_fidelizacion_origenes_movimiento') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.cat_fidelizacion_origenes_movimiento no existe';
  END IF;

  SELECT COUNT(*) INTO v_coincidencias
  FROM public.cat_fidelizacion_origenes_movimiento
  WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE';

  IF v_coincidencias > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas en cat_fidelizacion_origenes_movimiento con codigo normalizado AJUSTE_PENDIENTE; no se puede determinar cual es la valida sin intervencion manual.',
      v_coincidencias;
  END IF;

  IF v_coincidencias = 1 THEN
    SELECT COALESCE(estado, true) INTO v_activo
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE';

    IF v_activo THEN
      RAISE NOTICE 'cat_fidelizacion_origenes_movimiento.AJUSTE_PENDIENTE ya existe y esta activo; no-op';
    ELSE
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_origenes_movimiento.AJUSTE_PENDIENTE existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
    END IF;
  ELSE
    SELECT string_agg(column_name, ', ' ORDER BY column_name)
    INTO v_columnas_desconocidas
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cat_fidelizacion_origenes_movimiento'
      AND column_name NOT IN ('id_origen_movimiento', 'codigo', 'estado')
      AND is_nullable = 'NO'
      AND column_default IS NULL;

    IF v_columnas_desconocidas IS NOT NULL THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: cat_fidelizacion_origenes_movimiento tiene columnas NOT NULL sin DEFAULT no contempladas: %. No se inserta a ciegas; revisar manualmente.',
        v_columnas_desconocidas;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cat_fidelizacion_origenes_movimiento'
        AND column_name = 'estado'
    ) INTO v_tiene_estado;

    IF v_tiene_estado THEN
      INSERT INTO public.cat_fidelizacion_origenes_movimiento (codigo, estado) VALUES ('AJUSTE_PENDIENTE', true);
    ELSE
      INSERT INTO public.cat_fidelizacion_origenes_movimiento (codigo) VALUES ('AJUSTE_PENDIENTE');
    END IF;

    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento: fila AJUSTE_PENDIENTE insertada (entorno carecia de ella)';
  END IF;
END
$origenes_movimiento$;

COMMIT;
