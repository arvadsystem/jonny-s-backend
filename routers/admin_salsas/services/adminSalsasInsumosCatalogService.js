import { collapseCatalogoMaestroRows } from '../../../services/catalogoMaestroReadService.js';
import {
  isSelectableInsumoRow,
  normalizeAdminStatus,
  normalizeText
} from './salsaInventoryAdminStateService.js';

const toPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toUniquePositiveInts = (values) => (
  [...new Set((Array.isArray(values) ? values : [])
    .map(toPositiveInt)
    .filter(Boolean))]
    .sort((left, right) => left - right)
);

const normalizeMappingStatuses = (values) => (
  [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeAdminStatus)
    .filter(Boolean))]
);

const getBlockingMappingStatus = (statuses) => {
  if (statuses.includes('AMBIGUO')) return 'AMBIGUO';
  if (statuses.includes('REQUIERE_REVISION')) return 'REQUIERE_REVISION';
  if (statuses.includes('PENDIENTE')) return 'PENDIENTE';
  if (statuses.some((status) => status !== 'VALIDADO')) return 'REQUIERE_REVISION';
  return statuses.includes('VALIDADO') ? null : 'PENDIENTE';
};

const buildDuplicateNameReason = (row, conflictIds) => {
  const name = normalizeText(row.nombre);
  const ids = conflictIds.map((id) => `#${id}`).join(', ');
  return `Conflicto de datos: existen maestros VALIDADO con el mismo nombre "${name}" (${ids}).`;
};

const buildMappingBlockReason = ({ masterId, legacyIds, status }) => {
  const legacyLabel = legacyIds.length > 0
    ? `los mapeos legacy ${legacyIds.map((id) => `#${id}`).join(', ')}`
    : 'su mapeo maestro';
  return `El maestro #${masterId} esta bloqueado porque ${legacyLabel} mantiene estado ${status}.`;
};

export const buildAdminSalsasInsumosCatalog = (rows) => {
  const canonicalRows = collapseCatalogoMaestroRows(rows, {
    masterIdField: 'id_insumo_maestro',
    publicIdField: 'id_insumo'
  });

  const items = canonicalRows.map((row) => {
    const idInsumoMaestro = toPositiveInt(row.id_insumo_maestro);
    const mappingStatuses = normalizeMappingStatuses(row.estados_mapeo_maestro);
    const blockingStatus = getBlockingMappingStatus(mappingStatuses);
    const legacyIds = toUniquePositiveInts(row.ids_insumo_legacy)
      .filter((id) => id !== idInsumoMaestro);
    const selectable = isSelectableInsumoRow({
      ...row,
      mapping_count: blockingStatus ? 1 : 0,
      estado_mapeo_maestro: blockingStatus
    });
    const estadoMapeo = blockingStatus || 'VALIDADO';
    const motivoBloqueo = blockingStatus
      ? buildMappingBlockReason({
          masterId: idInsumoMaestro,
          legacyIds,
          status: blockingStatus
        })
      : selectable.reason;

    return {
      id_insumo: idInsumoMaestro,
      nombre: normalizeText(row.nombre),
      categoria: normalizeText(row.categoria_nombre),
      id_categoria_insumo: toPositiveInt(row.id_categoria_insumo),
      id_unidad_medida: toPositiveInt(row.id_unidad_medida),
      unidad_base: {
        id_unidad_medida: toPositiveInt(row.id_unidad_medida),
        nombre: row.unidad_nombre || null,
        simbolo: row.unidad_simbolo || null,
        etiqueta: row.unidad_etiqueta || null
      },
      seleccionable: selectable.selectable,
      motivo_bloqueo: selectable.selectable ? null : motivoBloqueo,
      mapping_count: Number(row.mapping_count || 0),
      id_insumo_maestro: idInsumoMaestro,
      estado_mapeo_maestro: estadoMapeo,
      indicador_maestro_legacy: 'MAESTRO',
      estado_configuracion: selectable.selectable ? 'OK' : 'BLOQUEADO',
      conversiones_disponibles: Array.isArray(row.conversiones_disponibles)
        ? row.conversiones_disponibles
        : [],
      metadata: {
        mapping_count: Number(row.mapping_count || 0),
        id_insumo_maestro: idInsumoMaestro,
        ids_insumo_legacy: legacyIds,
        estados_mapeo_maestro: mappingStatuses,
        estado_mapeo_maestro: estadoMapeo,
        indicador_maestro_legacy: 'MAESTRO',
        estado_configuracion: selectable.selectable ? 'OK' : 'BLOQUEADO',
        id_almacenes: Array.isArray(row.id_almacenes) ? row.id_almacenes : []
      }
    };
  });

  const validatedByName = new Map();
  for (const item of items) {
    if (item.estado_mapeo_maestro !== 'VALIDADO') continue;
    const normalizedName = normalizeAdminStatus(item.nombre);
    if (!normalizedName) continue;
    if (!validatedByName.has(normalizedName)) validatedByName.set(normalizedName, []);
    validatedByName.get(normalizedName).push(item);
  }

  for (const sameNameItems of validatedByName.values()) {
    const conflictIds = [...new Set(sameNameItems.map((item) => item.id_insumo))].sort((a, b) => a - b);
    if (conflictIds.length < 2) continue;
    for (const item of sameNameItems) {
      item.seleccionable = false;
      item.motivo_bloqueo = buildDuplicateNameReason(item, conflictIds);
      item.estado_configuracion = 'CONFLICTO_DATOS';
      item.metadata.estado_configuracion = 'CONFLICTO_DATOS';
      item.metadata.ids_maestros_conflicto = conflictIds;
    }
  }

  return items.sort((left, right) => (
    normalizeAdminStatus(left.categoria) === 'SALSAS Y ADEREZOS'
      && normalizeAdminStatus(right.categoria) !== 'SALSAS Y ADEREZOS'
      ? -1
      : normalizeAdminStatus(left.categoria) !== 'SALSAS Y ADEREZOS'
        && normalizeAdminStatus(right.categoria) === 'SALSAS Y ADEREZOS'
        ? 1
        : left.nombre.localeCompare(right.nombre, 'es', { sensitivity: 'base' })
          || left.id_insumo - right.id_insumo
  ));
};
