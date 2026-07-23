import {
  classifyPedidoOperationalRouting,
  DELIVERY_PREFERENCE_FALSE_VALUES,
  DELIVERY_PREFERENCE_TRUE_VALUES
} from './pedidoOperationalRoutingService.js';

const sqlStringList = (values) => values
  .map((value) => `'${String(value).replaceAll("'", "''")}'`)
  .join(', ');

const buildNormalizedDeliveryPreferenceExpression = (detailAlias) => (
  `REPLACE(LOWER(TRIM(${detailAlias}.configuracion_menu->>'entregar_con_pedido')), 'í', 'i')`
);

// Contrato SQL del KDS. Estos predicados deben mantenerse equivalentes a
// classifyPedidoOperationalRouting: cantidad entera positiva, nombre resoluble,
// IDs coherentes, extra independiente unico y preferencia estricta.
export const buildValidOperationalQuantityPredicate = (quantityExpression) => `(
  ${quantityExpression} IS NOT NULL
  AND ${quantityExpression} > 0
  AND (${quantityExpression})::numeric = TRUNC((${quantityExpression})::numeric)
)`;

export const buildValidKitchenProductNamePredicate = (detailAlias) => `EXISTS (
  SELECT 1
  FROM public.productos product_route
  WHERE product_route.id_producto = ${detailAlias}.id_producto
    AND NULLIF(TRIM(product_route.nombre_producto), '') IS NOT NULL
)`;

export const buildValidKitchenRecipeNamePredicate = (detailAlias) => `EXISTS (
  SELECT 1
  FROM public.recetas recipe_route
  WHERE recipe_route.id_receta = ${detailAlias}.id_receta
    AND NULLIF(TRIM(recipe_route.nombre_receta), '') IS NOT NULL
)`;

export const buildValidStandaloneKitchenExtraRowPredicate = (extraAlias) => `(
  ${extraAlias}.id_extra IS NOT NULL
  AND ${extraAlias}.id_extra > 0
  AND NULLIF(TRIM(${extraAlias}.nombre_extra_snapshot), '') IS NOT NULL
  AND ${buildValidOperationalQuantityPredicate(`${extraAlias}.cantidad`)}
)`;

export const buildValidStandaloneKitchenExtraPredicate = (detailAlias) => `(
  SELECT COUNT(*) = 1
     AND COUNT(*) FILTER (
       WHERE ${buildValidStandaloneKitchenExtraRowPredicate('dpe_route')}
     ) = 1
  FROM public.detalle_pedido_extras dpe_route
  WHERE dpe_route.id_detalle_pedido = ${detailAlias}.id_detalle_pedido
    AND COALESCE(dpe_route.estado, true) = true
)`;

export const buildValidDeliveryPreferencePredicate = (
  detailAlias,
  { hasConfiguration = true } = {}
) => {
  if (!hasConfiguration) return '(TRUE)';
  const normalized = buildNormalizedDeliveryPreferenceExpression(detailAlias);
  const acceptedStrings = sqlStringList([
    ...DELIVERY_PREFERENCE_TRUE_VALUES,
    ...DELIVERY_PREFERENCE_FALSE_VALUES
  ]);
  return `COALESCE((
    ${detailAlias}.configuracion_menu IS NULL
    OR (
      jsonb_typeof(${detailAlias}.configuracion_menu) = 'object'
      AND NOT (${detailAlias}.configuracion_menu ? 'entregar_con_pedido')
    )
    OR (
      jsonb_typeof(${detailAlias}.configuracion_menu) = 'object'
      AND ${detailAlias}.configuracion_menu ? 'entregar_con_pedido'
      AND (
        (
          jsonb_typeof(${detailAlias}.configuracion_menu->'entregar_con_pedido') = 'boolean'
          AND ${detailAlias}.configuracion_menu->>'entregar_con_pedido' IN ('true', 'false')
        )
        OR (
          jsonb_typeof(${detailAlias}.configuracion_menu->'entregar_con_pedido') = 'number'
          AND (
            ${detailAlias}.configuracion_menu->'entregar_con_pedido' = '1'::jsonb
            OR ${detailAlias}.configuracion_menu->'entregar_con_pedido' = '0'::jsonb
          )
        )
        OR (
          jsonb_typeof(${detailAlias}.configuracion_menu->'entregar_con_pedido') = 'string'
          AND ${normalized} IN (${acceptedStrings})
        )
      )
    )
  ), FALSE)`;
};

export const buildInvalidDeliveryPreferencePredicate = (
  detailAlias,
  options = {}
) => `(NOT ${buildValidDeliveryPreferencePredicate(detailAlias, options)})`;

