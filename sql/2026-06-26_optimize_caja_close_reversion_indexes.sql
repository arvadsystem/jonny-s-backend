-- Optional caja close reversion lookup index.
-- Status: proposal only, not an obligatory migration.
-- Do not execute until facturas_reversiones has representative data and the
-- query plan is reviewed with EXPLAIN (ANALYZE, BUFFERS). Jonnys QA had 0 rows
-- in facturas_reversiones when this was written, and an index on
-- id_factura_original already exists there. Require explicit confirmation
-- before running this file in any environment.
-- Review the current plan first. This file is not wrapped in BEGIN because
-- CREATE INDEX CONCURRENTLY is rejected inside an explicit transaction block.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_reversiones_sesion_original_aplicada
  ON public.facturas_reversiones (id_sesion_caja_original, id_reversion)
  WHERE estado IS NOT NULL AND UPPER(TRIM(estado)) = 'APLICADA';

-- Existing joins still need the original factura lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_reversiones_factura_original_aplicada
  ON public.facturas_reversiones (id_factura_original, id_reversion)
  WHERE estado IS NOT NULL AND UPPER(TRIM(estado)) = 'APLICADA';

-- Verification:
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'facturas_reversiones'
  AND indexname IN (
    'idx_facturas_reversiones_sesion_original_aplicada',
    'idx_facturas_reversiones_factura_original_aplicada'
  )
ORDER BY indexname;
