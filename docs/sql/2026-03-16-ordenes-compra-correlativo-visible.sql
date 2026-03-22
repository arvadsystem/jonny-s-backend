BEGIN;

-- AM: correlativo visible de negocio para OC, separado del PK tecnico id_orden_compra.
ALTER TABLE public.orden_compras
  ADD COLUMN IF NOT EXISTS numero_oc_visible integer;

-- AM: protege que el correlativo visible solo admita enteros positivos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_orden_compras_numero_oc_visible_positivo'
      AND conrelid = 'public.orden_compras'::regclass
  ) THEN
    ALTER TABLE public.orden_compras
      ADD CONSTRAINT chk_orden_compras_numero_oc_visible_positivo
      CHECK (numero_oc_visible IS NULL OR numero_oc_visible > 0);
  END IF;
END $$;

-- AM: reinicia correlativo visible para OC no rechazadas; con una sola OC vigente quedara en #1.
WITH ordenes_no_rechazadas AS (
  SELECT
    oc.id_orden_compra,
    ROW_NUMBER() OVER (
      ORDER BY
        COALESCE(NULLIF(to_jsonb(oc)->>'fecha_creacion', '')::timestamp, oc.fecha::timestamp),
        oc.id_orden_compra
    )::int AS numero_reiniciado
  FROM public.orden_compras oc
  WHERE UPPER(COALESCE(oc.estado_flujo, '')) <> 'RECHAZADA'
)
UPDATE public.orden_compras oc
SET numero_oc_visible = ord.numero_reiniciado
FROM ordenes_no_rechazadas ord
WHERE ord.id_orden_compra = oc.id_orden_compra;

-- AM: evita duplicados de correlativo visible entre OC no rechazadas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orden_compras_numero_oc_visible_activa
  ON public.orden_compras (numero_oc_visible)
  WHERE numero_oc_visible IS NOT NULL
    AND UPPER(COALESCE(estado_flujo, '')) <> 'RECHAZADA';

COMMIT;
