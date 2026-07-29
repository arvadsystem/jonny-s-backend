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
