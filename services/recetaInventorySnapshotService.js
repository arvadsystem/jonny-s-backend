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

const createRecipeSnapshotError = (code, message, details = {}) => {
  const error = new Error(message);
  error.httpStatus = 409;
  error.status = 409;
  error.code = code;
  error.publicMessage = message;
  error.details = details;
  return error;
};

const ensureRecipeSnapshot = (condition, code, message, details) => {
  if (!condition) throw createRecipeSnapshotError(code, message, details);
};

export const buildRecipeInventorySnapshot = ({ line, components }) => {
  const idReceta = parsePositiveInt(line?.id_receta);
  const cantidadLinea = roundInventory(line?.cantidad);
  ensureRecipeSnapshot(
    idReceta && cantidadLinea > 0,
    'RECETA_SNAPSHOT_LINEA_INVALIDA',
    'La linea de receta no tiene cantidad valida para inventario.'
  );

  const rows = Array.isArray(components) ? components : [];
  ensureRecipeSnapshot(
    rows.length > 0,
    'RECETA_SNAPSHOT_SIN_COMPONENTES',
    'La receta no tiene componentes activos configurados para inventario.',
    { id_receta: idReceta }
  );

  const grouped = new Map();
  for (const row of rows) {
    const idInsumo = parsePositiveInt(row?.id_insumo);
    ensureRecipeSnapshot(
      idInsumo,
      'RECETA_SNAPSHOT_COMPONENTE_INVALIDO',
      'La receta tiene un componente de inventario invalido.',
      { id_receta: idReceta }
    );
    if (!grouped.has(idInsumo)) grouped.set(idInsumo, []);
    grouped.get(idInsumo).push(row);
  }

  const snapshotComponents = [];
  for (const [idInsumo, componentRows] of grouped.entries()) {
    ensureRecipeSnapshot(
      componentRows.length === 1,
      'RECETA_SNAPSHOT_COMPONENTE_DUPLICADO',
      'La receta tiene el mismo insumo configurado mas de una vez.',
      { id_receta: idReceta, id_insumo: idInsumo }
    );

    const row = componentRows[0];
    const factorPorUnidad = roundInventory(row?.factor_por_unidad);
    const idUnidadMedida = parsePositiveInt(row?.id_unidad_medida);
    const idUnidadBase = parsePositiveInt(row?.id_unidad_base);
    const warehouses = Array.isArray(row?.almacenes)
      ? row.almacenes.map((id) => parsePositiveInt(id)).filter(Boolean)
      : [];
    const uniqueWarehouses = [...new Set(warehouses)];

    ensureRecipeSnapshot(
      factorPorUnidad > 0 && idUnidadMedida && idUnidadBase,
      'RECETA_SNAPSHOT_COMPONENTE_INVALIDO',
      'La receta tiene un componente de inventario invalido.',
      { id_receta: idReceta, id_insumo: idInsumo }
    );
    ensureRecipeSnapshot(
      idUnidadMedida === idUnidadBase,
      'RECETA_SNAPSHOT_UNIDAD_INVALIDA',
      'La unidad del componente de receta no coincide con la unidad base del insumo.',
      { id_receta: idReceta, id_insumo: idInsumo, id_unidad_medida: idUnidadMedida, id_unidad_base: idUnidadBase }
    );
    ensureRecipeSnapshot(
      uniqueWarehouses.length > 0,
      'RECETA_SNAPSHOT_ALMACEN_NO_ENCONTRADO',
      'La receta tiene un insumo sin almacen activo para la sucursal.',
      { id_receta: idReceta, id_insumo: idInsumo }
    );
    ensureRecipeSnapshot(
      uniqueWarehouses.length === 1,
      'RECETA_SNAPSHOT_ALMACEN_AMBIGUO',
      'La receta tiene un insumo con mas de un almacen activo para la sucursal.',
      { id_receta: idReceta, id_insumo: idInsumo, almacenes: uniqueWarehouses }
    );

    const cantidadTotal = roundInventory(factorPorUnidad * cantidadLinea);
    ensureRecipeSnapshot(
      cantidadTotal > 0,
      'RECETA_SNAPSHOT_TOTAL_INVALIDO',
      'La cantidad total del componente de receta no es valida.',
      { id_receta: idReceta, id_insumo: idInsumo }
    );

    snapshotComponents.push({
      id_insumo: idInsumo,
      id_almacen: uniqueWarehouses[0],
      factor_por_unidad: factorPorUnidad,
      cantidad_linea: cantidadLinea,
      cantidad_total: cantidadTotal,
      id_unidad_medida: idUnidadMedida,
      id_unidad_base: idUnidadBase
    });
  }

  return {
    version: 1,
    id_receta: idReceta,
    cantidad_linea: cantidadLinea,
    componentes: snapshotComponents
  };
};

export const attachRecipeInventorySnapshotsToLines = async ({ client, lines = [], idSucursal }) => {
  const sourceLines = Array.isArray(lines) ? lines : [];
  const recetaIds = [...new Set(sourceLines
    .map((line) => parsePositiveInt(line?.id_receta))
    .filter(Boolean))];
  const sucursalId = parsePositiveInt(idSucursal);
  if (!recetaIds.length) return sourceLines;
  ensureRecipeSnapshot(
    sucursalId,
    'RECETA_SNAPSHOT_SUCURSAL_INVALIDA',
    'No se pudo determinar la sucursal para hidratar inventario de receta.'
  );

  const result = await client.query(
    `
      SELECT
        dr.id_receta,
        dr.id_insumo,
        COALESCE(dr.cant, 0)::numeric AS factor_por_unidad,
        dr.id_unidad_medida,
        COALESCE(i.id_unidad_medida, dr.id_unidad_medida) AS id_unidad_base,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.id_almacen), NULL) AS almacenes
      FROM public.detalle_recetas dr
      LEFT JOIN public.insumos i
        ON i.id_insumo = dr.id_insumo
       AND COALESCE(i.estado, true) = true
      LEFT JOIN public.insumos_almacenes ia
        ON ia.id_insumo = dr.id_insumo
       AND COALESCE(ia.estado, true) = true
      LEFT JOIN public.almacenes a
        ON a.id_almacen = ia.id_almacen
       AND a.id_sucursal = $2
       AND COALESCE(a.estado, true) = true
      WHERE dr.id_receta = ANY($1::int[])
        AND COALESCE(dr.estado, true) = true
      GROUP BY dr.id_receta, dr.id_insumo, dr.cant, dr.id_unidad_medida, i.id_unidad_medida
      ORDER BY dr.id_receta, dr.id_insumo
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

  return sourceLines.map((line) => {
    const idReceta = parsePositiveInt(line?.id_receta);
    if (!idReceta) return line;
    const snapshot = buildRecipeInventorySnapshot({
      line,
      components: componentsByRecipe.get(idReceta) || []
    });
    return {
      ...line,
      configuracion_menu: {
        ...(line.configuracion_menu && typeof line.configuracion_menu === 'object' ? line.configuracion_menu : {}),
        inventario_receta: snapshot
      }
    };
  });
};
