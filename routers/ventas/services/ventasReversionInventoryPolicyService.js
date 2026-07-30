import { parsePositiveInt } from '../utils/parseUtils.js';

const PREPARATION_STARTED_STATES = new Set([
  'EN_PREPARACION',
  'LISTO_PARA_ENTREGA',
  'COMPLETADO'
]);

const normalizeType = (value) => String(value || '').trim().toUpperCase();

const resolveStandaloneExtra = (line) => Boolean(
  line?.es_linea_extra_independiente
  || line?.origen_snapshot?.es_linea_extra_independiente
);

const resolveLineType = (line) => {
  const declaredType = normalizeType(line?.tipo_item);
  const idProducto = parsePositiveInt(line?.id_producto);
  const idReceta = parsePositiveInt(line?.id_receta);
  const standaloneExtra = resolveStandaloneExtra(line);

  if (idProducto && (declaredType === 'PRODUCTO' || standaloneExtra)) return 'PRODUCTO';
  if (idReceta || declaredType === 'RECETA') return 'RECETA';
  return declaredType || 'ITEM';
};

export const hasPedidoPreparationStarted = (pedidoContext) => Boolean(
  pedidoContext?.preparacion_iniciada
  || pedidoContext?.en_preparacion_at
  || PREPARATION_STARTED_STATES.has(normalizeType(pedidoContext?.estado))
);

export const resolveReversionInventoryLinePolicy = ({ line, pedidoContext }) => {
  const tipoLinea = resolveLineType(line);
  const preparacionIniciada = hasPedidoPreparationStarted(pedidoContext);
  const isProduct = tipoLinea === 'PRODUCTO';
  const isRecipe = tipoLinea === 'RECETA';
  const devuelveInventario = isProduct || (isRecipe && !preparacionIniciada);

  return {
    tipo_linea: tipoLinea,
    preparacion_iniciada: preparacionIniciada,
    devuelve_inventario: devuelveInventario,
    motivo_no_devolucion: isRecipe && preparacionIniciada ? 'PREPARACION_INICIADA' : null,
    exige_trazabilidad: devuelveInventario && (isProduct || isRecipe),
    movimientos_a_restituir: devuelveInventario ? 'SALIDAS_ORIGINALES_EXACTAS' : 'NINGUNO'
  };
};

export const applyReversionInventoryPolicy = ({ lines, pedidoContext }) => (
  (Array.isArray(lines) ? lines : []).map((line) => {
    const policy = resolveReversionInventoryLinePolicy({ line, pedidoContext });
    return {
      ...line,
      tipo_item: policy.tipo_linea,
      preparacion_iniciada: policy.preparacion_iniciada,
      devuelve_inventario: policy.devuelve_inventario,
      motivo_no_devolucion: policy.motivo_no_devolucion,
      requiereTrazabilidad: policy.exige_trazabilidad,
      politica_inventario: policy
    };
  })
);

export const filterMovementsForReversionPolicy = ({ policy, movements }) => {
  if (!policy?.devuelve_inventario) return [];
  const rows = Array.isArray(movements) ? movements : [];

  if (policy.tipo_linea === 'PRODUCTO') {
    return rows.filter((movement) => parsePositiveInt(movement?.id_producto));
  }
  if (policy.tipo_linea === 'RECETA') {
    return rows.filter((movement) => parsePositiveInt(movement?.id_insumo));
  }
  return [];
};
