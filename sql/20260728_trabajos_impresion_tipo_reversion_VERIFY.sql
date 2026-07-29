-- Verificacion exclusivamente de lectura. Segura de ejecutar en cualquier
-- entorno, antes y despues de aplicar el SAFE.

-- 1) CHECK vigente de tipo_documento en trabajos_impresion: debe incluir
-- factura, comanda, caja y reversion.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, convalidated
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion'::regclass
  AND conname = 'ck_trabajos_impresion_tipo_documento';

-- 2) CHECKs vigentes en trabajos_impresion_documentos (tipo/formato/bytes):
-- deben incluir 'reversion' con formato pdf/base64, sin agregar 'caja'.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, convalidated
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
  AND conname IN (
    'trabajos_impresion_documentos_tipo_chk',
    'trabajos_impresion_documentos_formato_chk',
    'trabajos_impresion_documentos_bytes_chk'
  )
ORDER BY conname;

-- 3) Ningun trabajo existente quedo en un estado invalido (todos los
-- tipo_documento actuales deben seguir perteneciendo al conjunto vigente).
SELECT tipo_documento, COUNT(*) AS cantidad
FROM public.trabajos_impresion
GROUP BY tipo_documento
ORDER BY tipo_documento;

-- 4) Todos los CHECK de ambas tablas deben quedar validados
-- (convalidated=true); si alguno quedo NOT VALID, la Fase 2 del SAFE no
-- completo correctamente.
SELECT conrelid::regclass AS tabla, conname, convalidated
FROM pg_constraint
WHERE conrelid IN ('public.trabajos_impresion'::regclass, 'public.trabajos_impresion_documentos'::regclass)
  AND contype = 'c'
ORDER BY tabla::text, conname;
