import { resolveEstadoPedidoIdByCode } from './catalogLookupService.js';
import { resolveStandaloneExtraLine } from '../utils/parseUtils.js';

export const PEDIDO_OPERATIONAL_ACTION = Object.freeze({
  SEND_TO_KITCHEN: 'ENVIAR_COCINA',
  READY_FOR_DELIVERY: 'LISTO_PARA_ENTREGA',
  COMPLETE: 'COMPLETAR',
  REVIEW: 'REQUIERE_REVISION',
  AWAIT_VALIDATION: 'PENDIENTE_VALIDACION'
});

export const PEDIDO_ORIGIN = Object.freeze({
  PUBLIC_MENU: 'PUBLIC_MENU',
  INTERNAL_POS: 'INTERNAL_POS',
  UNKNOWN: 'UNKNOWN'
});

const PEDIDO_INITIAL_ROUTING_CURRENT_STATE = Object.freeze({
  PENDING: 'PENDIENTE',
  KITCHEN: 'EN_COCINA'
});

const PEDIDO_INITIAL_ROUTING_ADVANCED_STATES = new Set([
  'EN_PREPARACION',
  'LISTO_PARA_ENTREGA',
  'COMPLETADO',
  'NO_ENTREGADO'
]);

const PEDIDO_INITIAL_ROUTING_ALLOWED_TARGETS = new Set([
  'EN_COCINA',
  'LISTO_PARA_ENTREGA',
  'COMPLETADO'
]);

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeLineType = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, '_');

const STANDALONE_EXTRA_TYPES = new Set(['EXTRA', 'EXTRA_INDEPENDIENTE']);

const normalizeCode = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, '_');

export const resolvePedidoOrigin = ({ origen_pedido: persistedSource } = {}) => {
  const normalizedSource = normalizeCode(persistedSource);
  if (normalizedSource === 'MENU') return PEDIDO_ORIGIN.PUBLIC_MENU;
  if (normalizedSource === 'CAJA') return PEDIDO_ORIGIN.INTERNAL_POS;
  return PEDIDO_ORIGIN.UNKNOWN;
};

export const DELIVERY_PREFERENCE_TRUE_VALUES = Object.freeze(['true', '1', 'si']);
export const DELIVERY_PREFERENCE_FALSE_VALUES = Object.freeze(['false', '0', 'no']);

const parseObject = (value) => {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { valid: true, value };
  }
  return { valid: false, value: null };
};

const parseHistoricalObject = (value) => {
  const parsedObject = parseObject(value);
  if (parsedObject.valid || typeof value !== 'string' || !value.trim()) {
    return parsedObject;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { valid: true, value: parsed }
      : { valid: false, value: null };
  } catch {
    return { valid: false, value: null };
  }
};

const parseOperationalQuantity = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};

const normalizeConfigurationJsonType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
};

const readDeliveryPreference = (line) => {
  const jsonType = normalizeConfigurationJsonType(line?.configuracion_menu_json_type);
  if (jsonType === 'sql_null') {
    return { presente: false, valida: true, valor: null };
  }
  if (jsonType && jsonType !== 'object') {
    return { presente: true, valida: false, valor: null };
  }

  const parsedConfig = parseObject(line?.configuracion_menu);
  if (!parsedConfig.valid) {
    return { presente: true, valida: false, valor: null };
  }
  const config = parsedConfig.value;
  if (jsonType === 'object' && !config) {
    return { presente: true, valida: false, valor: null };
  }
  if (!config || !Object.hasOwn(config, 'entregar_con_pedido')) {
    return { presente: false, valida: true, valor: null };
  }

  const value = config.entregar_con_pedido;
  if (typeof value === 'boolean') {
    return { presente: true, valida: true, valor: value };
  }
  if (typeof value === 'number') {
    if (value === 1) return { presente: true, valida: true, valor: true };
    if (value === 0) return { presente: true, valida: true, valor: false };
    return { presente: true, valida: false, valor: null };
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'sí' || DELIVERY_PREFERENCE_TRUE_VALUES.includes(normalized)) {
      return { presente: true, valida: true, valor: true };
    }
    if (DELIVERY_PREFERENCE_FALSE_VALUES.includes(normalized)) {
      return { presente: true, valida: true, valor: false };
    }
  }
  return { presente: true, valida: false, valor: null };
};

