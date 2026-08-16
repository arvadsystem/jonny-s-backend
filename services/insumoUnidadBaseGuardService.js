export const INSUMO_UNIDAD_BASE_CON_PRESENTACIONES_INCOMPATIBLES =
  'INSUMO_UNIDAD_BASE_CON_PRESENTACIONES_INCOMPATIBLES';

const normalizeUnitId = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const validateInsumoUnidadBaseChange = async ({
  idInsumo,
  nombreInsumo,
  currentUnitId,
  nextUnitId
}, db) => {
  const current = normalizeUnitId(currentUnitId);
  const next = normalizeUnitId(nextUnitId);
  if (current === next) return { ok: true, changed: false };

  const result = await db.query(
    `
      SELECT id_presentacion, nombre_presentacion
      FROM public.insumo_presentaciones
      WHERE id_insumo = $1
        AND COALESCE(estado, true) IS TRUE
        AND id_unidad_base IS DISTINCT FROM $2::integer
      ORDER BY id_presentacion ASC
      LIMIT 5
    `,
    [idInsumo, next]
  );

  if ((result.rows || []).length === 0) return { ok: true, changed: true };

  const name = String(nombreInsumo ?? 'el insumo').replace(/\s+/g, ' ').trim() || 'el insumo';
  return {
    ok: false,
    status: 409,
    code: INSUMO_UNIDAD_BASE_CON_PRESENTACIONES_INCOMPATIBLES,
    message: `No se puede cambiar la unidad base de ${name} porque tiene presentaciones activas configuradas con otra unidad. Inactiva o corrige esas presentaciones antes de cambiar la unidad base.`
  };
};