export const buildProductDeliverWithOrderPredicate = (
  detailAlias,
  { hasConfiguration = true } = {}
) => {
  if (!hasConfiguration) return '(TRUE)';
  const normalized = buildNormalizedDeliveryPreferenceExpression(detailAlias);
  const acceptedTrueStrings = sqlStringList(DELIVERY_PREFERENCE_TRUE_VALUES);
  return `COALESCE((
    ${detailAlias}.configuracion_menu IS NULL
    OR (
      jsonb_typeof(${detailAlias}.configuracion_menu) = 'object'
      AND NOT (${detailAlias}.configuracion_menu ? 'entregar_con_pedido')
    )
    OR (
      jsonb_typeof(${detailAlias}.configuracion_menu) = 'object'
      AND ${detailAlias}.configuracion_menu ? 'entregar_con_pedido'
      AND (
        (
          jsonb_typeof(${detailAlias}.configuracion_menu->'entregar_con_pedido') = 'boolean'
          AND ${detailAlias}.configuracion_menu->'entregar_con_pedido' = 'true'::jsonb
        )
        OR (
          jsonb_typeof(${detailAlias}.configuracion_menu->'entregar_con_pedido') = 'number'
          AND ${detailAlias}.configuracion_menu->'entregar_con_pedido' = '1'::jsonb
        )
        OR (
          jsonb_typeof(${detailAlias}.configuracion_menu->'entregar_con_pedido') = 'string'
          AND ${normalized} IN (${acceptedTrueStrings})
        )
      )
    )
  ), FALSE)`;
};

export const buildValidKitchenRecipePredicate = (detailAlias) => `(
  ${detailAlias}.id_producto IS NULL
  AND ${detailAlias}.id_receta IS NOT NULL
  AND ${detailAlias}.id_receta > 0
  AND ${buildValidOperationalQuantityPredicate(`${detailAlias}.cantidad`)}
  AND ${buildValidKitchenRecipeNamePredicate(detailAlias)}
)`;

export const buildValidKitchenProductPredicate = (
  detailAlias,
  { hasConfiguration = true } = {}
) => `(
  ${detailAlias}.id_producto IS NOT NULL
  AND ${detailAlias}.id_producto > 0
  AND ${detailAlias}.id_receta IS NULL
  AND ${buildValidOperationalQuantityPredicate(`${detailAlias}.cantidad`)}
  AND ${buildValidKitchenProductNamePredicate(detailAlias)}
  AND ${buildValidDeliveryPreferencePredicate(detailAlias, { hasConfiguration })}
)`;

export const buildKitchenPreparationPredicate = (detailAlias) => `(
  ${buildValidKitchenRecipePredicate(detailAlias)}
  OR (
    ${detailAlias}.id_producto IS NULL
    AND ${detailAlias}.id_receta IS NULL
    AND ${buildValidStandaloneKitchenExtraPredicate(detailAlias)}
  )
)`;

export const buildInvalidKitchenLinePredicate = (
  detailAlias,
  { hasConfiguration = true } = {}
) => `(
  (${detailAlias}.id_producto IS NOT NULL AND ${detailAlias}.id_receta IS NOT NULL)
  OR (
    ${detailAlias}.id_producto IS NOT NULL
    AND ${detailAlias}.id_receta IS NULL
    AND NOT ${buildValidKitchenProductPredicate(detailAlias, { hasConfiguration })}
  )
  OR (
    ${detailAlias}.id_producto IS NULL
    AND ${detailAlias}.id_receta IS NOT NULL
    AND NOT ${buildValidKitchenRecipePredicate(detailAlias)}
  )
  OR (
    ${detailAlias}.id_producto IS NULL
    AND ${detailAlias}.id_receta IS NULL
    AND NOT ${buildValidStandaloneKitchenExtraPredicate(detailAlias)}
  )
)`;

export const buildKitchenProductPredicate = (detailAlias, { hasConfiguration = true } = {}) => `(
  ${buildValidKitchenProductPredicate(detailAlias, { hasConfiguration })}
  AND ${buildProductDeliverWithOrderPredicate(detailAlias, { hasConfiguration })}
)`;

export const buildKitchenOrderEligibilityPredicate = (
  orderAlias,
  { hasConfiguration = true } = {}
) => `(
  EXISTS (
    SELECT 1
    FROM public.detalle_pedido dp_route
    WHERE dp_route.id_pedido = ${orderAlias}.id_pedido
      AND COALESCE(dp_route.estado, true) = true
      AND ${buildKitchenPreparationPredicate('dp_route')}
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.detalle_pedido dp_invalid
    WHERE dp_invalid.id_pedido = ${orderAlias}.id_pedido
      AND COALESCE(dp_invalid.estado, true) = true
      AND ${buildInvalidKitchenLinePredicate('dp_invalid', { hasConfiguration })}
  )
)`;

const toKdsClassifierItem = (row) => {
  const isStandaloneExtra = row?.id_extra_independiente !== null
    && row?.id_extra_independiente !== undefined;
  return {
    id_detalle: row?.id_detalle_pedido,
    tipo_item: isStandaloneExtra
      ? 'EXTRA'
      : row?.id_producto !== null && row?.id_producto !== undefined
        ? 'PRODUCTO'
        : row?.id_receta !== null && row?.id_receta !== undefined
          ? 'RECETA'
          : 'ITEM',
    id_producto: row?.id_producto,
    id_receta: row?.id_receta,
    id_extra: isStandaloneExtra ? row?.id_extra_independiente : null,
    es_linea_extra_independiente: isStandaloneExtra,
    cantidad: row?.cantidad,
    nombre_item: row?.nombre_item,
    configuracion_menu: row?.configuracion_menu ?? null,
    configuracion_menu_json_type: row?.configuracion_menu_json_type ?? null,
    extras: []
  };
};

