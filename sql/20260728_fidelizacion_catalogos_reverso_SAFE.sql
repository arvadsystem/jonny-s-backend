-- Siembra CONDICIONAL e IDEMPOTENTE de los codigos REVERSO
-- (cat_fidelizacion_tipos_movimiento) y REVERSO_FACTURA
-- (cat_fidelizacion_origenes_movimiento), que
-- services/ventasReversionService.js:revertLoyaltyForFactura ya consulta
-- (lineas 550-566) pero que no tienen ningun INSERT/seed versionado en
-- este repo.
--
-- Segun confirmacion del entorno QA, estas dos filas YA EXISTEN activas
-- ahi -> en QA este script debe ser un no-op verificable (ver el VERIFY
-- companero). Solo inserta si el entorno destino realmente carece de ellas
-- (otro QA, produccion futura, etc.). Nunca se ejecuta este archivo sin
-- antes correr el VERIFY y confirmar el estado real.
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
  v_ya_existe boolean;
  v_columnas_desconocidas text;
  v_tiene_estado boolean;
BEGIN
  IF to_regclass('public.cat_fidelizacion_tipos_movimiento') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.cat_fidelizacion_tipos_movimiento no existe';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO'
  )
  INTO v_ya_existe;

  IF v_ya_existe THEN
    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento.REVERSO ya existe; no-op';
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
  v_ya_existe boolean;
  v_columnas_desconocidas text;
  v_tiene_estado boolean;
BEGIN
  IF to_regclass('public.cat_fidelizacion_origenes_movimiento') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.cat_fidelizacion_origenes_movimiento no existe';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA'
  )
  INTO v_ya_existe;

  IF v_ya_existe THEN
    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento.REVERSO_FACTURA ya existe; no-op';
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
