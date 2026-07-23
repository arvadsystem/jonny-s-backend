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

const normalizeCode = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, '_');

const asObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const readDeliveryPreference = (line) => {
  const value = asObject(line?.configuracion_menu).entregar_con_pedido;
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'si', 'sí'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return null;
};

const buildLineReference = (line, index) => ({
  id_detalle_pedido: toPositiveInteger(line?.id_detalle_pedido ?? line?.id_detalle) || null,
  indice: index,
  id_producto: toPositiveInteger(line?.id_producto),
  id_receta: toPositiveInteger(line?.id_receta),
  nombre_item: String(line?.nombre_item || line?.nombre_producto || '').trim() || null,
  cantidad: Number(line?.cantidad) > 0 ? Number(line.cantidad) : null,
  entregar_con_pedido: readDeliveryPreference(line)
});

export const classifyPedidoOperationalRouting = (lines, context = {}) => {
  const sourceLines = Array.isArray(lines) ? lines : [];
  const productos = [];
  const recetas = [];
  const extrasIndependientes = [];
  const lineasInvalidas = [];

  sourceLines.forEach((line, index) => {
    const reference = buildLineReference(line, index);
    const hasProducto = Boolean(reference.id_producto);
    const hasReceta = Boolean(reference.id_receta);

    if (hasProducto && hasReceta) {
      lineasInvalidas.push({ ...reference, motivo: 'PRODUCTO_Y_RECETA_SIMULTANEOS' });
    } else if (hasProducto) {
      productos.push(reference);
    } else if (hasReceta) {
      recetas.push({ ...reference, tipo_item: 'RECETA' });
    } else {
      const extras = Array.isArray(line?.extras) ? line.extras : [];
      const standaloneExtra = resolveStandaloneExtraLine({
        idProducto: reference.id_producto,
        idReceta: reference.id_receta,
        extras
      });
      if (standaloneExtra) {
        extrasIndependientes.push({
          ...reference,
          tipo_item: 'EXTRA_INDEPENDIENTE',
          id_extra: standaloneExtra.id_extra,
          nombre_item: standaloneExtra.nombre_extra_snapshot,
          nombre_extra_snapshot: standaloneExtra.nombre_extra_snapshot,
          codigo_extra_snapshot: standaloneExtra.codigo_extra_snapshot,
          cantidad: standaloneExtra.cantidad,
          precio_unitario: standaloneExtra.precio_unitario,
          subtotal: standaloneExtra.subtotal,
          entregar_con_pedido: null
        });
      } else {
        lineasInvalidas.push({
          ...reference,
          motivo: extras.length > 1
            ? 'EXTRAS_INDEPENDIENTES_AMBIGUOS'
            : extras.length === 1
              ? 'EXTRA_INDEPENDIENTE_INVALIDO'
              : 'LINEA_SIN_CLASIFICACION'
        });
      }
    }
  });

  if (sourceLines.length === 0) {
    lineasInvalidas.push({
      id_detalle_pedido: null,
      indice: null,
      id_producto: null,
      id_receta: null,
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
         COALESCE(prod.nombre_producto, rec.nombre_receta, 'Item de pedido') AS nombre_item,
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
