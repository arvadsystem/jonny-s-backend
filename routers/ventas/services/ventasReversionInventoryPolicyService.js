import { parsePositiveInt } from '../utils/parseUtils.js';
import { hasSalsaInventoryConsumptionEvidence } from './ventasReversionCalculationService.js';

const PREPARATION_STARTED_STATES = new Set([
  'EN_PREPARACION',
  'LISTO_PARA_ENTREGA',
  'COMPLETADO',
  'NO_ENTREGADO'
]);

const ALLOWED_ORIGINAL_REFS = new Set(['PEDIDO', 'FALTANTE_COCINA']);

const createPolicyError = (code, message) => {
  const error = new Error(message);
  error.httpStatus = 409;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const normalizeType = (value) => String(value || '').trim().toUpperCase();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasConfiguredProduct = (value) => Boolean(
  parsePositiveInt(value?.id_producto)
  || parsePositiveInt(value?.inventario?.id_producto)
);

const hasConfiguredConsumable = (value) => Boolean(
  parsePositiveInt(value?.id_insumo)
  || parsePositiveInt(value?.id_insumo_configurado)
  || parsePositiveInt(value?.id_insumo_maestro)
  || parsePositiveInt(value?.id_insumo_legacy)
  || parsePositiveInt(value?.inventario?.id_insumo)
  || parsePositiveInt(value?.inventario?.id_insumo_configurado)
  || parsePositiveInt(value?.inventario?.id_insumo_maestro)
  || parsePositiveInt(value?.inventario?.id_insumo_legacy)
  || value?.inventario_configurado === true
  || value?.inventario?.inventario_configurado === true
  || Number(value?.cantidad_insumo || value?.cant || value?.cantidad_base_total || 0) > 0
  || Number(value?.inventario?.cantidad_insumo
    || value?.inventario?.cant
    || value?.inventario?.cantidad_base_total
    || 0) > 0
);

const resolveSnapshotInventoryEvidence = (line) => {
  const snapshot = isObject(line?.origen_snapshot) ? line.origen_snapshot : {};
  const extras = [
    ...(Array.isArray(snapshot.extras) ? snapshot.extras : []),
    ...(Array.isArray(snapshot.extras_snapshot) ? snapshot.extras_snapshot : [])
  ];
  const standaloneExtra = Boolean(
    line?.es_linea_extra_independiente
    || snapshot.es_linea_extra_independiente
    || parsePositiveInt(snapshot.id_extra)
  );
  const product = hasConfiguredProduct(snapshot)
    || extras.some((extra) => hasConfiguredProduct(extra));
  const consumable = Boolean(
    parsePositiveInt(snapshot.id_receta)
    || hasSalsaInventoryConsumptionEvidence(snapshot)
    || extras.some((extra) => hasConfiguredConsumable(extra))
    || (standaloneExtra && hasConfiguredConsumable(snapshot))
  );

  return {
    product,
    consumable,
    configured: product || consumable
  };
};

export const hasPedidoPreparationStarted = (pedidoContext) => Boolean(
  pedidoContext?.preparacion_iniciada
  || pedidoContext?.en_preparacion_at
  || PREPARATION_STARTED_STATES.has(normalizeType(pedidoContext?.estado))
);

const loadExactOriginalMovements = async ({ client, line, forUpdate }) => {
  const idDetallePedido = parsePositiveInt(line?.id_detalle_pedido);
  if (!idDetallePedido) return [];

  const result = await client.query(
    `
      SELECT
        id_movimiento,
        cantidad,
        id_almacen,
        id_producto,
        id_insumo,
        origen_consumo,
        ref_origen,
        id_pedido_trazabilidad
      FROM public.movimientos_inventario
      WHERE tipo = 'SALIDA'
        AND id_detalle_pedido = $1
      ORDER BY id_movimiento
      ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [idDetallePedido]
  );

  const incompatible = result.rows.find(
    (movement) => !ALLOWED_ORIGINAL_REFS.has(normalizeType(movement.ref_origen))
  );
  if (incompatible) {
    throw createPolicyError(
      'VENTAS_REVERSION_INVENTARIO_REFERENCIA_INCOMPATIBLE',
      'La trazabilidad de inventario contiene una referencia de movimiento incompatible.'
    );
  }
  return result.rows;
};

const classifyLinePolicy = ({ line, movements, pedidoContext }) => {
  const originalType = normalizeType(line?.tipo_item) || 'ITEM';
  const preparacionIniciada = hasPedidoPreparationStarted(pedidoContext);
  const snapshotEvidence = resolveSnapshotInventoryEvidence(line);
  const declaresProduct = Boolean(parsePositiveInt(line?.id_producto))
    || originalType === 'PRODUCTO'
    || snapshotEvidence.product;
  const declaresRecipe = Boolean(parsePositiveInt(line?.id_receta)) || originalType === 'RECETA';
  const consumableEvidence = declaresRecipe || snapshotEvidence.consumable;
  const requiresTraceEvidence = Boolean(line?.requiereTrazabilidad)
    || declaresProduct
    || consumableEvidence
    || snapshotEvidence.configured;
  const hasProductMovement = movements.some((movement) => parsePositiveInt(movement.id_producto));
  const hasConsumableMovement = movements.some((movement) => parsePositiveInt(movement.id_insumo));
  const hasUnknownMovement = movements.some(
    (movement) => !parsePositiveInt(movement.id_producto) && !parsePositiveInt(movement.id_insumo)
  );

  if (!movements.length) {
    if (preparacionIniciada && !declaresProduct && consumableEvidence) {
      return {
        tipo_politica_inventario: 'CONSUMIBLE_PREPARABLE',
        preparacion_iniciada: true,
        devuelve_inventario: false,
        motivo_no_devolucion: 'PREPARACION_INICIADA',
        exige_trazabilidad: false,
        movimientos_a_restituir: []
      };
    }
    if (requiresTraceEvidence) {
      throw createPolicyError(
        'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED',
        'No existe trazabilidad suficiente para devolver el inventario de esta venta.'
      );
    }
    return {
      tipo_politica_inventario: 'SIN_INVENTARIO',
      preparacion_iniciada: preparacionIniciada,
      devuelve_inventario: false,
      motivo_no_devolucion: null,
      exige_trazabilidad: false,
      movimientos_a_restituir: []
    };
  }

  const conflictsWithDeclaredIdentity = (declaresProduct && !hasProductMovement)
    || (declaresRecipe && hasProductMovement);
  if (
    hasUnknownMovement
    || (hasProductMovement && hasConsumableMovement)
    || conflictsWithDeclaredIdentity
  ) {
    throw createPolicyError(
      'VENTAS_REVERSION_INVENTARIO_POLICY_UNRESOLVED',
      'No se pudo resolver de forma segura la política de inventario de una línea.'
    );
  }

  const isProductPolicy = hasProductMovement;
  const devuelveInventario = isProductPolicy || !preparacionIniciada;
  return {
    tipo_politica_inventario: isProductPolicy
      ? 'PRODUCTO_RETORNABLE'
      : 'CONSUMIBLE_PREPARABLE',
    preparacion_iniciada: preparacionIniciada,
    devuelve_inventario: devuelveInventario,
    motivo_no_devolucion: !isProductPolicy && preparacionIniciada
      ? 'PREPARACION_INICIADA'
      : null,
    exige_trazabilidad: true,
    movimientos_a_restituir: devuelveInventario ? movements : []
  };
};

export const resolveReversionInventoryPolicies = async ({
  client,
  lines,
  pedidoContext,
  forUpdate = false
}) => {
  const resolved = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const movements = await loadExactOriginalMovements({ client, line, forUpdate });
    const policy = classifyLinePolicy({ line, movements, pedidoContext });
    const requiereTrazabilidadFinal = Boolean(line.requiereTrazabilidad)
      || policy.exige_trazabilidad;
    const enrichedLine = {
      ...line,
      tipo_politica_inventario: policy.tipo_politica_inventario,
      preparacion_iniciada: policy.preparacion_iniciada,
      devuelve_inventario: policy.devuelve_inventario,
      motivo_no_devolucion: policy.motivo_no_devolucion,
      requiereTrazabilidad: requiereTrazabilidadFinal,
      politica_inventario: {
        ...policy,
        exige_trazabilidad: requiereTrazabilidadFinal,
        movimientos_a_restituir: policy.movimientos_a_restituir.map(
          (movement) => Number(movement.id_movimiento)
        )
      }
    };
    Object.defineProperty(enrichedLine, 'movimientosOriginales', {
      value: movements,
      enumerable: false
    });
    resolved.push(enrichedLine);
  }
  return resolved;
};

export { ALLOWED_ORIGINAL_REFS, PREPARATION_STARTED_STATES };
