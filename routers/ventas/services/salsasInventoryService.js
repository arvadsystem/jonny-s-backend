import { isCatalogoMaestroReadsEnabled } from '../../../services/catalogoMaestroReadService.js';
import {
  groupInventoryRowsBy,
  toPositiveInventoryInt,
  toPositiveInventoryNumber
} from './extrasInventoryService.js';
import { classifySalsaMapping } from './salsasInventoryPolicyService.js';

const SALSA_MESSAGES = Object.freeze({
  SALSA_INSUMO_NO_CONFIGURADO: 'Esta salsa requiere configurar su inventario.',
  SALSA_INSUMO_NO_ENCONTRADO: 'Esta salsa no tiene un insumo de inventario valido.',
  SALSA_INSUMO_INACTIVO: 'El insumo de esta salsa esta inactivo.',
  SALSA_INSUMO_MAPEO_REQUIERE_REVISION: 'Esta salsa requiere revision de inventario.',
  SALSA_INSUMO_MAPEO_AMBIGUO: 'Esta salsa requiere revisar su vinculo con inventario.',
  SALSA_INSUMO_MAPEO_PENDIENTE: 'Esta salsa requiere revision de inventario.',
  SALSA_INSUMO_SIN_ASIGNACION_SUCURSAL: 'Esta salsa no esta disponible en la sucursal seleccionada.',
  SALSA_INSUMO_ASIGNACION_AMBIGUA: 'Esta salsa tiene una configuracion de inventario ambigua.',
  SALSA_CANTIDAD_CONSUMO_INVALIDA: 'Esta salsa no tiene una cantidad de consumo valida.',
  SALSA_UNIDAD_NO_CONFIGURADA: 'Esta salsa no tiene una unidad de consumo valida.',
  SALSA_UNIDAD_SIN_CONVERSION: 'Esta salsa no tiene una conversion de unidad configurada.',
  SALSA_UNIDAD_CONVERSION_AMBIGUA: 'Esta salsa tiene mas de una conversion de unidad aplicable.',
  SALSA_STOCK_INSUFICIENTE: 'No hay existencias suficientes para esta salsa.'
});

const markUnavailable = (result, code, { preserveInventoryConfiguration = false } = {}) => ({
  ...result,
  inventario_configurado: preserveInventoryConfiguration ? Boolean(result.inventario_configurado) : false,
  disponible: false,
  codigo_no_disponible: code,
  motivo_no_disponible: SALSA_MESSAGES[code] || 'Esta salsa no esta disponible.'
});

const buildBaseResult = (salsa, { idSucursal, useMasterCatalog }) => ({
  ...salsa,
  id_salsa: toPositiveInventoryInt(salsa?.id_salsa),
  id_complemento: toPositiveInventoryInt(salsa?.id_complemento || salsa?.id_salsa),
  id_insumo_configurado: toPositiveInventoryInt(salsa?.id_insumo),
  id_insumo_maestro: null,
  id_insumo_legacy: null,
  id_almacen: null,
  id_sucursal: toPositiveInventoryInt(idSucursal),
  stock_disponible: null,
  stock_minimo: null,
  cantidad_consumo_configurada: toPositiveInventoryNumber(salsa?.cantidad_porcion),
  id_unidad_consumo: toPositiveInventoryInt(salsa?.id_unidad_consumo),
  cantidad_consumo_base: null,
  id_unidad_base: null,
  inventario_configurado: false,
  disponible: false,
  motivo_no_disponible: null,
  codigo_no_disponible: null,
  usa_catalogo_maestro: useMasterCatalog
});

const normalizeSelectedSalsas = (lines = []) => {
  const selections = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    for (const salsa of Array.isArray(line?.complementos_detalle) ? line.complementos_detalle : []) {
      const idSalsa = toPositiveInventoryInt(salsa?.id_salsa || salsa?.id_complemento);
      if (!idSalsa) continue;
      selections.push({
        id_salsa: idSalsa,
        id_complemento: toPositiveInventoryInt(salsa?.id_complemento || idSalsa),
        nombre: String(salsa?.nombre || 'Salsa').trim()
      });
    }
  }
  return selections;
};

