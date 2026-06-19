-- FASE 5.5.8
-- Amplia constraint de motivos para incluir catálogo vigente de reversión.
-- Idempotente: elimina y vuelve a crear la constraint con conjunto completo.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'facturas_reversiones'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'facturas_reversiones'
        AND c.conname = 'ck_facturas_reversiones_motivo'
    ) THEN
      EXECUTE 'ALTER TABLE public.facturas_reversiones DROP CONSTRAINT ck_facturas_reversiones_motivo';
    END IF;

    EXECUTE $sql$
      ALTER TABLE public.facturas_reversiones
      ADD CONSTRAINT ck_facturas_reversiones_motivo
      CHECK (
        motivo IN (
          'PRODUCTO_EQUIVOCADO',
          'CANTIDAD_EQUIVOCADA',
          'VENTA_DUPLICADA',
          'CLIENTE_CANCELO',
          'METODO_PAGO_EQUIVOCADO',
          'ERROR_OPERATIVO',
          'OTRO',
          -- Compatibilidad hacia atrás
          'ERROR_DIGITACION',
          'PRODUCTO_NO_DISPONIBLE',
          'DEVOLUCION',
          'COBRO_INCORRECTO'
        )
      )
    $sql$;
  END IF;
END $$;