// Defensa posterior a la consulta: no sustituye los filtros SQL. Reutiliza el
// clasificador central sobre las filas ya obtenidas y descarta el pedido entero
// si una condicion inesperada produce una linea invalida o un grupo sin cocina.
export const routeKdsOperationalRows = (rows) => {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.id_pedido ?? '');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const routedRows = [];
  for (const orderRows of grouped.values()) {
    const detailRows = orderRows.filter((row) => row?.id_detalle_pedido !== null
      && row?.id_detalle_pedido !== undefined);
    const routing = classifyPedidoOperationalRouting(detailRows.map(toKdsClassifierItem));
    if (routing.requiere_revision || !routing.requiere_cocina) continue;

    const preparationByIndex = new Set(routing.items_preparables.map((item) => item.indice));
    const deliveryByIndex = new Set(routing.items_entrega_conjunta.map((item) => item.indice));
    for (let index = 0; index < detailRows.length; index += 1) {
      if (preparationByIndex.has(index)) {
        routedRows.push({
          ...detailRows[index],
          kds_instruccion_operativa: 'PREPARAR'
        });
      } else if (deliveryByIndex.has(index)) {
        routedRows.push({
          ...detailRows[index],
          kds_instruccion_operativa: 'ENTREGAR_JUNTO_CON_EL_PEDIDO'
        });
      }
    }
  }
  return routedRows;
};

const kitchenRoutingError = (message, code, lineasInvalidas = []) => Object.assign(
  new Error(message),
  {
    status: 409,
    code,
    requiere_revision: code === 'PRINT_PEDIDO_REQUIERE_REVISION',
    lineas_invalidas: lineasInvalidas
  }
);

export const classifyKitchenPrintItems = (items) => {
  const source = Array.isArray(items) ? items : [];
  const routing = classifyPedidoOperationalRouting(source);
  const prepararByIndex = new Map(
    routing.items_preparables.map((item) => [item.indice, item])
  );
  const entregarByIndex = new Set(
    routing.items_entrega_conjunta.map((item) => item.indice)
  );
  const operationalItems = routing.requiere_revision
    ? []
    : source.flatMap((item, index) => {
      const preparar = prepararByIndex.get(index);
      if (preparar) {
        const isStandaloneExtra = preparar.tipo_item === 'EXTRA_INDEPENDIENTE';
        return [{
          ...item,
          ...(isStandaloneExtra ? {
            tipo_item: 'EXTRA',
            id_extra: preparar.id_extra,
            nombre_item: preparar.nombre_item,
            nombre_extra_snapshot: preparar.nombre_extra_snapshot,
            cantidad: preparar.cantidad,
            es_linea_extra_independiente: true,
            extras: []
          } : {}),
          instruccion_operativa: 'PREPARAR'
        }];
      }
      if (entregarByIndex.has(index)) {
        return [{ ...item, instruccion_operativa: 'ENTREGAR_JUNTO_CON_EL_PEDIDO' }];
      }
      return [];
    });

  return {
    ...routing,
    items_operativos: operationalItems
  };
};

export const findInvalidKitchenItems = (items) => (
  classifyKitchenPrintItems(items).lineas_invalidas
);

export const assertValidKitchenItems = (items) => {
  const classification = classifyKitchenPrintItems(items);
  if (classification.requiere_revision) {
    throw kitchenRoutingError(
      'El pedido contiene lineas invalidas y requiere revision antes de imprimir.',
      'PRINT_PEDIDO_REQUIERE_REVISION',
      classification.lineas_invalidas
    );
  }
  return classification;
};

export const routeKitchenPrintItems = (items) => {
  return assertValidKitchenItems(items).items_operativos;
};

export const hasKitchenPreparations = (items) => (
  classifyKitchenPrintItems(items).requiere_cocina
);

export const assertKitchenPrintPayload = (payload) => {
  const declaredInvalidItems = Array.isArray(payload?.lineas_invalidas)
    ? payload.lineas_invalidas
    : [];
  if (payload?.requiere_revision === true || declaredInvalidItems.length > 0) {
    throw kitchenRoutingError(
      'El pedido contiene lineas invalidas y requiere revision antes de imprimir.',
      'PRINT_PEDIDO_REQUIERE_REVISION',
      declaredInvalidItems
    );
  }
  if (payload?.requiere_cocina === false) {
    throw kitchenRoutingError(
      'Este pedido no contiene preparaciones para cocina.',
      'PRINT_PEDIDO_NO_REQUIERE_COCINA'
    );
  }
  const classification = assertValidKitchenItems(payload?.items);
  if (!classification.requiere_cocina) {
    throw kitchenRoutingError(
      'Este pedido no contiene preparaciones para cocina.',
      'PRINT_PEDIDO_NO_REQUIERE_COCINA'
    );
  }
  return classification.items_operativos;
};