const buildLineReference = (line, index) => {
  const tipoItem = normalizeLineType(line?.tipo_item || line?.kind);
  const idExtra = toPositiveInteger(line?.id_extra ?? line?.origen_snapshot?.id_extra);
  const deliveryPreference = readDeliveryPreference(line);
  return {
    id_detalle_pedido: toPositiveInteger(line?.id_detalle_pedido ?? line?.id_detalle) || null,
    indice: index,
    tipo_item: tipoItem || null,
    id_producto: toPositiveInteger(line?.id_producto),
    id_receta: toPositiveInteger(line?.id_receta),
    id_extra: idExtra,
    es_linea_extra_independiente: Boolean(
      line?.es_linea_extra_independiente
      || line?.origen_snapshot?.es_linea_extra_independiente
      || STANDALONE_EXTRA_TYPES.has(tipoItem)
      || idExtra
    ),
    nombre_item: String(
      line?.nombre_item
      || line?.nombre_producto
      || line?.nombre_extra_snapshot
      || line?.origen_snapshot?.nombre_extra_snapshot
      || ''
    ).trim() || null,
    cantidad: parseOperationalQuantity(line?.cantidad),
    entregar_con_pedido: deliveryPreference.valor,
    preferencia_entrega_presente: deliveryPreference.presente,
    preferencia_entrega_valida: deliveryPreference.valida
  };
};

const isDeliveryChargeLine = (line, reference) => {
  const snapshot = parseHistoricalObject(line?.origen_snapshot);
  return snapshot.valid
    && normalizeCode(snapshot.value?.origen) === 'DELIVERY'
    && reference.tipo_item === 'ITEM'
    && !reference.id_producto
    && !reference.id_receta
    && !reference.id_extra
    && !reference.es_linea_extra_independiente;
};

const resolveDeclaredStandaloneExtra = (line, reference) => {
  if (!reference.es_linea_extra_independiente) return null;
  if (!reference.id_extra || !reference.nombre_item || !reference.cantidad) return null;
  return {
    id_extra: reference.id_extra,
    nombre_extra_snapshot: reference.nombre_item,
    codigo_extra_snapshot: String(
      line?.codigo_extra_snapshot || line?.origen_snapshot?.codigo_extra_snapshot || ''
    ).trim() || null,
    cantidad: reference.cantidad,
    precio_unitario: line?.precio_unitario ?? null,
    subtotal: line?.subtotal ?? null
  };
};

const resolveClassificationConflict = (reference) => {
  const { tipo_item: tipoItem, id_producto: idProducto, id_receta: idReceta } = reference;
  if (reference.es_linea_extra_independiente && (idProducto || idReceta)) {
    return 'CLASIFICACION_EXTRA_CON_PRODUCTO_O_RECETA';
  }
  if (tipoItem === 'PRODUCTO' && (!idProducto || idReceta)) return 'CLASIFICACION_PRODUCTO_CONTRADICTORIA';
  if (tipoItem === 'RECETA' && (!idReceta || idProducto)) return 'CLASIFICACION_RECETA_CONTRADICTORIA';
  return null;
};

const invalidLine = (reference, motivo) => ({
  ...reference,
  tipo_clasificacion: 'LINEA_INVALIDA',
  motivo
});

