const parsePositiveInt = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  const normalized = String(value ?? '').trim();
  if (!/^0*[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const roundInventory = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(6));
};

export const buildRecipeInventorySnapshot = ({ line, components }) => {
  const idReceta = parsePositiveInt(line?.id_receta);
  const cantidadLinea = roundInventory(line?.cantidad);
  if (!idReceta || cantidadLinea <= 0) return null;

  const snapshotComponents = (Array.isArray(components) ? components : [])
    .map((row) => {
      const idInsumo = parsePositiveInt(row?.id_insumo);
      const idAlmacen = parsePositiveInt(row?.id_almacen);
      const factorPorUnidad = roundInventory(row?.factor_por_unidad);
      const idUnidadMedida = parsePositiveInt(row?.id_unidad_medida);
      const idUnidadBase = parsePositiveInt(row?.id_unidad_base) || idUnidadMedida;
      if (!idInsumo || !idAlmacen || factorPorUnidad <= 0 || !idUnidadMedida || !idUnidadBase) return null;
      return {
        id_insumo: idInsumo,
        id_almacen: idAlmacen,
        factor_por_unidad: factorPorUnidad,
        cantidad_linea: cantidadLinea,
        cantidad_total: roundInventory(factorPorUnidad * cantidadLinea),
        id_unidad_medida: idUnidadMedida,
        id_unidad_base: idUnidadBase
      };
    })
    .filter(Boolean);

  if (snapshotComponents.length === 0) return null;

  return {
    version: 1,
    id_receta: idReceta,
    cantidad_linea: cantidadLinea,
    componentes: snapshotComponents
  };
};

export const attachRecipeInventorySnapshotsToLines = async ({ client, lines = [], idSucursal }) => {
  const recetaIds = [...new Set((Array.isArray(lines) ? lines : [])
    .map((line) => parsePositiveInt(line?.id_receta))
    .filter(Boolean))];
  const sucursalId = parsePositiveInt(idSucursal);
  if (!recetaIds.length || !sucursalId) return lines;

  const result = await client.query(
    `
      SELECT
        dr.id_receta,
        dr.id_insumo,
        COALESCE(dr.cant, 0)::numeric AS factor_por_unidad,
        dr.id_unidad_medida,
        COALESCE(i.id_unidad_medida, dr.id_unidad_medida) AS id_unidad_base,
        ia.id_almacen
      FROM public.detalle_recetas dr
      INNER JOIN public.insumos i
        ON i.id_insumo = dr.id_insumo
       AND COALESCE(i.estado, true) = true
      INNER JOIN public.insumos_almacenes ia
        ON ia.id_insumo = dr.id_insumo
       AND COALESCE(ia.estado, true) = true
      INNER JOIN public.almacenes a
        ON a.id_almacen = ia.id_almacen
       AND a.id_sucursal = $2
       AND COALESCE(a.estado, true) = true
      WHERE dr.id_receta = ANY($1::int[])
        AND COALESCE(dr.estado, true) = true
      ORDER BY dr.id_receta, dr.id_insumo, ia.id_almacen
    `,
    [recetaIds, sucursalId]
  );

  const componentsByRecipe = new Map();
  for (const row of result.rows || []) {
    const idReceta = parsePositiveInt(row.id_receta);
    if (!idReceta) continue;
    if (!componentsByRecipe.has(idReceta)) componentsByRecipe.set(idReceta, []);
    componentsByRecipe.get(idReceta).push(row);
  }

  return lines.map((line) => {
    const idReceta = parsePositiveInt(line?.id_receta);
    if (!idReceta) return line;
    const snapshot = buildRecipeInventorySnapshot({
      line,
      components: componentsByRecipe.get(idReceta) || []
    });
    if (!snapshot) return line;
    return {
      ...line,
      configuracion_menu: {
        ...(line.configuracion_menu && typeof line.configuracion_menu === 'object' ? line.configuracion_menu : {}),
        inventario_receta: snapshot
      }
    };
  });
};
