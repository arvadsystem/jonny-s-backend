BEGIN;

ALTER TABLE public.configuracion_impresoras
  ADD COLUMN IF NOT EXISTS ip_impresora TEXT,
  ADD COLUMN IF NOT EXISTS puerto_impresora INTEGER NOT NULL DEFAULT 9100,
  ADD COLUMN IF NOT EXISTS modo_impresion TEXT NOT NULL DEFAULT 'BROWSER';

UPDATE public.configuracion_impresoras
SET
  puerto_impresora = COALESCE(NULLIF(puerto_impresora, 0), 9100),
  modo_impresion = CASE
    WHEN UPPER(COALESCE(modo_impresion, '')) IN ('BROWSER', 'QZ_HTML', 'QZ_RAW') THEN UPPER(modo_impresion)
    ELSE 'BROWSER'
  END
WHERE
  puerto_impresora IS NULL
  OR puerto_impresora = 0
  OR modo_impresion IS NULL
  OR UPPER(COALESCE(modo_impresion, '')) NOT IN ('BROWSER', 'QZ_HTML', 'QZ_RAW');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_configuracion_impresoras_modo'
  ) THEN
    ALTER TABLE public.configuracion_impresoras
      ADD CONSTRAINT ck_configuracion_impresoras_modo
      CHECK (modo_impresion IN ('BROWSER', 'QZ_HTML', 'QZ_RAW'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_configuracion_impresoras_puerto'
  ) THEN
    ALTER TABLE public.configuracion_impresoras
      ADD CONSTRAINT ck_configuracion_impresoras_puerto
      CHECK (puerto_impresora BETWEEN 1 AND 65535);
  END IF;
END $$;

COMMIT;
