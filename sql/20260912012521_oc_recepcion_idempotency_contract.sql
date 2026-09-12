BEGIN;

ALTER TABLE public.solicitudes_compra
ADD COLUMN IF NOT EXISTS reception_request_id uuid,
ADD COLUMN IF NOT EXISTS reception_request_fingerprint varchar(64);

ALTER TABLE public.solicitudes_compra
DROP CONSTRAINT IF EXISTS solicitudes_compra_reception_request_fingerprint_format_chk;

ALTER TABLE public.solicitudes_compra
ADD CONSTRAINT solicitudes_compra_reception_request_fingerprint_format_chk
CHECK (
  reception_request_fingerprint IS NULL
  OR reception_request_fingerprint ~ '^[0-9a-f]{64}$'
) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS solicitudes_compra_reception_request_id_uidx
ON public.solicitudes_compra (reception_request_id)
WHERE reception_request_id IS NOT NULL;

ALTER TABLE public.solicitudes_compra_evidencias
ADD COLUMN IF NOT EXISTS upload_request_id uuid,
ADD COLUMN IF NOT EXISTS upload_request_fingerprint varchar(64);

ALTER TABLE public.solicitudes_compra_evidencias
DROP CONSTRAINT IF EXISTS solicitudes_compra_evidencias_upload_request_fingerprint_format_chk;

ALTER TABLE public.solicitudes_compra_evidencias
ADD CONSTRAINT solicitudes_compra_evidencias_upload_request_fingerprint_format_chk
CHECK (
  upload_request_fingerprint IS NULL
  OR upload_request_fingerprint ~ '^[0-9a-f]{64}$'
) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS solicitudes_compra_evidencias_upload_request_id_uidx
ON public.solicitudes_compra_evidencias (upload_request_id)
WHERE upload_request_id IS NOT NULL;

COMMIT;
