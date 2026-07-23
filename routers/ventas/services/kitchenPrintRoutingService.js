const normalizeItemType = (item) => String(item?.tipo_item || '').trim().toUpperCase();

export const buildValidStandaloneKitchenExtraPredicate = (detailAlias) => `(
  SELECT COUNT(*) = 1
     AND COUNT(*) FILTER (
       WHERE dpe_route.id_extra IS NOT NULL
         AND NULLIF(TRIM(dpe_route.nombre_extra_snapshot), '') IS NOT NULL
         AND COALESCE(dpe_route.cantidad, 0) > 0
     ) = 1
  FROM public.detalle_pedido_extras dpe_route
  WHERE dpe_route.id_detalle_pedido = ${detailAlias}.id_detalle_pedido
    AND COALESCE(dpe_route.estado, true) = true
)`;

export const buildKitchenPreparationPredicate = (detailAlias) => `(
  (${detailAlias}.id_producto IS NULL AND ${detailAlias}.id_receta IS NOT NULL)
  OR (
    ${detailAlias}.id_producto IS NULL
    AND ${detailAlias}.id_receta IS NULL
    AND ${buildValidStandaloneKitchenExtraPredicate(detailAlias)}
  )
)`;

export const buildInvalidKitchenLinePredicate = (detailAlias) => `(
  (${detailAlias}.id_producto IS NOT NULL AND ${detailAlias}.id_receta IS NOT NULL)
  OR (
    ${detailAlias}.id_producto IS NULL
    AND ${detailAlias}.id_receta IS NULL
    AND NOT ${buildValidStandaloneKitchenExtraPredicate(detailAlias)}
  )
)`;

export const buildKitchenProductPredicate = (detailAlias, { hasConfiguration = true } = {}) => `(
  ${detailAlias}.id_producto IS NOT NULL
  AND ${detailAlias}.id_receta IS NULL
  ${hasConfiguration
    ? `AND LOWER(COALESCE(NULLIF(TRIM(${detailAlias}.configuracion_menu->>'entregar_con_pedido'), ''), 'true'))
         NOT IN ('false', '0', 'no')`
    : ''}
)`;

const readMenuConfig = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const shouldDeliverProductWithOrder = (item) => {
  const value = readMenuConfig(item?.configuracion_menu).entregar_con_pedido;
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['false', '0', 'no'].includes(normalized)) return false;
  return true;
};

export const isStandaloneKitchenExtra = (item) => {
  const type = normalizeItemType(item);
  const declaredStandalone = Boolean(
    item?.es_linea_extra_independiente
    || item?.origen_snapshot?.es_linea_extra_independiente
    || type === 'EXTRA'
    || type === 'EXTRA_INDEPENDIENTE'
  );
  if (!declaredStandalone) return false;
  const idExtra = Number(item?.id_extra || item?.origen_snapshot?.id_extra || 0);
  const name = String(item?.nombre_item || item?.nombre_producto || item?.nombre_extra_snapshot || '').trim();
  const quantity = Number(item?.cantidad || 0);
  return Number.isSafeInteger(idExtra) && idExtra > 0 && name.length > 0 && Number.isFinite(quantity) && quantity > 0;
};

export const isKitchenRecipe = (item) => {
  const type = normalizeItemType(item);
  const hasProduct = Number(item?.id_producto || 0) > 0;
  const hasRecipe = Number(item?.id_receta || 0) > 0;
  if (hasProduct && hasRecipe) return false;
  return !hasProduct && (hasRecipe || type === 'RECETA');
};

export const isKitchenProduct = (item) => {
  const type = normalizeItemType(item);
  const hasProduct = Number(item?.id_producto || 0) > 0;
  const hasRecipe = Number(item?.id_receta || 0) > 0;
  if (hasProduct && hasRecipe) return false;
  return !hasRecipe && !isStandaloneKitchenExtra(item) && (hasProduct || type === 'PRODUCTO');
};

export const isKitchenPreparation = (item) => (
  isKitchenRecipe(item) || isStandaloneKitchenExtra(item)
);

export const routeKitchenPrintItems = (items) => {
  const source = Array.isArray(items) ? items : [];
  const hasPreparations = source.some(isKitchenPreparation);
  if (!hasPreparations) return [];

  return source
    .filter((item) => (
      isKitchenPreparation(item)
      || (isKitchenProduct(item) && shouldDeliverProductWithOrder(item))
    ))
    .map((item) => ({
      ...item,
      instruccion_operativa: isKitchenProduct(item)
        ? 'ENTREGAR_JUNTO_CON_EL_PEDIDO'
        : 'PREPARAR'
    }));
};

export const hasKitchenPreparations = (items) => (
  (Array.isArray(items) ? items : []).some(isKitchenPreparation)
);

export const assertKitchenPrintPayload = (payload) => {
  const items = routeKitchenPrintItems(payload?.items);
  if (!hasKitchenPreparations(items)) {
    throw Object.assign(new Error('Este pedido no contiene preparaciones para cocina.'), {
      status: 409,
      code: 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
    });
  }
  return items;
};
