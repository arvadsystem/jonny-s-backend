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
-- El runtime actual exige ambos catalogos cuando existe deuda compensable.
-- Si COMPENSACION/AJUSTE_PENDIENTE no existen de forma unica y activa,
-- services/fidelizacionService.js aborta la acumulacion con
-- FIDELIZACION_SCHEMA_PENDIENTE antes de aplicar la compensacion FIFO.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $tipos_movimiento$
DECLARE
  v_coincidencias integer;
  v_activo boolean;
  v_codigo text;
  v_nombre text;
  v_descripcion text;
  v_afecta_saldo boolean;
  v_signo_operacion smallint;
  v_columnas_faltantes text;
  v_columnas_desconocidas text;
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
    SELECT
      codigo,
      nombre,
      descripcion,
      afecta_saldo,
      signo_operacion,
      estado
    INTO
      v_codigo,
      v_nombre,
      v_descripcion,
      v_afecta_saldo,
      v_signo_operacion,
      v_activo
    FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'COMPENSACION';

    IF v_activo IS NOT TRUE THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_tipos_movimiento.COMPENSACION existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
    END IF;

    IF v_codigo IS DISTINCT FROM 'COMPENSACION'
       OR v_nombre IS DISTINCT FROM 'Compensación'
       OR v_descripcion IS DISTINCT FROM 'Aplicación de puntos acumulados a ajustes pendientes de reversión.'
       OR v_afecta_saldo IS DISTINCT FROM true
       OR v_signo_operacion IS DISTINCT FROM -1
    THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: COMPENSACION existe activa pero su semantica no coincide con codigo=COMPENSACION, nombre=Compensación, descripcion canonica, afecta_saldo=true y signo_operacion=-1.';
    END IF;

    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento.COMPENSACION ya existe activa y con semantica canonica; no-op';
  ELSE
    SELECT string_agg(requerida.column_name, ', ' ORDER BY requerida.column_name)
    INTO v_columnas_faltantes
    FROM (
      VALUES
        ('codigo'),
        ('nombre'),
        ('descripcion'),
        ('afecta_saldo'),
        ('signo_operacion'),
        ('estado')
    ) AS requerida(column_name)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = 'cat_fidelizacion_tipos_movimiento'
     AND c.column_name = requerida.column_name
    WHERE c.column_name IS NULL;

    IF v_columnas_faltantes IS NOT NULL THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: cat_fidelizacion_tipos_movimiento no contiene columnas obligatorias: %.',
        v_columnas_faltantes;
    END IF;

    SELECT string_agg(column_name, ', ' ORDER BY column_name)
    INTO v_columnas_desconocidas
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cat_fidelizacion_tipos_movimiento'
      AND column_name NOT IN (
        'id_tipo_movimiento',
        'codigo',
        'nombre',
        'descripcion',
        'afecta_saldo',
        'signo_operacion',
        'estado'
      )
      AND is_nullable = 'NO'
      AND column_default IS NULL;

    IF v_columnas_desconocidas IS NOT NULL THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: cat_fidelizacion_tipos_movimiento tiene columnas NOT NULL sin DEFAULT no contempladas: %. No se inserta a ciegas; revisar manualmente.',
        v_columnas_desconocidas;
    END IF;

    INSERT INTO public.cat_fidelizacion_tipos_movimiento (
      codigo,
      nombre,
      descripcion,
      afecta_saldo,
      signo_operacion,
      estado
    )
    VALUES (
      'COMPENSACION',
      'Compensación',
      'Aplicación de puntos acumulados a ajustes pendientes de reversión.',
      true,
      -1,
      true
    );

    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento: fila COMPENSACION insertada (entorno carecia de ella)';
  END IF;
END
$tipos_movimiento$;

DO $origenes_movimiento$
DECLARE
  v_coincidencias integer;
  v_activo boolean;
  v_codigo text;
  v_nombre text;
  v_descripcion text;
  v_columnas_faltantes text;
  v_columnas_desconocidas text;
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
    SELECT codigo, nombre, descripcion, estado
    INTO v_codigo, v_nombre, v_descripcion, v_activo
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE';

    IF v_activo IS NOT TRUE THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_origenes_movimiento.AJUSTE_PENDIENTE existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
    END IF;

    IF v_codigo IS DISTINCT FROM 'AJUSTE_PENDIENTE'
       OR v_nombre IS DISTINCT FROM 'Ajuste pendiente'
       OR v_descripcion IS DISTINCT FROM 'Compensación aplicada a una deuda pendiente originada por reversión.'
    THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: AJUSTE_PENDIENTE existe activo pero su semantica no coincide con codigo, nombre y descripcion canonicos.';
    END IF;

    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento.AJUSTE_PENDIENTE ya existe activo y con semantica canonica; no-op';
  ELSE
    SELECT string_agg(requerida.column_name, ', ' ORDER BY requerida.column_name)
    INTO v_columnas_faltantes
    FROM (
      VALUES
        ('codigo'),
        ('nombre'),
        ('descripcion'),
        ('estado')
    ) AS requerida(column_name)
    LEFT JOIN information_schema.columns c
      ON c.table_schema = 'public'
     AND c.table_name = 'cat_fidelizacion_origenes_movimiento'
     AND c.column_name = requerida.column_name
    WHERE c.column_name IS NULL;

    IF v_columnas_faltantes IS NOT NULL THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: cat_fidelizacion_origenes_movimiento no contiene columnas obligatorias: %.',
        v_columnas_faltantes;
    END IF;

    SELECT string_agg(column_name, ', ' ORDER BY column_name)
    INTO v_columnas_desconocidas
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cat_fidelizacion_origenes_movimiento'
      AND column_name NOT IN (
        'id_origen_movimiento',
        'codigo',
        'nombre',
        'descripcion',
        'estado'
      )
      AND is_nullable = 'NO'
      AND column_default IS NULL;

    IF v_columnas_desconocidas IS NOT NULL THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: cat_fidelizacion_origenes_movimiento tiene columnas NOT NULL sin DEFAULT no contempladas: %. No se inserta a ciegas; revisar manualmente.',
        v_columnas_desconocidas;
    END IF;

    INSERT INTO public.cat_fidelizacion_origenes_movimiento (
      codigo,
      nombre,
      descripcion,
      estado
    )
    VALUES (
      'AJUSTE_PENDIENTE',
      'Ajuste pendiente',
      'Compensación aplicada a una deuda pendiente originada por reversión.',
      true
    );

    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento: fila AJUSTE_PENDIENTE insertada (entorno carecia de ella)';
  END IF;
END
$origenes_movimiento$;

COMMIT;
