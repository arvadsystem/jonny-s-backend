BEGIN;

-- Switch administrativo por sucursal para habilitar/deshabilitar la
-- acumulacion de puntos de fidelizacion, independiente de la tasa
-- (lempiras_por_punto) y del canje (que no se toca en esta migracion).
--
-- Valor seguro por defecto: false. Ninguna sucursal debe empezar a acumular
-- puntos automaticamente por el solo hecho de que esta columna exista; el
-- switch debe encenderse explicitamente desde el panel administrativo
-- (routers/fidelizacion.js -> saveConfiguracion) para cada sucursal.
--
-- Idempotente: IF NOT EXISTS evita error si la columna ya fue agregada.
-- No modifica datos historicos de otra forma: las filas existentes de
-- fidelizacion_configuracion_sucursal (configuraciones ya cerradas o
-- vigentes) quedan con acumulacion_habilitada = false por el DEFAULT,
-- preservando que ninguna configuracion pasada "empiece a acumular" de forma
-- retroactiva solo por esta migracion.
ALTER TABLE public.fidelizacion_configuracion_sucursal
  ADD COLUMN IF NOT EXISTS acumulacion_habilitada boolean NOT NULL DEFAULT false;

COMMIT;

-- Verificacion read-only posterior (no ejecutar como parte de esta migracion):
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'fidelizacion_configuracion_sucursal'
--   AND column_name = 'acumulacion_habilitada';
-- Debe devolver: boolean, NO, false.
--
-- SELECT count(*) AS configuraciones_con_acumulacion_habilitada
-- FROM public.fidelizacion_configuracion_sucursal
-- WHERE acumulacion_habilitada = true;
-- Debe devolver 0 inmediatamente despues de aplicar esta migracion (nadie
-- queda habilitado automaticamente).
