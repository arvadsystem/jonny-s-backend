import { isCatalogoMaestroReadsEnabled } from '../../../services/catalogoMaestroReadService.js';

export const toPositiveInventoryInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const toPositiveInventoryNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeMappingStatus = (value) => String(value || '').trim().toUpperCase();

export const fetchVentaGlobalExtrasCatalog = async ({ queryRunner, idSucursal, extraIds = null } = {}) => {
  if (!queryRunner?.query) throw new TypeError('queryRunner es requerido para cargar extras globales.');

  const branchId = toPositiveInventoryInt(idSucursal);
  if (!branchId) return [];

  const normalizedExtraIds = Array.isArray(extraIds)
    ? [...new Set(extraIds.map((id) => toPositiveInventoryInt(id)).filter(Boolean))]
    : [];

  const result = await queryRunner.query(
    `
      SELECT DISTINCT ON (me.id_extra)
        me.id_extra,
        me.codigo,
        me.nombre,
        me.precio_adicional AS precio,
        COALESCE(me.estado, true) AS estado,
        me.id_insumo,
        i.nombre_insumo,
        me.cant,
        me.id_unidad_medida,
        COALESCE(NULLIF(TRIM(um.simbolo), ''), NULLIF(TRIM(um.nombre), ''), 'unidad') AS unidad_medida,
        mea.id_almacen,
        a.id_sucursal
      FROM public.menu_extras me
      INNER JOIN public.menu_extra_almacenes mea
        ON mea.id_extra = me.id_extra
       AND COALESCE(mea.estado, true) = true
      INNER JOIN public.almacenes a
        ON a.id_almacen = mea.id_almacen
       AND COALESCE(a.estado, true) = true
       AND a.id_sucursal = $1
      INNER JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
       AND COALESCE(s.estado, true) = true
      LEFT JOIN public.insumos i
        ON i.id_insumo = me.id_insumo
      LEFT JOIN public.unidades_medida um
        ON um.id_unidad_medida = me.id_unidad_medida
      WHERE COALESCE(me.estado, true) = true
        AND (
          cardinality($2::int[]) = 0
          OR me.id_extra = ANY($2::int[])
        )
      ORDER BY me.id_extra, mea.id_almacen
    `,
    [branchId, normalizedExtraIds]
  );

  return Array.isArray(result.rows) ? result.rows : [];
};

export const EXTRA_INVENTORY_UNAVAILABLE_MESSAGES = Object.freeze({
  EXTRA_INSUMO_NO_CONFIGURADO: 'Este extra requiere configurar su inventario.',
  EXTRA_INSUMO_NO_ENCONTRADO: 'Este extra no tiene un insumo de inventario valido.',
  EXTRA_INSUMO_INACTIVO: 'El insumo de este extra esta inactivo.',
  EXTRA_INSUMO_MAPEO_REQUIERE_REVISION: 'Este extra requiere revision de inventario.',
  EXTRA_INSUMO_MAPEO_AMBIGUO: 'Este extra requiere revisar su vinculo con inventario.',
  EXTRA_INSUMO_MAPEO_PENDIENTE: 'Este extra requiere revision de inventario.',
  EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL: 'Este extra no esta disponible en la sucursal seleccionada.',
  EXTRA_INSUMO_ASIGNACION_AMBIGUA: 'Este extra tiene una configuracion de inventario ambigua.',
  EXTRA_CANTIDAD_CONSUMO_INVALIDA: 'Este extra no tiene una cantidad de consumo valida.',
  EXTRA_UNIDAD_NO_CONFIGURADA: 'Este extra no tiene una unidad de consumo valida.',
  EXTRA_UNIDAD_SIN_CONVERSION: 'Este extra no tiene una conversion de unidad configurada.',
  EXTRA_UNIDAD_CONVERSION_AMBIGUA: 'Este extra tiene mas de una conversion de unidad aplicable.',
  EXTRA_STOCK_INSUFICIENTE: 'No hay existencias suficientes para este extra.'
});

