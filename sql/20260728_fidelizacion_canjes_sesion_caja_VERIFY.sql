-- Clasificacion: PRE/POST seguro. Todas las consultas usan
-- information_schema/pg_indexes/pg_constraint (nunca fallan si la columna
-- todavia no existe) o un bloque DO con verificacion previa antes de
-- referenciar id_sesion_caja directamente.

-- 1) Columna presente, nullable, tipo correcto (vacio antes del SAFE).
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fidelizacion_canjes'
  AND column_name = 'id_sesion_caja';

-- 2) FK hacia cajas_sesiones presente, con ON DELETE RESTRICT/NO ACTION.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, confdeltype
FROM pg_constraint
WHERE conrelid = 'public.fidelizacion_canjes'::regclass
  AND conname = 'fk_fidelizacion_canjes_sesion_caja';

-- 3) Indice presente.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'fidelizacion_canjes'
  AND indexname = 'idx_fidelizacion_canjes_sesion_caja';

-- 4) Evidencia de regresion cero: ningun canje existente fue modificado.
-- Guardado con verificacion de columna: antes del SAFE, reporta
-- "columna ausente" en vez de fallar; despues del SAFE, reporta los
-- conteos reales.
DO $conteo_guardado$
DECLARE
  v_columna_existe boolean;
  v_total bigint;
  v_con_sesion bigint;
  v_sin_sesion bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fidelizacion_canjes'
      AND column_name = 'id_sesion_caja'
  ) INTO v_columna_existe;

  IF NOT v_columna_existe THEN
    RAISE NOTICE 'fidelizacion_canjes.id_sesion_caja aun no existe (VERIFY ejecutado antes del SAFE)';
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*), COUNT(*) FILTER (WHERE id_sesion_caja IS NOT NULL), COUNT(*) FILTER (WHERE id_sesion_caja IS NULL) FROM public.fidelizacion_canjes'
    INTO v_total, v_con_sesion, v_sin_sesion;

  RAISE NOTICE 'fidelizacion_canjes: total=%, con_sesion=%, sin_sesion=%', v_total, v_con_sesion, v_sin_sesion;
END
$conteo_guardado$;