export const classifyPedidoOperationalRouting = (lines, context = {}) => {
  const sourceLines = Array.isArray(lines) ? lines : [];
  const productos = [];
  const recetas = [];
  const extrasIndependientes = [];
  const itemsNoCocina = [];
  const lineasInvalidas = [];

  sourceLines.forEach((line, index) => {
    const reference = buildLineReference(line, index);
    const hasProducto = Boolean(reference.id_producto);
    const hasReceta = Boolean(reference.id_receta);
    const classificationConflict = resolveClassificationConflict(reference);

    if (isDeliveryChargeLine(line, reference)) {
      itemsNoCocina.push({
        ...reference,
        tipo_clasificacion: 'CARGO_NO_COCINA'
      });
    } else if (hasProducto && hasReceta) {
      lineasInvalidas.push(invalidLine(reference, 'PRODUCTO_Y_RECETA_SIMULTANEOS'));
    } else if (classificationConflict) {
      lineasInvalidas.push(invalidLine(reference, classificationConflict));
    } else if (hasProducto) {
      if (!reference.cantidad) {
        lineasInvalidas.push(invalidLine(reference, 'CANTIDAD_INVALIDA'));
      } else if (!reference.nombre_item) {
        lineasInvalidas.push(invalidLine(reference, 'NOMBRE_INVALIDO'));
      } else if (!reference.preferencia_entrega_valida) {
        lineasInvalidas.push(invalidLine(reference, 'PREFERENCIA_ENTREGA_INVALIDA'));
      } else {
        productos.push({ ...reference, tipo_clasificacion: 'PRODUCTO' });
      }
    } else if (hasReceta) {
      if (!reference.cantidad) {
        lineasInvalidas.push(invalidLine(reference, 'CANTIDAD_INVALIDA'));
      } else if (!reference.nombre_item) {
        lineasInvalidas.push(invalidLine(reference, 'NOMBRE_INVALIDO'));
      } else {
        recetas.push({
          ...reference,
          tipo_item: 'RECETA',
          tipo_clasificacion: 'RECETA'
        });
      }
    } else {
      const extras = Array.isArray(line?.extras) ? line.extras : [];
      const standaloneExtra = resolveDeclaredStandaloneExtra(line, reference)
        || resolveStandaloneExtraLine({
          idProducto: reference.id_producto,
          idReceta: reference.id_receta,
          extras
        });
      if (standaloneExtra) {
        const standaloneQuantity = parseOperationalQuantity(standaloneExtra.cantidad);
        if (!standaloneQuantity) {
          lineasInvalidas.push(invalidLine(reference, 'CANTIDAD_INVALIDA'));
        } else {
          extrasIndependientes.push({
            ...reference,
            tipo_item: 'EXTRA_INDEPENDIENTE',
            tipo_clasificacion: 'EXTRA_INDEPENDIENTE',
            id_extra: standaloneExtra.id_extra,
            nombre_item: standaloneExtra.nombre_extra_snapshot,
            nombre_extra_snapshot: standaloneExtra.nombre_extra_snapshot,
            codigo_extra_snapshot: standaloneExtra.codigo_extra_snapshot,
            cantidad: standaloneQuantity,
            precio_unitario: standaloneExtra.precio_unitario,
            subtotal: standaloneExtra.subtotal,
            entregar_con_pedido: null
          });
        }
      } else {
        const motivo = reference.es_linea_extra_independiente
          ? (!reference.cantidad ? 'CANTIDAD_INVALIDA' : 'EXTRA_INDEPENDIENTE_INVALIDO')
          : extras.length > 1
            ? 'EXTRAS_INDEPENDIENTES_AMBIGUOS'
            : extras.length === 1 && parseOperationalQuantity(extras[0]?.cantidad) === null
              ? 'CANTIDAD_INVALIDA'
              : extras.length === 1
                ? 'EXTRA_INDEPENDIENTE_INVALIDO'
                : 'LINEA_SIN_CLASIFICACION';
        lineasInvalidas.push(invalidLine(reference, motivo));
      }
    }
  });

  if (sourceLines.length === 0) {
    lineasInvalidas.push({
      id_detalle_pedido: null,
      indice: null,
      id_producto: null,
      id_receta: null,
      tipo_clasificacion: 'LINEA_INVALIDA',
      motivo: 'PEDIDO_SIN_DETALLE'
    });
  }

  const itemsPreparables = [...recetas, ...extrasIndependientes];
  const hasPreparables = itemsPreparables.length > 0;
  const productosClasificados = productos.map((line) => ({
    ...line,
    entregar_con_pedido: hasPreparables ? line.entregar_con_pedido !== false : false
  }));
  const itemsEntregaConjunta = hasPreparables
    ? productosClasificados.filter((line) => line.entregar_con_pedido)
    : [];
  const itemsEntregaInmediata = productosClasificados.filter((line) => !line.entregar_con_pedido);
  const requiereRevision = lineasInvalidas.length > 0;
  const requiereCocina = !requiereRevision && hasPreparables;
  const estadoPago = normalizeCode(context.estado_pago);
  const canal = normalizeCode(context.canal);
  const modalidad = normalizeCode(context.modalidad ?? context.tipo_entrega);
  const origenPedido = resolvePedidoOrigin(context);
  const publicValidationCompleted = origenPedido === PEDIDO_ORIGIN.PUBLIC_MENU
    && (
      context.public_validation_completed === true
      || (
        context.pago_confirmado_at !== null
        && context.pago_confirmado_at !== undefined
        && String(context.pago_confirmado_at).trim() !== ''
      )
    );
  const pendienteValidacionPublica = origenPedido === PEDIDO_ORIGIN.PUBLIC_MENU
    && !publicValidationCompleted;
  const origenDesconocido = origenPedido === PEDIDO_ORIGIN.UNKNOWN;
  const requiereValidacionOrigen = pendienteValidacionPublica || origenDesconocido;
  const isPaidLocalConsumption = estadoPago === 'PAGADO_CONFIRMADO'
    && ['LOCAL', 'POS', 'CAJA'].includes(canal)
    && ['CONSUMO_LOCAL', 'LOCAL', 'EN_LOCAL'].includes(modalidad);

  let accionOperativa;
  let estadoInicial;
  if (requiereRevision) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.REVIEW;
    estadoInicial = 'PENDIENTE';
  } else if (requiereValidacionOrigen) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.AWAIT_VALIDATION;
    estadoInicial = 'PENDIENTE';
  } else if (requiereCocina) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.SEND_TO_KITCHEN;
    estadoInicial = 'EN_COCINA';
  } else if (isPaidLocalConsumption) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.COMPLETE;
    estadoInicial = 'COMPLETADO';
  } else {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.READY_FOR_DELIVERY;
    estadoInicial = 'LISTO_PARA_ENTREGA';
  }

  return {
    requiere_cocina: requiereCocina,
    items_preparables: itemsPreparables,
    items_entrega_conjunta: itemsEntregaConjunta,
    items_entrega_inmediata: itemsEntregaInmediata,
    items_no_cocina: itemsNoCocina,
    items_sin_clasificar: lineasInvalidas,
    productos: productosClasificados,
    recetas,
    extras_independientes: extrasIndependientes,
    requiere_revision: requiereRevision,
    lineas_invalidas: lineasInvalidas,
    origen_pedido_clasificado: origenPedido,
    pendiente_validacion_publica: pendienteValidacionPublica,
    origen_desconocido: origenDesconocido,
    requiere_validacion_origen: requiereValidacionOrigen,
    accion_operativa: accionOperativa,
    estado_operativo_inicial: estadoInicial
  };
};