const buildBaseResult = (extra, { useMasterCatalog, idSucursal }) => ({
  ...extra,
  id_extra: toPositiveInventoryInt(extra?.id_extra),
  id_insumo_configurado: toPositiveInventoryInt(extra?.id_insumo),
  id_insumo_maestro: null,
  id_insumo_legacy: null,
  id_almacen: null,
  id_sucursal: toPositiveInventoryInt(idSucursal),
  stock_disponible: null,
  stock_minimo: null,
  cantidad_consumo_configurada: toPositiveInventoryNumber(extra?.cant),
  id_unidad_consumo: toPositiveInventoryInt(extra?.id_unidad_medida),
  cantidad_consumo_base: null,
  id_unidad_base: null,
  inventario_configurado: false,
  disponible: false,
  motivo_no_disponible: null,
  codigo_no_disponible: null,
  usa_catalogo_maestro: useMasterCatalog
});

const markUnavailable = (result, code, { preserveInventoryConfiguration = false } = {}) => ({
  ...result,
  inventario_configurado: preserveInventoryConfiguration ? Boolean(result.inventario_configurado) : false,
  disponible: false,
  codigo_no_disponible: code,
  motivo_no_disponible: EXTRA_INVENTORY_UNAVAILABLE_MESSAGES[code] || 'Este extra no esta disponible.'
});

export const groupInventoryRowsBy = (rows, field) => {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = toPositiveInventoryInt(row?.[field]);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
};

const loadExtraAssignmentsByBranch = async ({ queryRunner, extraIds = [], idSucursal, mode }) => {
  const branchId = toPositiveInventoryInt(idSucursal);
  const ids = [...new Set((Array.isArray(extraIds) ? extraIds : []).map((id) => toPositiveInventoryInt(id)).filter(Boolean))];
  if (!branchId || ids.length === 0) return null;

  try {
    const result = await queryRunner.query(
      `
        SELECT mea.id_extra
        FROM public.menu_extra_almacenes mea
        INNER JOIN public.almacenes a
          ON a.id_almacen = mea.id_almacen
         AND a.id_sucursal = $2
         AND COALESCE(a.estado, true) = true
        WHERE mea.id_extra = ANY($1::int[])
          AND COALESCE(mea.estado, true) = true
        ${mode === 'transactional' ? 'FOR UPDATE OF mea' : ''}
      `,
      [ids, branchId]
    );
    return new Set((result.rows || []).map((row) => Number(row.id_extra)).filter(Boolean));
  } catch (error) {
    if (error?.code === '42P01') return null;
    throw error;
  }
};

const resolveLegacyExtrasInventory = async ({ queryRunner, extras, idSucursal }) => {
  const configuredIds = [...new Set(extras.map((extra) => toPositiveInventoryInt(extra?.id_insumo)).filter(Boolean))];
  const inventoryById = new Map();
  const assignmentsByBranch = await loadExtraAssignmentsByBranch({
    queryRunner,
    extraIds: extras.map((extra) => extra?.id_extra),
    idSucursal,
    mode: 'catalog'
  });

  if (configuredIds.length > 0) {
    const result = await queryRunner.query(
      `
        SELECT
          i.id_insumo,
          i.id_unidad_medida,
          COALESCE(i.estado, true) AS estado,
          COALESCE(i.cantidad, 0)::numeric AS cantidad,
          COALESCE(i.stock_minimo, 0)::numeric AS stock_minimo,
          i.id_almacen,
          a.id_sucursal,
          COALESCE(a.estado, true) AS almacen_estado
        FROM public.insumos i
        LEFT JOIN public.almacenes a
          ON a.id_almacen = i.id_almacen
        WHERE i.id_insumo = ANY($1::int[])
      `,
      [configuredIds]
    );
    for (const row of result.rows || []) inventoryById.set(Number(row.id_insumo), row);
  }

  return extras.map((extra) => {
    let resolved = buildBaseResult(extra, { useMasterCatalog: false, idSucursal });
    if (assignmentsByBranch && !assignmentsByBranch.has(resolved.id_extra)) {
      return markUnavailable(resolved, 'EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL');
    }
    const configuredId = resolved.id_insumo_configurado;
    if (!configuredId) {
      return {
        ...resolved,
        disponible: extra?.estado !== false
      };
    }

    const row = inventoryById.get(configuredId);
    if (!row) return markUnavailable(resolved, 'EXTRA_INSUMO_NO_ENCONTRADO');
    if (row.estado !== true) return markUnavailable(resolved, 'EXTRA_INSUMO_INACTIVO');
    const branchId = toPositiveInventoryInt(row.id_sucursal);
    if (!toPositiveInventoryInt(row.id_almacen) || row.almacen_estado !== true || (toPositiveInventoryInt(idSucursal) && branchId !== toPositiveInventoryInt(idSucursal))) {
      return markUnavailable(resolved, 'EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL');
    }
    if (!resolved.cantidad_consumo_configurada) return markUnavailable(resolved, 'EXTRA_CANTIDAD_CONSUMO_INVALIDA');
    if (!resolved.id_unidad_consumo) return markUnavailable(resolved, 'EXTRA_UNIDAD_NO_CONFIGURADA');

    resolved = {
      ...resolved,
      id_insumo_legacy: configuredId,
      id_almacen: toPositiveInventoryInt(row.id_almacen),
      id_sucursal: branchId,
      stock_disponible: Number(row.cantidad ?? 0),
      stock_minimo: Number(row.stock_minimo ?? 0),
      cantidad_consumo_base: resolved.cantidad_consumo_configurada,
      id_unidad_base: resolved.id_unidad_consumo,
      inventario_configurado: true,
      disponible: extra?.estado !== false
    };
    if (resolved.stock_disponible < resolved.cantidad_consumo_base) {
      return markUnavailable(resolved, 'EXTRA_STOCK_INSUFICIENTE', { preserveInventoryConfiguration: true });
    }
    return resolved;
  });
};

