import { classifyPedidoOperationalRouting } from './pedidoOperationalRoutingService.js';

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
