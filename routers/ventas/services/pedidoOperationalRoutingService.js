import { resolveEstadoPedidoIdByCode } from './catalogLookupService.js';
import { resolveStandaloneExtraLine } from '../utils/parseUtils.js';

export const PEDIDO_OPERATIONAL_ACTION = Object.freeze({
  SEND_TO_KITCHEN: 'ENVIAR_COCINA',
  READY_FOR_DELIVERY: 'LISTO_PARA_ENTREGA',
  COMPLETE: 'COMPLETAR',
  REVIEW: 'REQUIERE_REVISION'
});

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
  const isPaidLocalConsumption = estadoPago === 'PAGADO_CONFIRMADO'
    && ['LOCAL', 'POS', 'CAJA'].includes(canal)
    && ['CONSUMO_LOCAL', 'LOCAL', 'EN_LOCAL'].includes(modalidad);

  let accionOperativa;
  let estadoInicial;
  if (requiereRevision) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.REVIEW;
    estadoInicial = 'PENDIENTE';
  } else if (requiereCocina) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.SEND_TO_KITCHEN;
    estadoInicial = 'PENDIENTE';
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
      `SELECT estado_pago, canal, tipo_entrega AS modalidad
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

export const applyPedidoInitialOperationalRouting = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  const routing = await readPedidoOperationalRouting({ client, idPedido: pedidoId });
  if (routing.requiere_revision) {
    throw Object.assign(
      new Error('El pedido contiene lineas invalidas y no puede cambiar de estado operativo.'),
      {
        status: 409,
        httpStatus: 409,
        code: 'VENTAS_PEDIDO_REQUIERE_REVISION',
        publicMessage: 'El pedido contiene lineas invalidas y requiere revision.',
        requiere_revision: true,
        lineas_invalidas: routing.lineas_invalidas
      }
    );
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
    visible_en_cocina_at: null
  };
};