const mappingFailureCode = (status) => {
  if (status === 'REQUIERE_REVISION') return 'EXTRA_INSUMO_MAPEO_REQUIERE_REVISION';
  if (status === 'AMBIGUO') return 'EXTRA_INSUMO_MAPEO_AMBIGUO';
  if (status === 'PENDIENTE') return 'EXTRA_INSUMO_MAPEO_PENDIENTE';
  return 'EXTRA_INSUMO_MAPEO_REQUIERE_REVISION';
};

const resolveMasterExtrasInventory = async ({ queryRunner, extras, idSucursal, mode }) => {
  const branchId = toPositiveInventoryInt(idSucursal);
  const configuredIds = [...new Set(extras.map((extra) => toPositiveInventoryInt(extra?.id_insumo)).filter(Boolean))];
  const assignmentsByBranch = await loadExtraAssignmentsByBranch({
    queryRunner,
    extraIds: extras.map((extra) => extra?.id_extra),
    idSucursal,
    mode
  });
  if (!branchId) {
    return extras.map((extra) => markUnavailable(
      buildBaseResult(extra, { useMasterCatalog: true, idSucursal }),
      'EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL'
    ));
  }

  const mappingResult = configuredIds.length > 0
    ? await queryRunner.query(
        `
          SELECT id_insumo_legacy, id_insumo_maestro, estado_migracion
          FROM public.insumos_mapeo_maestro
          WHERE id_insumo_legacy = ANY($1::int[])
          ORDER BY id_insumo_legacy, id_insumo_maestro
        `,
        [configuredIds]
      )
    : { rows: [] };
  const mappingsByLegacyId = groupInventoryRowsBy(mappingResult.rows, 'id_insumo_legacy');
  const mappedMasterIds = (mappingResult.rows || []).map((row) => toPositiveInventoryInt(row.id_insumo_maestro)).filter(Boolean);
  const candidateIds = [...new Set([...configuredIds, ...mappedMasterIds])];

  const [insumosResult, assignmentsResult] = candidateIds.length > 0
    ? await Promise.all([
        queryRunner.query(
          `
            SELECT id_insumo, id_unidad_medida, COALESCE(estado, true) AS estado
            FROM public.insumos
            WHERE id_insumo = ANY($1::int[])
          `,
          [candidateIds]
        ),
        queryRunner.query(
          `
            SELECT
              ia.id_insumo,
              ia.id_almacen,
              a.id_sucursal,
              COALESCE(ia.cantidad, 0)::numeric AS cantidad,
              COALESCE(ia.stock_minimo, 0)::numeric AS stock_minimo
            FROM public.insumos_almacenes ia
            INNER JOIN public.almacenes a
              ON a.id_almacen = ia.id_almacen
             AND a.id_sucursal = $2
             AND COALESCE(a.estado, true) = true
            WHERE ia.id_insumo = ANY($1::int[])
              AND COALESCE(ia.estado, true) = true
            ORDER BY ia.id_insumo, ia.id_almacen
            ${mode === 'transactional' ? 'FOR UPDATE OF ia' : ''}
          `,
          [candidateIds, branchId]
        )
      ])
    : [{ rows: [] }, { rows: [] }];

  const insumosById = new Map((insumosResult.rows || []).map((row) => [Number(row.id_insumo), row]));
  const assignmentsByInsumo = groupInventoryRowsBy(assignmentsResult.rows, 'id_insumo');
  const resolvedMasterIds = new Set();
  const preliminary = extras.map((extra) => {
    let result = buildBaseResult(extra, { useMasterCatalog: true, idSucursal: branchId });
    if (assignmentsByBranch && !assignmentsByBranch.has(result.id_extra)) {
      return markUnavailable(result, 'EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL');
    }
    const configuredId = result.id_insumo_configurado;
    if (!configuredId) return markUnavailable(result, 'EXTRA_INSUMO_NO_CONFIGURADO');

    const directInsumo = insumosById.get(configuredId);
    const directAssignments = assignmentsByInsumo.get(configuredId) || [];
    if (directInsumo?.estado === true && directAssignments.length === 1) {
      resolvedMasterIds.add(configuredId);
      return { result, masterId: configuredId, legacyId: null, insumo: directInsumo, assignment: directAssignments[0] };
    }
    if (directInsumo?.estado === true && directAssignments.length > 1) {
      return markUnavailable(result, 'EXTRA_INSUMO_ASIGNACION_AMBIGUA');
    }

    const mappings = mappingsByLegacyId.get(configuredId) || [];
    if (mappings.length > 1) return markUnavailable(result, 'EXTRA_INSUMO_MAPEO_AMBIGUO');
    if (mappings.length === 0) {
      if (directInsumo && directInsumo.estado !== true) return markUnavailable(result, 'EXTRA_INSUMO_INACTIVO');
      if (directInsumo) return markUnavailable(result, 'EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL');
      return markUnavailable(result, 'EXTRA_INSUMO_NO_ENCONTRADO');
    }

    const mapping = mappings[0];
    const mappingStatus = normalizeMappingStatus(mapping.estado_migracion);
    if (mappingStatus !== 'VALIDADO') return markUnavailable(result, mappingFailureCode(mappingStatus));

    const masterId = toPositiveInventoryInt(mapping.id_insumo_maestro);
    const master = masterId ? insumosById.get(masterId) : null;
    if (!master) return markUnavailable(result, 'EXTRA_INSUMO_NO_ENCONTRADO');
    if (master.estado !== true) return markUnavailable(result, 'EXTRA_INSUMO_INACTIVO');
    const assignments = assignmentsByInsumo.get(masterId) || [];
    if (assignments.length === 0) return markUnavailable(result, 'EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL');
    if (assignments.length > 1) return markUnavailable(result, 'EXTRA_INSUMO_ASIGNACION_AMBIGUA');

    resolvedMasterIds.add(masterId);
    return { result, masterId, legacyId: configuredId, insumo: master, assignment: assignments[0] };
  });

  const unitIds = new Set();
  for (const entry of preliminary) {
    if (!entry?.result) continue;
    const consumptionUnitId = entry.result.id_unidad_consumo;
    const baseUnitId = toPositiveInventoryInt(entry.insumo?.id_unidad_medida);
    if (consumptionUnitId) unitIds.add(consumptionUnitId);
    if (baseUnitId) unitIds.add(baseUnitId);
  }

  const [presentationsResult, unitsResult] = await Promise.all([
    resolvedMasterIds.size > 0
      ? queryRunner.query(
          `
            SELECT
              id_insumo,
              cantidad_presentacion,
              id_unidad_presentacion,
              cantidad_base,
              id_unidad_base
            FROM public.insumo_presentaciones
            WHERE id_insumo = ANY($1::int[])
              AND estado IS TRUE
              AND uso_receta IS TRUE
              AND cantidad_presentacion > 0
              AND cantidad_base > 0
            ORDER BY id_insumo, id_presentacion
          `,
          [[...resolvedMasterIds]]
        )
      : Promise.resolve({ rows: [] }),
    unitIds.size > 0
      ? queryRunner.query(
          `SELECT id_unidad_medida FROM public.unidades_medida WHERE id_unidad_medida = ANY($1::int[])`,
          [[...unitIds]]
        )
      : Promise.resolve({ rows: [] })
  ]);
  const presentationsByInsumo = groupInventoryRowsBy(presentationsResult.rows, 'id_insumo');
  const validUnitIds = new Set((unitsResult.rows || []).map((row) => Number(row.id_unidad_medida)));

  return preliminary.map((entry) => {
    if (!entry?.result) return entry;
    let { result } = entry;
    const configuredQty = result.cantidad_consumo_configurada;
    const consumptionUnitId = result.id_unidad_consumo;
    const baseUnitId = toPositiveInventoryInt(entry.insumo?.id_unidad_medida);
    if (!configuredQty) return markUnavailable(result, 'EXTRA_CANTIDAD_CONSUMO_INVALIDA');
    if (!consumptionUnitId || !baseUnitId || !validUnitIds.has(consumptionUnitId) || !validUnitIds.has(baseUnitId)) {
      return markUnavailable(result, 'EXTRA_UNIDAD_NO_CONFIGURADA');
    }

    let baseQty = configuredQty;
    if (consumptionUnitId !== baseUnitId) {
      const compatible = (presentationsByInsumo.get(entry.masterId) || []).filter((row) =>
        toPositiveInventoryInt(row.id_unidad_presentacion) === consumptionUnitId
        && toPositiveInventoryInt(row.id_unidad_base) === baseUnitId
        && toPositiveInventoryNumber(row.cantidad_presentacion)
        && toPositiveInventoryNumber(row.cantidad_base)
      );
      if (compatible.length === 0) return markUnavailable(result, 'EXTRA_UNIDAD_SIN_CONVERSION');
      if (compatible.length > 1) return markUnavailable(result, 'EXTRA_UNIDAD_CONVERSION_AMBIGUA');
      baseQty = configuredQty
        * (Number(compatible[0].cantidad_base) / Number(compatible[0].cantidad_presentacion));
    }

    result = {
      ...result,
      id_insumo_maestro: entry.masterId,
      id_insumo_legacy: entry.legacyId,
      id_almacen: toPositiveInventoryInt(entry.assignment.id_almacen),
      id_sucursal: toPositiveInventoryInt(entry.assignment.id_sucursal),
      stock_disponible: Number(entry.assignment.cantidad ?? 0),
      stock_minimo: Number(entry.assignment.stock_minimo ?? 0),
      cantidad_consumo_base: baseQty,
      id_unidad_base: baseUnitId,
      inventario_configurado: true,
      disponible: extraIsActive(result)
    };
    if (result.stock_disponible < result.cantidad_consumo_base) {
      return markUnavailable(result, 'EXTRA_STOCK_INSUFICIENTE', { preserveInventoryConfiguration: true });
    }
    return result;
  });
};

const extraIsActive = (extra) => extra?.estado !== false;

export const resolveExtrasInventory = async ({
  queryRunner,
  extras = [],
  idSucursal = null,
  mode = 'catalog',
  masterCatalogEnabled = isCatalogoMaestroReadsEnabled()
} = {}) => {
  if (!queryRunner?.query) throw new TypeError('queryRunner es requerido para resolver inventario de extras.');
  const normalizedExtras = (Array.isArray(extras) ? extras : []).filter((extra) => toPositiveInventoryInt(extra?.id_extra));
  if (normalizedExtras.length === 0) return [];

  if (masterCatalogEnabled !== true) {
    return resolveLegacyExtrasInventory({ queryRunner, extras: normalizedExtras, idSucursal });
  }
  return resolveMasterExtrasInventory({ queryRunner, extras: normalizedExtras, idSucursal, mode });
};
