-- Agrega el estado operativo CANCELADO a public.estados_pedido, solo si no
-- existe ya una fila cuya descripcion normalice a CANCELADO/CANCELADA/
-- ANULADO/ANULADA (el mismo alias-set que ya usa la aplicacion en
-- routers/ventas/constants.js:ESTADO_PEDIDO_CODES.CANCELADO).
--
-- No reutiliza ni toca NO_ENTREGADO, COMPLETADO ni PENDIENTE.
-- No hardcodea id_estado_pedido (columna autogenerada).
-- Idempotente: si ya existe una fila equivalente, no hace nada.
--
-- public.estados_pedido no tiene CREATE TABLE versionado en este repo (fue
-- creada fuera del historial de migraciones). Antes de insertar, esta
-- migracion verifica que no existan columnas NOT NULL sin DEFAULT distintas
-- de id_estado_pedido/descripcion; si las hubiera, aborta con un error claro
-- en vez de adivinar valores.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  v_ya_existe boolean;
  v_columnas_desconocidas text;
BEGIN
  IF to_regclass('public.estados_pedido') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.estados_pedido no existe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'estados_pedido'
      AND column_name = 'id_estado_pedido'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'estados_pedido'
      AND column_name = 'descripcion'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: estados_pedido no tiene id_estado_pedido/descripcion';
  END IF;

  -- Ya existe un estado equivalente a CANCELADO -> no-op, no se toca nada.
  SELECT EXISTS (
    SELECT 1
    FROM public.estados_pedido
    WHERE UPPER(TRIM(descripcion)) IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA')
  )
  INTO v_ya_existe;

  IF v_ya_existe THEN
    RAISE NOTICE 'estados_pedido ya contiene un estado equivalente a CANCELADO; migracion en modo no-op';
    RETURN;
  END IF;

  -- Ninguna columna NOT NULL sin DEFAULT, aparte de id_estado_pedido y
  -- descripcion, puede quedar sin valor. Si existe alguna desconocida,
  -- abortamos en vez de insertar con datos adivinados.
  SELECT string_agg(column_name, ', ' ORDER BY column_name)
  INTO v_columnas_desconocidas
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'estados_pedido'
    AND column_name NOT IN ('id_estado_pedido', 'descripcion')
    AND is_nullable = 'NO'
    AND column_default IS NULL;

  IF v_columnas_desconocidas IS NOT NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: estados_pedido tiene columnas NOT NULL sin DEFAULT no contempladas por esta migracion: %. Revisar manualmente antes de insertar.',
      v_columnas_desconocidas;
  END IF;

  INSERT INTO public.estados_pedido (descripcion) VALUES ('Cancelado');

  RAISE NOTICE 'estados_pedido: fila CANCELADO insertada';
END
$migration$;

COMMIT;
