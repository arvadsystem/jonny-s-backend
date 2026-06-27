-- Reparacion QA para clasificacion historica de cobros de la sesion 2.
-- Ejecutar solo en QA con respaldo previo. No fue aplicado desde Codex.
-- Resultado esperado:
-- total_responsable = 2574
-- total_auxiliares = 1415
-- total_otros_ejecutores = 0
-- total_teorico = 3989

BEGIN;

WITH roles AS (
  SELECT
    MAX(id_rol_participacion_caja) FILTER (WHERE UPPER(TRIM(codigo)) = 'RESPONSABLE') AS id_rol_responsable,
    MAX(id_rol_participacion_caja) FILTER (WHERE UPPER(TRIM(codigo)) = 'AUXILIAR') AS id_rol_auxiliar
  FROM public.cat_cajas_roles_participacion
),
usuarios_objetivo AS (
  SELECT
    MAX(id_usuario) FILTER (WHERE UPPER(TRIM(nombre_usuario)) = 'PQA') AS id_pqa,
    MAX(id_usuario) FILTER (WHERE UPPER(TRIM(nombre_usuario)) = 'ROOT') AS id_root,
    MAX(id_usuario) FILTER (WHERE UPPER(TRIM(nombre_usuario)) = 'PCAJERODOS') AS id_pcajerodos
  FROM public.usuarios
),
sesion AS (
  SELECT cs.id_sesion_caja, cs.fecha_apertura, cs.id_usuario_responsable
  FROM public.cajas_sesiones cs
  WHERE cs.id_sesion_caja = 2
  FOR UPDATE
),
marcas AS (
  SELECT
    COALESCE(MIN(fc.fecha_cobro), (SELECT fecha_apertura FROM sesion), now() AT TIME ZONE 'America/Tegucigalpa') AS primer_cobro,
    COALESCE(MAX(fc.fecha_cobro), now() AT TIME ZONE 'America/Tegucigalpa') AS ultimo_cobro
  FROM public.facturas_cobros fc
  WHERE fc.id_sesion_caja = 2
),
responsable_actualizado AS (
  UPDATE public.cajas_sesiones cs
  SET id_usuario_responsable = u.id_pqa,
      fecha_actualizacion = now() AT TIME ZONE 'America/Tegucigalpa'
  FROM usuarios_objetivo u
  WHERE cs.id_sesion_caja = 2
    AND u.id_pqa IS NOT NULL
  RETURNING cs.id_sesion_caja
),
participantes_requeridos AS (
  SELECT 2 AS id_sesion_caja, u.id_pqa AS id_usuario, r.id_rol_responsable AS id_rol_participacion_caja, 'Reparacion QA: PQA responsable' AS observacion
  FROM usuarios_objetivo u CROSS JOIN roles r
  WHERE u.id_pqa IS NOT NULL AND r.id_rol_responsable IS NOT NULL
  UNION ALL
  SELECT 2, u.id_root, r.id_rol_auxiliar, 'Reparacion QA: root auxiliar'
  FROM usuarios_objetivo u CROSS JOIN roles r
  WHERE u.id_root IS NOT NULL AND r.id_rol_auxiliar IS NOT NULL
  UNION ALL
  SELECT 2, u.id_pcajerodos, r.id_rol_auxiliar, 'Reparacion QA: PCAJERODOS auxiliar'
  FROM usuarios_objetivo u CROSS JOIN roles r
  WHERE u.id_pcajerodos IS NOT NULL AND r.id_rol_auxiliar IS NOT NULL
)
INSERT INTO public.cajas_sesiones_participantes (
  id_sesion_caja,
  id_usuario,
  id_rol_participacion_caja,
  fecha_inicio,
  fecha_fin,
  activo,
  observacion,
  fecha_creacion,
  fecha_actualizacion
)
SELECT
  pr.id_sesion_caja,
  pr.id_usuario,
  pr.id_rol_participacion_caja,
  m.primer_cobro,
  NULL,
  true,
  pr.observacion,
  now() AT TIME ZONE 'America/Tegucigalpa',
  now() AT TIME ZONE 'America/Tegucigalpa'
FROM participantes_requeridos pr
CROSS JOIN marcas m
ON CONFLICT (id_sesion_caja, id_usuario) WHERE activo IS TRUE
DO UPDATE SET
  id_rol_participacion_caja = EXCLUDED.id_rol_participacion_caja,
  fecha_inicio = LEAST(public.cajas_sesiones_participantes.fecha_inicio, EXCLUDED.fecha_inicio),
  fecha_fin = NULL,
  activo = true,
  observacion = EXCLUDED.observacion,
  fecha_actualizacion = now() AT TIME ZONE 'America/Tegucigalpa';

WITH cobros_clasificados AS (
  SELECT
    fc.monto,
    CASE
      WHEN fc.id_usuario_ejecutor = cs.id_usuario_responsable THEN 'RESPONSABLE'
      WHEN EXISTS (
        SELECT 1
        FROM public.cajas_sesiones_participantes csp
        INNER JOIN public.cat_cajas_roles_participacion crp
          ON crp.id_rol_participacion_caja = csp.id_rol_participacion_caja
        WHERE csp.id_sesion_caja = fc.id_sesion_caja
          AND csp.id_usuario = fc.id_usuario_ejecutor
          AND UPPER(TRIM(crp.codigo)) = 'AUXILIAR'
      ) THEN 'AUXILIAR'
      ELSE 'EJECUTOR'
    END AS rol_operativo
  FROM public.facturas_cobros fc
  INNER JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = fc.id_sesion_caja
  WHERE fc.id_sesion_caja = 2
)
SELECT
  COALESCE(SUM(monto) FILTER (WHERE rol_operativo = 'RESPONSABLE'), 0)::numeric(12,2) AS total_responsable,
  COALESCE(SUM(monto) FILTER (WHERE rol_operativo = 'AUXILIAR'), 0)::numeric(12,2) AS total_auxiliares,
  COALESCE(SUM(monto) FILTER (WHERE rol_operativo = 'EJECUTOR'), 0)::numeric(12,2) AS total_otros_ejecutores,
  COALESCE(SUM(monto), 0)::numeric(12,2) AS total_teorico
FROM cobros_clasificados;

COMMIT;

