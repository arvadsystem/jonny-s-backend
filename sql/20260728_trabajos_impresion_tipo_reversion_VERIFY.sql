-- Clasificacion: PRE/POST seguro. trabajos_impresion es una tabla base
-- siempre presente. trabajos_impresion_documentos es OPCIONAL (schema v2;
-- puede no existir en algunos entornos, ver comentario en el SAFE
-- companero) -- todas las consultas que la referencian estan guardadas con
-- to_regclass antes de usar ::regclass sobre ella.

-- 1) CHECK vigente de tipo_documento en trabajos_impresion: debe incluir
-- factura, comanda, caja y reversion. Antes del SAFE mostrara la
-- definicion original (sin reversion); despues, la ampliada.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, convalidated
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion'::regclass
  AND contype = 'c'
  AND conkey = ARRAY[(
    SELECT attnum FROM pg_attribute
    WHERE attrelid = 'public.trabajos_impresion'::regclass
      AND attname = 'tipo_documento' AND NOT attisdropped
  )]::smallint[];

-- 2) Ningun trabajo existente quedo en un estado invalido (todos los
-- tipo_documento actuales deben seguir perteneciendo al conjunto vigente).
SELECT tipo_documento, COUNT(*) AS cantidad
FROM public.trabajos_impresion
GROUP BY tipo_documento
ORDER BY tipo_documento;

-- 3) trabajos_impresion_documentos: CHECKs de tipo/formato/bytes, guardado
-- para el caso en que la tabla no exista.
DO $verify_documentos$
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion_documentos no existe en este entorno; nada que verificar (schema v2 opcional)';
    RETURN;
  END IF;

  RAISE NOTICE 'trabajos_impresion_documentos existe; ver resultados de las consultas 4-6 a continuacion';
END
$verify_documentos$;

-- 4) CHECKs vigentes en trabajos_impresion_documentos (solo produce filas
-- si la tabla existe; si no existe, ::regclass sobre una constante
-- literal fallaria, por eso se usa to_regclass en un WHERE).
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, convalidated
FROM pg_constraint
WHERE to_regclass('public.trabajos_impresion_documentos') IS NOT NULL
  AND conrelid = to_regclass('public.trabajos_impresion_documentos')
  AND conname IN (
    'trabajos_impresion_documentos_tipo_chk',
    'trabajos_impresion_documentos_formato_chk',
    'trabajos_impresion_documentos_bytes_chk'
  )
ORDER BY conname;

-- 5) Todos los CHECK de tipo_documento en ambas tablas deben quedar
-- validados (convalidated=true); si alguno quedo NOT VALID, la Fase 2/4
-- del SAFE no completo correctamente.
SELECT conrelid::regclass AS tabla, conname, convalidated
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion'::regclass
  AND contype = 'c'
UNION ALL
SELECT conrelid::regclass AS tabla, conname, convalidated
FROM pg_constraint
WHERE to_regclass('public.trabajos_impresion_documentos') IS NOT NULL
  AND conrelid = to_regclass('public.trabajos_impresion_documentos')
  AND contype = 'c'
ORDER BY tabla::text, conname;
