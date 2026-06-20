const toPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toPositiveNumberOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const normalizeText = (value) => String(value || '').trim();

export const normalizeAdminStatus = (value) => normalizeText(value).toUpperCase();

export const getUnitDisplay = ({ nombre, simbolo, fallback = 'unidad' } = {}) =>
  normalizeText(simbolo || nombre || fallback);

export const getInventoryStateLabel = (state) => {
  const normalized = normalizeAdminStatus(state);
  if (normalized === 'LISTA') return 'Lista';
  if (normalized === 'PENDIENTE') return 'Sin configurar';
  if (normalized === 'INSUMO_INVALIDO') return 'Revisar insumo';
  if (normalized === 'SIN_UNIDAD_BASE') return 'Insumo sin unidad base';
  if (normalized === 'CONVERSION_FALTANTE') return 'Revisar conversion';
  if (normalized === 'CONVERSION_AMBIGUA') return 'Conversion ambigua';
  return 'Sin configurar';
};

const getMappingBlockReason = (row = {}) => {
  const mappingCount = Number(row.mapping_count || 0);
  const mappingStatus = normalizeAdminStatus(row.estado_mapeo_maestro);
  if (mappingCount > 1) {
    return 'El insumo tiene mas de una relacion de catalogo y requiere revision.';
  }
  if (mappingCount === 1 && mappingStatus !== 'VALIDADO') {
    return 'El insumo requiere revision antes de usarse en salsas.';
  }
  return '';
};

export const buildInventoryState = (row = {}) => {
  const active = row.estado === undefined ? true : row.estado === true;
  const idInsumo = toPositiveInt(row.id_insumo);
  const idUnidadConsumo = toPositiveInt(row.id_unidad_consumo);
  const cantidadPorcion = toPositiveNumberOrNull(row.cantidad_porcion);
  const idUnidadBase = toPositiveInt(row.id_unidad_base);
  const insumoActivo = row.insumo_estado === undefined ? true : row.insumo_estado === true;
  const conversiones = Number(row.conversiones_aplicables || 0);
  const mappingBlockReason = getMappingBlockReason(row);
  const unidadConsumo = getUnitDisplay({
    nombre: row.unidad_consumo_nombre,
    simbolo: row.unidad_consumo_simbolo
  });
  const insumoNombre = normalizeText(row.insumo_nombre || (idInsumo ? `Insumo #${idInsumo}` : 'insumo'));

  if (!active) {
    return {
      inventario_estado: 'PENDIENTE',
      inventario_configurado: false,
      inventario_mensaje: 'No aplica mientras la salsa este inactiva.',
      resumen_consumo: 'No aplica',
      puede_asignarse_receta: false
    };
  }
  if (!idInsumo && !idUnidadConsumo) {
    return {
      inventario_estado: 'PENDIENTE',
      inventario_configurado: false,
      inventario_mensaje: 'Sin configurar',
      resumen_consumo: 'Sin configurar',
      puede_asignarse_receta: false
    };
  }
  if (!idInsumo || !idUnidadConsumo || !cantidadPorcion) {
    return {
      inventario_estado: 'PENDIENTE',
      inventario_configurado: false,
      inventario_mensaje: 'Completa insumo, cantidad y unidad de consumo.',
      resumen_consumo: 'Sin configurar',
      puede_asignarse_receta: false
    };
  }
  if (!row.insumo_nombre || insumoActivo !== true) {
    return {
      inventario_estado: 'INSUMO_INVALIDO',
      inventario_configurado: false,
      inventario_mensaje: 'El insumo configurado no existe o esta inactivo.',
      resumen_consumo: 'Revisar insumo',
      puede_asignarse_receta: false
    };
  }
  if (mappingBlockReason) {
    return {
      inventario_estado: 'INSUMO_INVALIDO',
      inventario_configurado: false,
      inventario_mensaje: mappingBlockReason,
      resumen_consumo: 'Revisar insumo',
      puede_asignarse_receta: false
    };
  }
  if (!idUnidadBase) {
    return {
      inventario_estado: 'SIN_UNIDAD_BASE',
      inventario_configurado: false,
      inventario_mensaje: 'El insumo no tiene unidad base configurada.',
      resumen_consumo: 'Revisar insumo',
      puede_asignarse_receta: false
    };
  }
  if (idUnidadBase !== idUnidadConsumo && conversiones === 0) {
    return {
      inventario_estado: 'CONVERSION_FALTANTE',
      inventario_configurado: false,
      inventario_mensaje: 'Falta una conversion activa para usar esa unidad.',
      resumen_consumo: 'Revisar conversion',
      puede_asignarse_receta: false
    };
  }
  if (idUnidadBase !== idUnidadConsumo && conversiones > 1) {
    return {
      inventario_estado: 'CONVERSION_AMBIGUA',
      inventario_configurado: false,
      inventario_mensaje: 'Hay mas de una conversion activa para esa unidad.',
      resumen_consumo: 'Revisar conversion',
      puede_asignarse_receta: false
    };
  }

  return {
    inventario_estado: 'LISTA',
    inventario_configurado: true,
    inventario_mensaje: 'Lista para descontar inventario.',
    resumen_consumo: `${Number(cantidadPorcion)} ${unidadConsumo} por seleccion`,
    puede_asignarse_receta: true,
    insumo_consumo_nombre: insumoNombre
  };
};

export const attachSalsaInventoryState = (row = {}) => ({
  ...row,
  ...buildInventoryState(row)
});

export const isSelectableInsumoRow = (row = {}) => {
  if (row.estado !== true) return { selectable: false, reason: 'El insumo esta inactivo.' };
  if (!toPositiveInt(row.id_unidad_medida)) return { selectable: false, reason: 'El insumo no tiene unidad base configurada.' };
  const mappingBlockReason = getMappingBlockReason(row);
  if (mappingBlockReason) return { selectable: false, reason: mappingBlockReason };
  return { selectable: true, reason: '' };
};
