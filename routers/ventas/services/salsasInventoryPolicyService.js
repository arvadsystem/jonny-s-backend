const toPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const normalizeSalsaMappingStatus = (value) => String(value || '').trim().toUpperCase();

export const salsaMappingFailureCode = (status) => {
  const normalized = normalizeSalsaMappingStatus(status);
  if (normalized === 'REQUIERE_REVISION') return 'SALSA_INSUMO_MAPEO_REQUIERE_REVISION';
  if (normalized === 'AMBIGUO') return 'SALSA_INSUMO_MAPEO_AMBIGUO';
  if (normalized === 'PENDIENTE') return 'SALSA_INSUMO_MAPEO_PENDIENTE';
  return 'SALSA_INSUMO_MAPEO_REQUIERE_REVISION';
};

export const classifySalsaMapping = ({
  configuredId = null,
  mappingCount = 0,
  mappingStatus = null,
  masterId = null,
  masterCatalogEnabled = true
} = {}) => {
  const idInsumoConfigurado = toPositiveInt(configuredId);
  if (!idInsumoConfigurado) {
    return {
      ok: false,
      code: 'SALSA_INSUMO_NO_CONFIGURADO',
      effectiveInsumoId: null,
      legacyInsumoId: null,
      usesMaster: false
    };
  }

  if (masterCatalogEnabled !== true) {
    return {
      ok: true,
      code: null,
      effectiveInsumoId: idInsumoConfigurado,
      legacyInsumoId: null,
      usesMaster: false
    };
  }

  const count = Number(mappingCount || 0);
  if (count > 1) {
    return {
      ok: false,
      code: 'SALSA_INSUMO_MAPEO_AMBIGUO',
      effectiveInsumoId: null,
      legacyInsumoId: idInsumoConfigurado,
      usesMaster: true
    };
  }

  if (count === 1) {
    const status = normalizeSalsaMappingStatus(mappingStatus);
    if (status !== 'VALIDADO') {
      return {
        ok: false,
        code: salsaMappingFailureCode(status),
        effectiveInsumoId: null,
        legacyInsumoId: idInsumoConfigurado,
        usesMaster: true
      };
    }

    const idInsumoMaestro = toPositiveInt(masterId);
    if (!idInsumoMaestro) {
      return {
        ok: false,
        code: 'SALSA_INSUMO_NO_ENCONTRADO',
        effectiveInsumoId: null,
        legacyInsumoId: idInsumoConfigurado,
        usesMaster: true
      };
    }

    return {
      ok: true,
      code: null,
      effectiveInsumoId: idInsumoMaestro,
      legacyInsumoId: idInsumoConfigurado,
      usesMaster: true
    };
  }

  return {
    ok: true,
    code: null,
    effectiveInsumoId: idInsumoConfigurado,
    legacyInsumoId: null,
    usesMaster: false
  };
};

export const resolveSalsaStructuralInventory = (row = {}, { masterCatalogEnabled = true } = {}) => {
  const mapping = classifySalsaMapping({
    configuredId: row.id_insumo,
    mappingCount: row.mapping_count,
    mappingStatus: row.estado_mapeo_maestro,
    masterId: row.id_insumo_maestro,
    masterCatalogEnabled
  });

  if (!mapping.ok) {
    return {
      ...mapping,
      effectiveInsumo: null,
      effectiveUnitId: null
    };
  }

  const usesMaster = mapping.usesMaster === true;
  const effectiveInsumo = usesMaster
    ? {
        id_insumo: mapping.effectiveInsumoId,
        nombre_insumo: row.insumo_maestro_nombre,
        estado: row.insumo_maestro_estado,
        id_unidad_medida: row.id_unidad_base_maestro
      }
    : {
        id_insumo: mapping.effectiveInsumoId,
        nombre_insumo: row.insumo_nombre,
        estado: row.insumo_estado,
        id_unidad_medida: row.id_unidad_base
      };

  return {
    ...mapping,
    effectiveInsumo,
    effectiveUnitId: toPositiveInt(effectiveInsumo.id_unidad_medida)
  };
};
