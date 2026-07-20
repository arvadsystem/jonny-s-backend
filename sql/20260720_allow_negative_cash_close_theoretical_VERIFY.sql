-- Verificacion READ-ONLY. Ejecutar antes y despues de la migracion SAFE.

SELECT
  c.conrelid::regclass AS tabla,
  c.conname AS restriccion,
  c.convalidated AS validada,
  pg_get_constraintdef(c.oid, true) AS definicion
FROM pg_constraint c
WHERE c.conrelid IN (
    'public.cajas_sesiones'::regclass,
    'public.cajas_cierres'::regclass
  )
  AND c.contype = 'c'
ORDER BY c.conrelid::regclass::text, c.conname;

SELECT
  NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_sesiones'::regclass
      AND c.conname = 'ck_cajas_sesiones_monto_teorico'
  ) AS cajas_sesiones_permite_teorico_negativo,
  NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_cierres'::regclass
      AND c.conname = 'ck_cajas_cierres_monto_teorico'
  ) AS cajas_cierres_permite_teorico_negativo;

SELECT
  3000.00::numeric(14,2) AS monto_apertura,
  0.00::numeric(14,2) AS ventas_efectivo,
  0.00::numeric(14,2) AS ingresos_manuales,
  16763.00::numeric(14,2) AS egresos_manuales,
  (
    3000.00::numeric(14,2)
    + 0.00::numeric(14,2)
    + 0.00::numeric(14,2)
    - 16763.00::numeric(14,2)
  )::numeric(14,2) AS efectivo_teorico_esperado;

SELECT cm.*
FROM public.cajas_movimientos cm
WHERE cm.id_movimiento_caja = 17;
