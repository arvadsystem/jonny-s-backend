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
-- tiene CREATE TABLE versionado en este repo. Antes de insertar, se verifica
-- que no existan columnas NOT NULL sin DEFAULT distintas de
-- id_*/codigo/estado; si las hubiera, aborta con un error claro en vez de
-- adivinar valores.

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
  WHERE UPPER(TRIM(codigo)) = 'REVERSO';

  IF v_coincidencias > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas en cat_fidelizacion_tipos_movimiento con codigo normalizado REVERSO; no se puede determinar cual es la valida sin intervencion manual.',
      v_coincidencias;
  END IF;

  IF v_coincidencias = 1 THEN
    SELECT COALESCE(estado, true) INTO v_activo
    FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO';

    IF v_activo THEN
      RAISE NOTICE 'cat_fidelizacion_tipos_movimiento.REVERSO ya existe y esta activo; no-op';
    ELSE
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_tipos_movimiento.REVERSO existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
    END IF;
  ELSE
    -- v_coincidencias = 0: no existe ninguna fila -> insertar activa.
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
      INSERT INTO public.cat_fidelizacion_tipos_movimiento (codigo, estado) VALUES ('REVERSO', true);
    ELSE
      INSERT INTO public.cat_fidelizacion_tipos_movimiento (codigo) VALUES ('REVERSO');
    END IF;

    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento: fila REVERSO insertada (entorno carecia de ella)';
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
  WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';

  IF v_coincidencias > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas en cat_fidelizacion_origenes_movimiento con codigo normalizado REVERSO_FACTURA; no se puede determinar cual es la valida sin intervencion manual.',
      v_coincidencias;
  END IF;

  IF v_coincidencias = 1 THEN
    SELECT COALESCE(estado, true) INTO v_activo
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';

    IF v_activo THEN
      RAISE NOTICE 'cat_fidelizacion_origenes_movimiento.REVERSO_FACTURA ya existe y esta activo; no-op';
    ELSE
      RAISE EXCEPTION
        'PREFLIGHT_FAILED_INACTIVE: cat_fidelizacion_origenes_movimiento.REVERSO_FACTURA existe pero esta marcado inactivo (estado=false); esta migracion no reactiva filas existentes sin autorizacion explicita. Revisar manualmente.';
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
      INSERT INTO public.cat_fidelizacion_origenes_movimiento (codigo, estado) VALUES ('REVERSO_FACTURA', true);
    ELSE
      INSERT INTO public.cat_fidelizacion_origenes_movimiento (codigo) VALUES ('REVERSO_FACTURA');
    END IF;

    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento: fila REVERSO_FACTURA insertada (entorno carecia de ella)';
  END IF;
END
$origenes_movimiento$;

COMMIT;