const SALSA_INVENTORY_SCHEMA_COLUMNS = Object.freeze(['id_insumo', 'cantidad_porcion', 'id_unidad_consumo']);
let salsaInventorySchemaAvailable = null;

const assertSalsaInventorySchemaAvailable = async (queryRunner) => {
  if (salsaInventorySchemaAvailable === true) return;
  const result = await queryRunner.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'salsas'
        AND column_name = ANY($1::text[])
    `,
    [SALSA_INVENTORY_SCHEMA_COLUMNS]
  );
  const columns = new Set((result.rows || []).map((row) => String(row.column_name)));
  const missing = SALSA_INVENTORY_SCHEMA_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw createInventoryError(
      'VENTAS_SALSAS_INVENTARIO_SCHEMA_PENDIENTE',
      `Inventario de salsas no disponible: faltan columnas en public.salsas (${missing.join(', ')}). Aplica la migracion versionada antes de vender salsas con inventario.`
    );
  }
  salsaInventorySchemaAvailable = true;
};

export const getSelectedSalsaIdsFromLines = (lines = []) => (
  [...new Set(normalizeSelectedSalsas(lines).map((salsa) => salsa.id_salsa).filter(Boolean))]
);

export const fetchSalsaInventoryRows = async ({ queryRunner, salsaIds = [], idSucursal } = {}) => {
  if (!queryRunner?.query) throw new TypeError('queryRunner es requerido para cargar inventario de salsas.');
  const branchId = toPositiveInventoryInt(idSucursal);
  if (!branchId) throw createInventoryError('SALSA_SUCURSAL_REQUERIDA', 'La sucursal es obligatoria para resolver salsas.');
  const ids = [...new Set((Array.isArray(salsaIds) ? salsaIds : []).map((id) => toPositiveInventoryInt(id)).filter(Boolean))];
  if (ids.length === 0) return [];
  await assertSalsaInventorySchemaAvailable(queryRunner);
  const result = await queryRunner.query(
    `
      SELECT
        s.id_salsa,
        s.id_salsa AS id_complemento,
        s.nombre,
        COALESCE(s.estado, true) AS estado,
        s.id_insumo,
        COALESCE(s.cantidad_porcion, 2)::numeric AS cantidad_porcion,
        s.id_unidad_consumo
      FROM public.salsas s
      INNER JOIN public.salsa_sucursales ss
        ON ss.id_salsa = s.id_salsa
       AND ss.id_sucursal = $2
       AND ss.estado IS TRUE
       AND ss.publicada IS TRUE
      WHERE s.id_salsa = ANY($1::int[])
        AND COALESCE(s.estado, TRUE) IS TRUE
    `,
    [ids, branchId]
  );
  return result.rows || [];
};

export const resolveSalsasInventory = async ({
  queryRunner,
  salsas = [],
  idSucursal = null,
  mode = 'catalog',
  masterCatalogEnabled = isCatalogoMaestroReadsEnabled()
} = {}) => {
  if (!queryRunner?.query) throw new TypeError('queryRunner es requerido para resolver inventario de salsas.');
  const normalized = (Array.isArray(salsas) ? salsas : []).filter((salsa) => toPositiveInventoryInt(salsa?.id_salsa));
  if (normalized.length === 0) return [];
  const branchId = toPositiveInventoryInt(idSucursal);
  const useMasterCatalog = masterCatalogEnabled === true;

  if (!branchId) {
    return normalized.map((salsa) => markUnavailable(
      buildBaseResult(salsa, { idSucursal, useMasterCatalog }),
      'SALSA_INSUMO_SIN_ASIGNACION_SUCURSAL'
    ));
  }

  const configuredIds = [...new Set(normalized.map((salsa) => toPositiveInventoryInt(salsa?.id_insumo)).filter(Boolean))];
  const mappingResult = useMasterCatalog && configuredIds.length > 0
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
  const candidateIds = [...new Set(useMasterCatalog ? [...configuredIds, ...mappedMasterIds] : configuredIds)];

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

  const preliminary = normalized.map((salsa) => {
    const result = buildBaseResult(salsa, { idSucursal: branchId, useMasterCatalog });
    const configuredId = result.id_insumo_configurado;
    if (!configuredId) return markUnavailable(result, 'SALSA_INSUMO_NO_CONFIGURADO');

    const mappings = mappingsByLegacyId.get(configuredId) || [];
    const structural = classifySalsaMapping({
      configuredId,
      mappingCount: mappings.length,
      mappingStatus: mappings[0]?.estado_migracion,
      masterId: mappings[0]?.id_insumo_maestro,
      masterCatalogEnabled: useMasterCatalog
    });
    if (!structural.ok) return markUnavailable(result, structural.code);

    const effectiveId = toPositiveInventoryInt(structural.effectiveInsumoId);
    const effectiveInsumo = effectiveId ? insumosById.get(effectiveId) : null;
    if (!effectiveInsumo) return markUnavailable(result, 'SALSA_INSUMO_NO_ENCONTRADO');
    if (effectiveInsumo.estado !== true) return markUnavailable(result, 'SALSA_INSUMO_INACTIVO');
    const assignments = assignmentsByInsumo.get(effectiveId) || [];
    if (assignments.length === 0) return markUnavailable(result, 'SALSA_INSUMO_SIN_ASIGNACION_SUCURSAL');
    if (assignments.length > 1) return markUnavailable(result, 'SALSA_INSUMO_ASIGNACION_AMBIGUA');
    resolvedMasterIds.add(effectiveId);
    return {
      result,
      masterId: effectiveId,
      legacyId: structural.legacyInsumoId,
      insumo: effectiveInsumo,
      assignment: assignments[0]
    };
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
        'SELECT id_unidad_medida FROM public.unidades_medida WHERE id_unidad_medida = ANY($1::int[])',
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
    if (!configuredQty) return markUnavailable(result, 'SALSA_CANTIDAD_CONSUMO_INVALIDA');
    if (!consumptionUnitId || !baseUnitId || !validUnitIds.has(consumptionUnitId) || !validUnitIds.has(baseUnitId)) {
      return markUnavailable(result, 'SALSA_UNIDAD_NO_CONFIGURADA');
    }

    let baseQty = configuredQty;
    if (consumptionUnitId !== baseUnitId) {
      const compatible = (presentationsByInsumo.get(entry.masterId) || []).filter((row) =>
        toPositiveInventoryInt(row.id_unidad_presentacion) === consumptionUnitId
        && toPositiveInventoryInt(row.id_unidad_base) === baseUnitId
        && toPositiveInventoryNumber(row.cantidad_presentacion)
        && toPositiveInventoryNumber(row.cantidad_base)
      );
      if (compatible.length === 0) return markUnavailable(result, 'SALSA_UNIDAD_SIN_CONVERSION');
      if (compatible.length > 1) return markUnavailable(result, 'SALSA_UNIDAD_CONVERSION_AMBIGUA');
      baseQty = configuredQty * (Number(compatible[0].cantidad_base) / Number(compatible[0].cantidad_presentacion));
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
      disponible: result.estado !== false
    };
    if (result.stock_disponible < result.cantidad_consumo_base) {
      return markUnavailable(result, 'SALSA_STOCK_INSUFICIENTE', { preserveInventoryConfiguration: true });
    }
    return result;
  });
};

const createInventoryError = (code, message) => {
  const error = new Error(message);
  error.httpStatus = 409;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const isStockTriggerError = (error) => {
  const message = String(error?.message || '');
  return /stock insuficiente/i.test(message)
    || /no se pudo actualizar el stock/i.test(message)
    || /insumos_almacenes/i.test(message);
};

const wrapInventoryMutationError = (error) => {
  if (isStockTriggerError(error)) {
    return createInventoryError('VENTAS_SALSA_STOCK_INSUFICIENTE', 'No hay existencias suficientes para salsa en inventario.');
  }
  return error;
};

export const buildSalsaConsumptionSnapshot = (resolved, count, lineQuantity = 1) => {
  const cantidadLinea = toPositiveInventoryInt(lineQuantity) || 1;
  const porcionesPorOrden = Math.max(1, Number(count || 0));
  return {
    id_complemento: resolved.id_complemento || resolved.id_salsa,
    id_salsa: resolved.id_salsa,
    nombre: String(resolved.nombre || 'Salsa').trim(),
    id_insumo: resolved.usa_catalogo_maestro ? resolved.id_insumo_maestro : (resolved.id_insumo_legacy || resolved.id_insumo_configurado),
    id_insumo_configurado: resolved.id_insumo_configurado,
    id_insumo_maestro: resolved.id_insumo_maestro,
    id_insumo_legacy: resolved.id_insumo_legacy,
    cantidad_porcion: Number(resolved.cantidad_consumo_configurada || 0),
    id_unidad_consumo: resolved.id_unidad_consumo,
    cantidad_base_por_porcion: Number(resolved.cantidad_consumo_base || 0),
    cantidad_base_total: Number(resolved.cantidad_consumo_base || 0) * porcionesPorOrden * cantidadLinea,
    id_unidad_base: resolved.id_unidad_base,
    id_almacen: resolved.id_almacen,
    porciones: porcionesPorOrden,
    porciones_por_orden: porcionesPorOrden,
    porciones_total: porcionesPorOrden * cantidadLinea,
    cantidad_linea: cantidadLinea,
    usa_catalogo_maestro: Boolean(resolved.usa_catalogo_maestro)
  };
};

export const attachSalsaInventorySnapshotsToLines = async ({ client, lines = [], idSucursal }) => {
  const selected = normalizeSelectedSalsas(lines);
  if (!selected.length) return [];

  const rows = await fetchSalsaInventoryRows({
    queryRunner: client,
    salsaIds: selected.map((salsa) => salsa.id_salsa),
    idSucursal
  });
  const rowsById = new Map(rows.map((row) => [Number(row.id_salsa), row]));
  const resolvedRows = await resolveSalsasInventory({
    queryRunner: client,
    salsas: rows,
    idSucursal,
    mode: 'transactional'
  });
  const resolvedById = new Map(resolvedRows.map((row) => [Number(row.id_salsa), row]));

  const usageByStockKey = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!Array.isArray(line?.complementos_detalle) || line.complementos_detalle.length === 0) continue;
    const snapshots = [];
    const lineCounts = new Map();
    for (const salsa of line.complementos_detalle) {
      const idSalsa = toPositiveInventoryInt(salsa?.id_salsa || salsa?.id_complemento);
      if (!idSalsa) continue;
      lineCounts.set(idSalsa, (lineCounts.get(idSalsa) || 0) + 1);
    }
    for (const [idSalsa, count] of lineCounts.entries()) {
      const source = rowsById.get(idSalsa);
      const resolved = resolvedById.get(idSalsa);
      if (!source) {
        throw createInventoryError('SALSA_NO_PUBLICADA_SUCURSAL', `La salsa ${idSalsa} no esta publicada en esta sucursal.`);
      }
      if (!resolved?.disponible || !resolved.inventario_configurado) {
        throw createInventoryError(
          'VENTAS_SALSA_INVENTARIO_NO_DISPONIBLE',
          `La salsa ${source.nombre || idSalsa} no esta disponible en esta sucursal: ${String(resolved?.motivo_no_disponible || 'requiere revisar su configuracion de inventario.').toLowerCase()}`
        );
      }
      const snapshot = buildSalsaConsumptionSnapshot(resolved, count, line?.cantidad);
      if (!snapshot.id_insumo || !snapshot.id_almacen || snapshot.cantidad_base_total <= 0) {
        throw createInventoryError('VENTAS_SALSA_INVENTARIO_NO_DISPONIBLE', `La salsa ${source.nombre || idSalsa} requiere revisar su configuracion de inventario.`);
      }
      const stockKey = `${snapshot.id_insumo}:${snapshot.id_almacen}`;
      const current = usageByStockKey.get(stockKey) || {
        idInsumo: snapshot.id_insumo,
        idAlmacen: snapshot.id_almacen,
        nombre: snapshot.nombre,
        stockDisponible: Number(resolved.stock_disponible ?? 0),
        requerido: 0
      };
      current.requerido += snapshot.cantidad_base_total;
      usageByStockKey.set(stockKey, current);
      snapshots.push(snapshot);
    }
    line.salsas_inventario_snapshot = snapshots;
    line.complementos_detalle = line.complementos_detalle.map((salsa) => {
      const idSalsa = toPositiveInventoryInt(salsa?.id_salsa || salsa?.id_complemento);
      const snapshot = snapshots.find((entry) => Number(entry.id_salsa) === idSalsa);
      return snapshot
        ? {
            ...salsa,
            inventario: {
              ...snapshot
            }
          }
        : salsa;
    });
  }

  for (const usage of usageByStockKey.values()) {
    if (usage.stockDisponible < usage.requerido) {
      throw createInventoryError('VENTAS_SALSA_STOCK_INSUFICIENTE', `No hay existencias suficientes para la salsa ${usage.nombre}.`);
    }
  }

  return [...usageByStockKey.values()];
};

export const attachSalsaInventorySnapshotsToPublicLines = async ({ client, lines = [], idSucursal }) => {
  const salsaIds = [];
  for (const line of lines) {
    for (const salsa of Array.isArray(line?.configuracion_menu?.salsas_por_unidad)
      ? line.configuracion_menu.salsas_por_unidad
      : []) {
      const idSalsa = toPositiveInventoryInt(salsa?.id_salsa || salsa?.id_complemento);
      if (idSalsa) salsaIds.push(idSalsa);
    }
  }
  if (!salsaIds.length) return [];
  const rows = await fetchSalsaInventoryRows({ queryRunner: client, salsaIds, idSucursal });
  const rowsById = new Map(rows.map((row) => [Number(row.id_salsa), row]));
  const resolved = await resolveSalsasInventory({
    queryRunner: client,
    salsas: rows,
    idSucursal,
    mode: 'transactional'
  });
  const resolvedById = new Map(resolved.map((row) => [Number(row.id_salsa), row]));
  const usageByStockKey = new Map();

  for (const line of lines) {
    const selections = Array.isArray(line?.configuracion_menu?.salsas_por_unidad)
      ? line.configuracion_menu.salsas_por_unidad
      : [];
    line.configuracion_menu.salsas_por_unidad = selections.map((selection) => {
      const idSalsa = toPositiveInventoryInt(selection?.id_salsa || selection?.id_complemento);
      const source = rowsById.get(idSalsa);
      const inventory = resolvedById.get(idSalsa);
      if (!source) {
        throw createInventoryError('SALSA_NO_PUBLICADA_SUCURSAL', `La salsa ${idSalsa} no esta publicada en esta sucursal.`);
      }
      if (!inventory?.disponible || !inventory.inventario_configurado) {
        throw createInventoryError(
          'VENTAS_SALSA_INVENTARIO_NO_DISPONIBLE',
          `La salsa ${source.nombre} no esta disponible: ${String(inventory?.motivo_no_disponible || 'inventario invalido').toLowerCase()}`
        );
      }
      const portions = Math.max(1, toPositiveInventoryInt(selection?.cantidad) || 1);
      const snapshot = buildSalsaConsumptionSnapshot(inventory, portions, line?.cantidad);
      const stockKey = `${snapshot.id_insumo}:${snapshot.id_almacen}`;
      const usage = usageByStockKey.get(stockKey) || {
        nombre: snapshot.nombre,
        stockDisponible: Number(inventory.stock_disponible || 0),
        requerido: 0
      };
      usage.requerido += snapshot.cantidad_base_total;
      usageByStockKey.set(stockKey, usage);
      return {
        ...selection,
        inventario: snapshot
      };
    });
  }
  for (const usage of usageByStockKey.values()) {
    if (usage.stockDisponible < usage.requerido) {
      throw createInventoryError('VENTAS_SALSA_STOCK_INSUFICIENTE', `No hay existencias suficientes para la salsa ${usage.nombre}.`);
    }
  }
  return lines;
};

export const consumeSalsasInventoryFromSnapshots = async ({
  client,
  lines = [],
  idUsuario = null,
  idReferencia = null,
  refOrigen = 'VENTA_SALSA',
  descripcion = 'Salida por salsa vendida'
} = {}) => {
  const usage = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    for (const entry of Array.isArray(line?.salsas_inventario_snapshot) ? line.salsas_inventario_snapshot : []) {
      const idInsumo = toPositiveInventoryInt(entry?.id_insumo);
      const idAlmacen = toPositiveInventoryInt(entry?.id_almacen);
      const cantidad = Number(entry?.cantidad_base_total || 0);
      if (!idInsumo || !idAlmacen || cantidad <= 0) continue;
      const key = `${idInsumo}:${idAlmacen}`;
      const current = usage.get(key) || { idInsumo, idAlmacen, cantidad: 0, nombres: new Set() };
      current.cantidad += cantidad;
      if (entry.nombre) current.nombres.add(entry.nombre);
      usage.set(key, current);
    }
  }

  for (const row of usage.values()) {
    const stockResult = await client.query(
      `
        SELECT cantidad
        FROM public.insumos_almacenes
        WHERE id_insumo = $1
          AND id_almacen = $2
          AND COALESCE(estado, true) = true
        FOR UPDATE
      `,
      [row.idInsumo, row.idAlmacen]
    );
    const stock = Number(stockResult.rows?.[0]?.cantidad || 0);
    if (!stockResult.rowCount || stock < row.cantidad) {
      throw createInventoryError('VENTAS_SALSA_STOCK_INSUFICIENTE', `No hay existencias suficientes para salsa en inventario.`);
    }
    try {
      await client.query(
        `
          INSERT INTO public.movimientos_inventario (
            tipo,
            cantidad,
            id_almacen,
            id_insumo,
            ref_origen,
            id_ref,
            descripcion
          )
          VALUES ('SALIDA', $1, $2, $3, $4, $5, $6)
        `,
        [
          row.cantidad,
          row.idAlmacen,
          row.idInsumo,
          refOrigen,
          idReferencia,
          `${descripcion}: ${[...row.nombres].join(', ') || 'salsas'}${toPositiveInventoryInt(idUsuario) ? ` - usuario ${idUsuario}` : ''}`
        ]
      );
    } catch (error) {
      throw wrapInventoryMutationError(error);
    }
  }

  return [...usage.values()];
};

export const restoreSalsasInventoryFromSnapshots = async ({
  client,
  snapshots = [],
  idReversion = null,
  codigoReversion = null,
  codigoVenta = null
} = {}) => {
  const usage = new Map();
  for (const entry of Array.isArray(snapshots) ? snapshots : []) {
    const idInsumo = toPositiveInventoryInt(entry?.id_insumo);
    const idAlmacen = toPositiveInventoryInt(entry?.id_almacen);
    const cantidad = Number(entry?.cantidad_base_total || 0);
    if (!idInsumo || !idAlmacen || cantidad <= 0) continue;
    const key = `${idInsumo}:${idAlmacen}`;
    const current = usage.get(key) || { idInsumo, idAlmacen, cantidad: 0, nombres: new Set() };
    current.cantidad += cantidad;
    if (entry.nombre) current.nombres.add(entry.nombre);
    usage.set(key, current);
  }

  for (const row of usage.values()) {
    const stockResult = await client.query(
      `
        SELECT cantidad
        FROM public.insumos_almacenes
        WHERE id_insumo = $1
          AND id_almacen = $2
        FOR UPDATE
      `,
      [row.idInsumo, row.idAlmacen]
    );
    if (!stockResult.rowCount) {
      throw createInventoryError('VENTAS_SALSA_INVENTARIO_NO_DISPONIBLE', 'No se encontro el stock de salsa para restaurar inventario.');
    }
    try {
      await client.query(
        `
          INSERT INTO public.movimientos_inventario (
            tipo,
            cantidad,
            id_almacen,
            id_insumo,
            ref_origen,
            id_ref,
            descripcion
          )
          VALUES ('ENTRADA', $1, $2, $3, 'REVERSION_VENTA_SALSA', $4, $5)
        `,
        [
          row.cantidad,
          row.idAlmacen,
          row.idInsumo,
          idReversion,
          `Entrada por reversion ${codigoReversion || ''} de venta ${codigoVenta || ''}: ${[...row.nombres].join(', ') || 'salsas'}`
        ]
      );
    } catch (error) {
      throw wrapInventoryMutationError(error);
    }
  }
};
