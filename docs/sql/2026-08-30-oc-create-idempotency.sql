BEGIN;

ALTER TABLE public.solicitudes_compra
  ADD COLUMN IF NOT EXISTS client_request_id uuid NULL,
  ADD COLUMN IF NOT EXISTS request_fingerprint varchar(64) NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.solicitudes_compra'::regclass
      AND conname = 'solicitudes_compra_request_fingerprint_format_chk'
  ) THEN
    ALTER TABLE public.solicitudes_compra
      ADD CONSTRAINT solicitudes_compra_request_fingerprint_format_chk
      CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS solicitudes_compra_client_request_id_uidx
  ON public.solicitudes_compra (client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS solicitudes_compra_legacy_replay_lookup_idx
  ON public.solicitudes_compra (
    id_usuario_solicitante,
    id_almacen,
    request_fingerprint,
    fecha_creacion DESC
  )
  WHERE request_fingerprint IS NOT NULL;

COMMIT;
