-- Siembra CONDICIONAL de los codigos REVERSO
-- (cat_fidelizacion_tipos_movimiento) y REVERSO_FACTURA
-- (cat_fidelizacion_origenes_movimiento), que
-- services/ventasReversionService.js:revertLoyaltyForFactura ya consulta
-- (lineas 550-566) pero que no tienen ningun INSERT/seed versionado en
-- este repo.
--
-- Segun confirmacion del entorno QA, estas dos filas YA EXISTEN activas
-- ahi -> en QA este script debe reportar "exactamente una fila activa;
-- no-op" para ambos codigos. Solo inserta si el entorno destino realmente
-- carece de ellas.
--
-- Para cada codigo (REVERSO y REVERSO_FACTURA), en su tabla
-- correspondiente, esta migracion distingue explicitamente CUATRO estados
-- y nunca activa ni modifica silenciosamente una fila existente:
--   0 filas con ese codigo normalizado          -> INSERT activo.
--   exactamente 1 fila, y esta activa           -> no-op.
--   exactamente 1 fila, pero esta INACTIVA      -> ABORTA con error
--                                                   explicito (una fila
--                                                   inactiva es una
--                                                   decision de negocio
--                                                   deliberada; activarla
--                                                   sin autorizacion
--                                                   humana seria
--                                                   incorrecto).
--   2+ filas con el mismo codigo normalizado    -> ABORTA por ambiguedad
--                                                   (no hay forma segura
--                                                   de saber cual es la
--                                                   valida).
--
-- Igual que con estados_pedido (ver
-- 20260728_estado_pedido_cancelado_SAFE.sql), ninguna de las dos tablas
-- tiene CREATE TABLE versionado en este repo. Antes de insertar se
-- comprueba que existan todas las columnas canonicas y que no haya otras
-- columnas NOT NULL sin DEFAULT que el INSERT no contemple.

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
  WHERE UPPER(TRIM(codigo)) = 'REVERSO';

  IF v_coincidencias > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas en cat_fidelizacion_tipos_movimiento con codigo normalizado REVERSO; no se puede determinar cual es la valida sin intervencion manual.',
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
    WHERE UPPER(TRIM(codigo)) = 'REVERSO';

    IF v_activo IS NOT TRUE THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_tipos_movimiento.REVERSO existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
    END IF;

    IF v_codigo IS DISTINCT FROM 'REVERSO'
       OR v_nombre IS DISTINCT FROM 'Reverso'
       OR v_descripcion IS DISTINCT FROM U&'Reversi\00F3n de un movimiento previo.'
       OR v_afecta_saldo IS DISTINCT FROM true
       OR v_signo_operacion IS DISTINCT FROM 1
    THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: REVERSO existe activo pero su semantica no coincide con codigo=REVERSO, nombre=Reverso, descripcion canonica, afecta_saldo=true y signo_operacion=1.';
    END IF;

    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento.REVERSO ya existe activo y con semantica canonica; no-op';
  ELSE
    -- v_coincidencias = 0: no existe ninguna fila -> insertar activa.
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
      'REVERSO',
      'Reverso',
      U&'Reversi\00F3n de un movimiento previo.',
      true,
      1,
      true
    );

    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento: fila REVERSO insertada (entorno carecia de ella)';
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
  WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';

  IF v_coincidencias > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas en cat_fidelizacion_origenes_movimiento con codigo normalizado REVERSO_FACTURA; no se puede determinar cual es la valida sin intervencion manual.',
      v_coincidencias;
  END IF;

  IF v_coincidencias = 1 THEN
    SELECT codigo, nombre, descripcion, estado
    INTO v_codigo, v_nombre, v_descripcion, v_activo
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';

    IF v_activo IS NOT TRUE THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_origenes_movimiento.REVERSO_FACTURA existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
    END IF;

    IF v_codigo IS DISTINCT FROM 'REVERSO_FACTURA'
       OR v_nombre IS DISTINCT FROM 'Reverso de factura'
       OR v_descripcion IS DISTINCT FROM U&'Movimiento generado por reversi\00F3n de acumulaci\00F3n por factura.'
    THEN
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: REVERSO_FACTURA existe activo pero su semantica no coincide con codigo, nombre y descripcion canonicos.';
    END IF;

    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento.REVERSO_FACTURA ya existe activo y con semantica canonica; no-op';
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
      'REVERSO_FACTURA',
      'Reverso de factura',
      U&'Movimiento generado por reversi\00F3n de acumulaci\00F3n por factura.',
      true
    );

    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento: fila REVERSO_FACTURA insertada (entorno carecia de ella)';
  END IF;
END
$origenes_movimiento$;

COMMIT;
