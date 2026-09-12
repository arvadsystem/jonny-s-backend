BEGIN;

ALTER TABLE public.solicitudes_compra
  ADD COLUMN IF NOT EXISTS reception_request_id uuid NULL,
  ADD COLUMN IF NOT EXISTS reception_request_fingerprint varchar(64) NULL;

ALTER TABLE public.solicitudes_compra
  DROP CONSTRAINT IF EXISTS solicitudes_compra_reception_fingerprint_check,
  ADD CONSTRAINT solicitudes_compra_reception_fingerprint_check
    CHECK (reception_request_fingerprint IS NULL OR reception_request_fingerprint ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS solicitudes_compra_reception_request_id_uidx
  ON public.solicitudes_compra (reception_request_id)
  WHERE reception_request_id IS NOT NULL;

ALTER TABLE public.solicitudes_compra_evidencias
  ADD COLUMN IF NOT EXISTS upload_request_id uuid NULL,
  ADD COLUMN IF NOT EXISTS upload_request_fingerprint varchar(64) NULL;

ALTER TABLE public.solicitudes_compra_evidencias
  DROP CONSTRAINT IF EXISTS solicitudes_compra_evidencias_upload_fingerprint_check,
  ADD CONSTRAINT solicitudes_compra_evidencias_upload_fingerprint_check
    CHECK (upload_request_fingerprint IS NULL OR upload_request_fingerprint ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS solicitudes_compra_evidencias_upload_request_id_uidx
  ON public.solicitudes_compra_evidencias (upload_request_id)
  WHERE upload_request_id IS NOT NULL;

COMMIT;
