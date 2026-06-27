-- PROPUESTA NO EJECUTABLE AUTOMATICAMENTE.
-- Requiere datos representativos y EXPLAIN (ANALYZE, BUFFERS).
-- No aplicar indices sin confirmacion explicita.
--
-- Contexto QA al redactar:
-- - public.facturas_reversiones tenia 0 filas.
-- - Ya existia un indice sobre facturas_reversiones(id_factura_original).
-- - Este archivo es una propuesta de analisis, no una migracion obligatoria.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_reversiones_sesion_original_aplicada
  ON public.facturas_reversiones (id_sesion_caja_original, id_reversion)
  WHERE estado IS NOT NULL AND UPPER(TRIM(estado)) = 'APLICADA';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_reversiones_factura_original_aplicada
  ON public.facturas_reversiones (id_factura_original, id_reversion)
  WHERE estado IS NOT NULL AND UPPER(TRIM(estado)) = 'APLICADA';

-- Verificacion previa requerida:
EXPLAIN (ANALYZE, BUFFERS)
SELECT 1
FROM public.facturas_reversiones fr
WHERE fr.id_sesion_caja_original = 1
   OR (
     fr.id_sesion_caja_original IS NULL
     AND EXISTS (
       SELECT 1
       FROM public.facturas_cobros fc_scope
       WHERE fc_scope.id_factura = fr.id_factura_original
         AND fc_scope.id_sesion_caja = 1
     )
   );
