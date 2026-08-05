-- Scope durable de sesion de caja para idempotencia financiera.
-- Migracion aditiva, repetible y compatible con registros historicos NULL.

ALTER TABLE public.ventas_idempotency_keys
  ADD COLUMN IF NOT EXISTS id_sesion_caja bigint NULL;

UPDATE public.ventas_idempotency_keys vik
SET id_sesion_caja = f.id_sesion_caja
FROM public.facturas f
WHERE f.id_factura = vik.id_factura
  AND vik.id_sesion_caja IS NULL
  AND f.id_sesion_caja IS NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.ventas_idempotency_keys'::regclass
      AND conname = 'ck_ventas_idempotency_sesion_caja_positive'
  ) THEN
    ALTER TABLE public.ventas_idempotency_keys
      ADD CONSTRAINT ck_ventas_idempotency_sesion_caja_positive
      CHECK (id_sesion_caja IS NULL OR id_sesion_caja > 0)
      NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE public.ventas_idempotency_keys
  VALIDATE CONSTRAINT ck_ventas_idempotency_sesion_caja_positive;
