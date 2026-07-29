-- Verificacion read-only para Fase 6. No modifica datos.

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'cajas_cierres_notificaciones_email'
  AND column_name = 'payload_snapshot';

SELECT
  COUNT(*) AS total_notificaciones,
  COUNT(*) FILTER (WHERE payload_snapshot IS NOT NULL) AS con_snapshot,
  COUNT(*) FILTER (WHERE payload_snapshot IS NULL) AS historicas_sin_snapshot,
  COUNT(*) FILTER (
    WHERE payload_snapshot IS NOT NULL
      AND (
        jsonb_typeof(payload_snapshot->'reversiones'->'items') <> 'array'
        OR jsonb_typeof(payload_snapshot->'canjes_fidelizacion'->'items') <> 'array'
      )
  ) AS snapshots_invalidos
FROM public.cajas_cierres_notificaciones_email;

-- Verificacion estricta read-only para impedir que una columna ausente,
-- incompatible o un backfill historico parezcan un VERIFY exitoso.
DO $verify_payload_snapshot$
DECLARE
  v_conteo integer;
  v_tipo text;
  v_nullable text;
  v_total bigint;
  v_con_snapshot bigint;
  v_snapshots_invalidos bigint;
BEGIN
  SELECT COUNT(*), max(data_type), max(is_nullable)
  INTO v_conteo, v_tipo, v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cajas_cierres_notificaciones_email'
    AND column_name = 'payload_snapshot';

  IF v_conteo IS DISTINCT FROM 1
     OR v_tipo IS DISTINCT FROM 'jsonb'
     OR v_nullable IS DISTINCT FROM 'YES'
  THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_PAYLOAD_SNAPSHOT: columna invalida (conteo=%, tipo=%, nullable=%).',
      v_conteo,
      v_tipo,
      v_nullable;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE payload_snapshot IS NOT NULL),
    COUNT(*) FILTER (
      WHERE payload_snapshot IS NOT NULL
        AND (
          jsonb_typeof(payload_snapshot->'reversiones'->'items') <> 'array'
          OR jsonb_typeof(payload_snapshot->'canjes_fidelizacion'->'items') <> 'array'
        )
    )
  INTO v_total, v_con_snapshot, v_snapshots_invalidos
  FROM public.cajas_cierres_notificaciones_email;

  IF v_total IS DISTINCT FROM 9
     OR v_con_snapshot IS DISTINCT FROM 0
     OR v_snapshots_invalidos IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_PAYLOAD_SNAPSHOT: conteos historicos inesperados (total=%, con_snapshot=%, snapshots_invalidos=%).',
      v_total,
      v_con_snapshot,
      v_snapshots_invalidos;
  END IF;

  RAISE NOTICE
    'VERIFY_OK: payload_snapshot es JSONB nullable y las nueve notificaciones historicas permanecen sin backfill.';
END
$verify_payload_snapshot$;