export const readPedidoOperationalRouting = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  if (!pedidoId || typeof client?.query !== 'function') {
    throw Object.assign(new Error('No se pudo clasificar el ruteo operativo del pedido.'), {
      code: 'VENTAS_PEDIDO_RUTEO_CONTEXTO_INVALIDO'
    });
  }

  const [pedidoResult, detailResult] = await Promise.all([
    client.query(
      `SELECT estado_pago,
              canal,
              tipo_entrega AS modalidad,
              origen_pedido,
              pago_confirmado_at
       FROM public.pedidos
       WHERE id_pedido = $1
       LIMIT 1`,
      [pedidoId]
    ),
    client.query(
      `SELECT
         dp.id_detalle_pedido,
         dp.id_producto,
         dp.id_receta,
         dp.cantidad,
         dp.configuracion_menu,
         CASE
           WHEN dp.configuracion_menu IS NULL THEN 'sql_null'
           ELSE COALESCE(jsonb_typeof(dp.configuracion_menu), 'unknown')
         END AS configuracion_menu_json_type,
         COALESCE(prod.nombre_producto, rec.nombre_receta) AS nombre_item,
         COALESCE(extras_info.extras, '[]'::jsonb) AS extras
       FROM public.detalle_pedido dp
       LEFT JOIN public.productos prod ON prod.id_producto = dp.id_producto
       LEFT JOIN public.recetas rec ON rec.id_receta = dp.id_receta
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'id_extra', dpe.id_extra,
             'nombre', dpe.nombre_extra_snapshot,
             'nombre_extra_snapshot', dpe.nombre_extra_snapshot,
             'codigo', dpe.codigo_extra_snapshot,
             'codigo_extra_snapshot', dpe.codigo_extra_snapshot,
             'cantidad', dpe.cantidad,
             'precio_unitario', dpe.precio_unitario,
             'subtotal', dpe.subtotal
           )
           ORDER BY dpe.id_detalle_pedido_extra
         ) AS extras
         FROM public.detalle_pedido_extras dpe
         WHERE dpe.id_detalle_pedido = dp.id_detalle_pedido
           AND COALESCE(dpe.estado, true) = true
       ) extras_info ON true
       WHERE dp.id_pedido = $1
         AND COALESCE(dp.estado, true) = true
       ORDER BY dp.id_detalle_pedido`,
      [pedidoId]
    )
  ]);

  if (!pedidoResult.rows?.[0]) {
    throw Object.assign(new Error('Pedido no encontrado para clasificar su ruteo operativo.'), {
      status: 404,
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }

  return {
    id_pedido: pedidoId,
    ...classifyPedidoOperationalRouting(detailResult.rows, pedidoResult.rows[0])
  };
};

export const transitionPedidoToKitchenState = async ({
  client,
  idPedido,
  estadoEnCocinaId = null
}) => {
  const pedidoId = toPositiveInteger(idPedido);
  const targetStateId = toPositiveInteger(estadoEnCocinaId)
    || toPositiveInteger(await resolveEstadoPedidoIdByCode(client, 'EN_COCINA'));

  if (!pedidoId || !targetStateId) {
    throw Object.assign(new Error('No existe el estado EN_COCINA para el pedido.'), {
      code: 'VENTAS_PEDIDO_ESTADO_COCINA_NO_ENCONTRADO'
    });
  }

  const result = await client.query(
    `UPDATE public.pedidos
     SET id_estado_pedido = $2,
         visible_en_cocina_at = COALESCE(
           visible_en_cocina_at,
           (NOW() AT TIME ZONE 'America/Tegucigalpa')
         )
     WHERE id_pedido = $1
     RETURNING id_pedido, id_estado_pedido, visible_en_cocina_at`,
    [pedidoId, targetStateId]
  );

  if (result.rowCount !== 1) {
    throw Object.assign(new Error('Pedido no encontrado para enviar a cocina.'), {
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }

  return result.rows[0];
};

const buildInitialRoutingNoopResult = ({ routing, currentState }) => ({
  ...routing,
  id_estado_pedido: Number(currentState.id_estado_pedido),
  estado_pedido: currentState.estado_pedido,
  visible_en_cocina_at: currentState.visible_en_cocina_at ?? null,
  transicion_operativa_aplicada: false,
  ruteo_inicial_noop: true
});

export const applyPedidoInitialOperationalRouting = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  const currentStateResult = await client.query(
    `SELECT
       p.id_estado_pedido,
       ep.descripcion AS estado_pedido,
       p.visible_en_cocina_at
     FROM public.pedidos p
     LEFT JOIN public.estados_pedido ep
       ON ep.id_estado_pedido = p.id_estado_pedido
     WHERE p.id_pedido = $1
     FOR UPDATE OF p`,
    [pedidoId]
  );
  if (currentStateResult.rowCount !== 1) {
    throw Object.assign(new Error('Pedido no encontrado para aplicar su ruteo operativo.'), {
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }

  const currentStateRow = currentStateResult.rows[0];
  const currentStateCode = normalizeCode(currentStateRow.estado_pedido);
  if (
    !toPositiveInteger(currentStateRow.id_estado_pedido)
    || !currentStateCode
    || (
      currentStateCode !== PEDIDO_INITIAL_ROUTING_CURRENT_STATE.PENDING
      && currentStateCode !== PEDIDO_INITIAL_ROUTING_CURRENT_STATE.KITCHEN
      && !PEDIDO_INITIAL_ROUTING_ADVANCED_STATES.has(currentStateCode)
    )
  ) {
    throw Object.assign(new Error('El estado actual del pedido no permite aplicar el ruteo inicial.'), {
      code: 'VENTAS_PEDIDO_ESTADO_OPERATIVO_DESCONOCIDO',
      estado_actual: currentStateCode || null
    });
  }

  const routing = await readPedidoOperationalRouting({ client, idPedido: pedidoId });
  const currentState = {
    id_estado_pedido: Number(currentStateRow.id_estado_pedido),
    estado_pedido: currentStateCode,
    visible_en_cocina_at: currentStateRow.visible_en_cocina_at ?? null
  };

  if (
    currentStateCode === PEDIDO_INITIAL_ROUTING_CURRENT_STATE.KITCHEN
    || PEDIDO_INITIAL_ROUTING_ADVANCED_STATES.has(currentStateCode)
    || routing.requiere_revision
    || routing.estado_operativo_inicial === PEDIDO_INITIAL_ROUTING_CURRENT_STATE.PENDING
  ) {
    return buildInitialRoutingNoopResult({ routing, currentState });
  }

  if (currentStateCode !== PEDIDO_INITIAL_ROUTING_CURRENT_STATE.PENDING) {
    throw Object.assign(new Error('El pedido no esta en estado PENDIENTE para aplicar el ruteo inicial.'), {
      code: 'VENTAS_PEDIDO_RUTEO_TRANSICION_NO_PERMITIDA',
      estado_actual: currentStateCode,
      estado_derivado: routing.estado_operativo_inicial
    });
  }

  if (!PEDIDO_INITIAL_ROUTING_ALLOWED_TARGETS.has(routing.estado_operativo_inicial)) {
    throw Object.assign(new Error('El estado derivado no es valido para el ruteo inicial.'), {
      code: 'VENTAS_PEDIDO_ESTADO_OPERATIVO_NO_PERMITIDO',
      estado_actual: currentStateCode,
      estado_derivado: routing.estado_operativo_inicial
    });
  }

  if (routing.estado_operativo_inicial === 'EN_COCINA') {
    const transitioned = await transitionPedidoToKitchenState({ client, idPedido: pedidoId });
    return {
      ...routing,
      ...transitioned,
      estado_pedido: 'EN_COCINA',
      transicion_operativa_aplicada: true,
      ruteo_inicial_noop: false
    };
  }

  const targetStateId = await resolveEstadoPedidoIdByCode(client, routing.estado_operativo_inicial);

  if (!toPositiveInteger(targetStateId)) {
    throw Object.assign(new Error(`No existe el estado ${routing.estado_operativo_inicial}.`), {
      code: 'VENTAS_PEDIDO_ESTADO_OPERATIVO_NO_ENCONTRADO'
    });
  }

  const updateResult = await client.query(
    `UPDATE public.pedidos
     SET id_estado_pedido = $2,
         visible_en_cocina_at = NULL
     WHERE id_pedido = $1
     RETURNING id_pedido, id_estado_pedido, visible_en_cocina_at`,
    [pedidoId, Number(targetStateId)]
  );
  if (updateResult.rowCount !== 1) {
    throw Object.assign(new Error('Pedido no encontrado para aplicar su ruteo operativo.'), {
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }

  return {
    ...routing,
    id_estado_pedido: Number(targetStateId),
    estado_pedido: routing.estado_operativo_inicial,
    visible_en_cocina_at: null,
    transicion_operativa_aplicada: true,
    ruteo_inicial_noop: false
  };
};

export const applyPedidoReplayOperationalRouting = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  if (!pedidoId || typeof client?.query !== 'function') {
    throw Object.assign(new Error('No se pudo aplicar el ruteo de replay del pedido.'), {
      code: 'VENTAS_PEDIDO_RUTEO_CONTEXTO_INVALIDO'
    });
  }

  await client.query('BEGIN');
  try {
    const routing = await applyPedidoInitialOperationalRouting({ client, idPedido: pedidoId });
    await client.query('COMMIT');
    return routing;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
};
