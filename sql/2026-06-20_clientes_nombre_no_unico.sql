BEGIN;

-- Los nombres no identifican de forma unica a una persona. La proteccion de
-- duplicados del alta de clientes se basa en Idempotency-Key y, cuando existe,
-- en DNI/RTN. Mantener esta restriccion impide registrar homonimos y personas
-- sin apellido desde Caja.
ALTER TABLE public.personas
  DROP CONSTRAINT IF EXISTS personas_nombre_apellido_unique;

DROP INDEX IF EXISTS public.personas_nombre_apellido_unique;

COMMIT;

-- Verificacion read-only posterior:
-- SELECT conname
-- FROM pg_constraint
-- WHERE conrelid = 'public.personas'::regclass
--   AND conname = 'personas_nombre_apellido_unique';
-- Debe devolver cero filas. personas_dni_unique debe permanecer activo.

