import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import {
  attachSalsaInventorySnapshotsToLines,
  attachSalsaInventorySnapshotsToPublicLines,
  resolveSalsasInventory
} from '../services/salsasInventoryService.js';

const SALSA_ID = 11;
const LEGACY_INSUMO_ID = 50;
const MASTER_INSUMO_ID = 150;
const WAREHOUSE_ID = 9;
const BRANCH_ID = 1;
const previousMasterCatalogFlag = process.env.CATALOGO_MAESTRO_READS_ENABLED;

before(() => {
  process.env.CATALOGO_MAESTRO_READS_ENABLED = 'true';
});

after(() => {
  if (previousMasterCatalogFlag === undefined) {
    delete process.env.CATALOGO_MAESTRO_READS_ENABLED;
  } else {
    process.env.CATALOGO_MAESTRO_READS_ENABLED = previousMasterCatalogFlag;
  }
});

const salsaRow = ({ consumption = 2, consumptionUnit = 1, configuredInsumo = LEGACY_INSUMO_ID } = {}) => ({
  id_salsa: SALSA_ID,
  id_complemento: SALSA_ID,
  nombre: 'Bufalo',
  estado: true,
  id_insumo: configuredInsumo,
  cantidad_porcion: consumption,
  id_unidad_consumo: consumptionUnit
});

const makeInventoryClient = ({
  stock = 10,
  published = true,
  mappingRows = [{
    id_insumo_legacy: LEGACY_INSUMO_ID,
    id_insumo_maestro: MASTER_INSUMO_ID,
    estado_migracion: 'VALIDADO'
  }],
  assignmentRows,
  baseUnit = 1,
  validUnits = [1],
  presentationRows = [],
  consumption = 2,
  consumptionUnit = 1,
  configuredInsumo = LEGACY_INSUMO_ID,
  insumoActive = true
} = {}) => ({
  async query(sql) {
    const statement = String(sql);
    if (statement.includes('FROM information_schema.columns')) {
      return {
        rows: ['id_insumo', 'cantidad_porcion', 'id_unidad_consumo'].map((column_name) => ({ column_name }))
      };
    }
    if (statement.includes('FROM public.salsas s')) {
      return { rows: published ? [salsaRow({ consumption, consumptionUnit, configuredInsumo })] : [] };
    }
    if (statement.includes('FROM public.insumos_mapeo_maestro')) {
      return { rows: mappingRows };
    }
    if (statement.includes('FROM public.insumos') && !statement.includes('insumos_almacenes')) {
      const candidateIds = new Set([
        configuredInsumo,
        ...mappingRows.map((row) => Number(row.id_insumo_maestro))
      ]);
      return {
        rows: [...candidateIds].filter(Boolean).map((id_insumo) => ({
          id_insumo,
          id_unidad_medida: baseUnit,
          estado: insumoActive
        }))
      };
    }
    if (statement.includes('FROM public.insumos_almacenes')) {
      return {
        rows: assignmentRows ?? [{
          id_insumo: MASTER_INSUMO_ID,
          id_almacen: WAREHOUSE_ID,
          id_sucursal: BRANCH_ID,
          cantidad: stock,
          stock_minimo: 0
        }]
      };
    }
    if (statement.includes('FROM public.insumo_presentaciones')) {
      return { rows: presentationRows };
    }
    if (statement.includes('FROM public.unidades_medida')) {
      return { rows: validUnits.map((id_unidad_medida) => ({ id_unidad_medida })) };
    }
    throw new Error(`Consulta inesperada en prueba de salsas: ${statement}`);
  }
});

const resolveOne = async (options = {}) => {
  const consumption = options.consumption ?? 2;
  const consumptionUnit = options.consumptionUnit ?? 1;
  const configuredInsumo = options.configuredInsumo === undefined
    ? LEGACY_INSUMO_ID
    : options.configuredInsumo;
  const [resolved] = await resolveSalsasInventory({
    queryRunner: makeInventoryClient(options),
    salsas: [salsaRow({ consumption, consumptionUnit, configuredInsumo })],
    idSucursal: BRANCH_ID,
    mode: 'transactional',
    masterCatalogEnabled: true
  });
  return resolved;
};

const cajaLine = ({ quantity = 1 } = {}) => ({
  id_detalle_pedido: 701,
  cantidad: quantity,
  complementos_detalle: [{ id_salsa: SALSA_ID, id_complemento: SALSA_ID, nombre: 'Bufalo' }]
});

const publicLine = ({ quantity = 1, portions = 1 } = {}) => ({
  cantidad: quantity,
  configuracion_menu: {
    salsas_por_unidad: [{ id_salsa: SALSA_ID, id_complemento: SALSA_ID, nombre: 'Bufalo', cantidad: portions }]
  }
});

describe('politica POS de deficit para salsas', () => {
  for (const scenario of [
    { stock: 10, consumption: 2 },
    { stock: 2, consumption: 4 },
    { stock: 0, consumption: 2 },
    { stock: -5, consumption: 2 }
  ]) {
    it(`resuelve stock ${scenario.stock} / consumo ${scenario.consumption} como disponible`, async () => {
      const result = await resolveOne(scenario);

      assert.equal(result.disponible, true);
      assert.equal(result.inventario_configurado, true);
      assert.equal(result.stock_disponible, scenario.stock);
      assert.equal(result.cantidad_consumo_base, scenario.consumption);
      assert.equal(result.id_insumo_maestro, MASTER_INSUMO_ID);
      assert.equal(result.id_almacen, WAREHOUSE_ID);
      assert.equal(
        result.stock_disponible - result.cantidad_consumo_base,
        scenario.stock - scenario.consumption
      );
    });
  }

  it('permite varias lineas cuyo consumo agregado supera el stock', async () => {
    const lines = [cajaLine(), { ...cajaLine(), id_detalle_pedido: 702 }];
    const usage = await attachSalsaInventorySnapshotsToLines({
      client: makeInventoryClient({ stock: 5, consumption: 4 }),
      lines,
      idSucursal: BRANCH_ID
    });

    assert.equal(usage.length, 1);
    assert.equal(usage[0].stockDisponible, 5);
    assert.equal(usage[0].requerido, 8);
    assert.equal(lines[0].salsas_inventario_snapshot[0].cantidad_base_total, 4);
    assert.equal(lines[1].salsas_inventario_snapshot[0].cantidad_base_total, 4);
  });

  it('attachSalsaInventorySnapshotsToLines conserva snapshot y no lanza por deficit', async () => {
    const lines = [cajaLine()];
    const usage = await attachSalsaInventorySnapshotsToLines({
      client: makeInventoryClient({ stock: 0, consumption: 2 }),
      lines,
      idSucursal: BRANCH_ID
    });

    assert.equal(usage[0].requerido, 2);
    assert.equal(lines[0].complementos_detalle[0].inventario.stock_disponible, 0);
    assert.equal(lines[0].complementos_detalle[0].inventario.cantidad_consumo_base, 2);
    assert.equal(lines[0].complementos_detalle[0].inventario.cantidad_base_total, 2);
  });

  it('attachSalsaInventorySnapshotsToPublicLines conserva snapshot y no bloquea por deficit', async () => {
    const lines = [publicLine({ quantity: 2, portions: 2 })];
    const result = await attachSalsaInventorySnapshotsToPublicLines({
      client: makeInventoryClient({ stock: -5, consumption: 2 }),
      lines,
      idSucursal: BRANCH_ID
    });

    assert.equal(result, lines);
    assert.equal(lines[0].configuracion_menu.salsas_por_unidad[0].inventario.cantidad_base_total, 8);
  });

  it('sigue bloqueando mapeo maestro ambiguo', async () => {
    const result = await resolveOne({
      mappingRows: [
        { id_insumo_legacy: LEGACY_INSUMO_ID, id_insumo_maestro: 150, estado_migracion: 'VALIDADO' },
        { id_insumo_legacy: LEGACY_INSUMO_ID, id_insumo_maestro: 151, estado_migracion: 'VALIDADO' }
      ]
    });

    assert.equal(result.disponible, false);
    assert.equal(result.codigo_no_disponible, 'SALSA_INSUMO_MAPEO_AMBIGUO');
  });

  it('sigue bloqueando insumo sin asignacion de sucursal', async () => {
    const result = await resolveOne({ assignmentRows: [] });

    assert.equal(result.disponible, false);
    assert.equal(result.codigo_no_disponible, 'SALSA_INSUMO_SIN_ASIGNACION_SUCURSAL');
  });

  it('sigue bloqueando insumo ausente, inactivo y asignacion ambigua', async () => {
    const missing = await resolveOne({ configuredInsumo: null });
    assert.equal(missing.codigo_no_disponible, 'SALSA_INSUMO_NO_CONFIGURADO');

    const inactive = await resolveOne({ insumoActive: false });
    assert.equal(inactive.codigo_no_disponible, 'SALSA_INSUMO_INACTIVO');

    const ambiguousAssignment = await resolveOne({
      assignmentRows: [
        { id_insumo: MASTER_INSUMO_ID, id_almacen: 9, id_sucursal: BRANCH_ID, cantidad: 10, stock_minimo: 0 },
        { id_insumo: MASTER_INSUMO_ID, id_almacen: 10, id_sucursal: BRANCH_ID, cantidad: 10, stock_minimo: 0 }
      ]
    });
    assert.equal(ambiguousAssignment.codigo_no_disponible, 'SALSA_INSUMO_ASIGNACION_AMBIGUA');
  });

  it('sigue bloqueando unidad inexistente y conversion ausente', async () => {
    const invalidUnit = await resolveOne({ validUnits: [] });
    assert.equal(invalidUnit.disponible, false);
    assert.equal(invalidUnit.codigo_no_disponible, 'SALSA_UNIDAD_NO_CONFIGURADA');

    const missingConversion = await resolveOne({
      consumptionUnit: 2,
      validUnits: [1, 2],
      presentationRows: []
    });
    assert.equal(missingConversion.disponible, false);
    assert.equal(missingConversion.codigo_no_disponible, 'SALSA_UNIDAD_SIN_CONVERSION');

    const ambiguousConversion = await resolveOne({
      consumptionUnit: 2,
      validUnits: [1, 2],
      presentationRows: [
        { id_insumo: MASTER_INSUMO_ID, cantidad_presentacion: 1, id_unidad_presentacion: 2, cantidad_base: 2, id_unidad_base: 1 },
        { id_insumo: MASTER_INSUMO_ID, cantidad_presentacion: 2, id_unidad_presentacion: 2, cantidad_base: 4, id_unidad_base: 1 }
      ]
    });
    assert.equal(ambiguousConversion.codigo_no_disponible, 'SALSA_UNIDAD_CONVERSION_AMBIGUA');
  });

  it('sigue bloqueando cantidad de consumo invalida', async () => {
    const result = await resolveOne({ consumption: 0 });

    assert.equal(result.disponible, false);
    assert.equal(result.codigo_no_disponible, 'SALSA_CANTIDAD_CONSUMO_INVALIDA');
  });

  it('sigue bloqueando salsa no publicada en Caja y menu publico', async () => {
    await assert.rejects(
      () => attachSalsaInventorySnapshotsToLines({
        client: makeInventoryClient({ published: false }),
        lines: [cajaLine()],
        idSucursal: BRANCH_ID
      }),
      (error) => error?.code === 'SALSA_NO_PUBLICADA_SUCURSAL'
    );
    await assert.rejects(
      () => attachSalsaInventorySnapshotsToPublicLines({
        client: makeInventoryClient({ published: false }),
        lines: [publicLine()],
        idSucursal: BRANCH_ID
      }),
      (error) => error?.code === 'SALSA_NO_PUBLICADA_SUCURSAL'
    );
  });

  it('venta pagada y pedido pendiente atraviesan el mismo procesamiento con balance proyectado negativo', async () => {
    for (const line of [cajaLine({ quantity: 2 }), cajaLine({ quantity: 2 })]) {
      const usage = await attachSalsaInventorySnapshotsToLines({
        client: makeInventoryClient({ stock: 2, consumption: 2 }),
        lines: [line],
        idSucursal: BRANCH_ID
      });
      assert.equal(usage[0].stockDisponible - usage[0].requerido, -2);
    }

    const source = await readFile(new URL('../../ventas.js', import.meta.url), 'utf8');
    assert.equal((source.match(/await attachSalsaInventorySnapshotsToLines\(\{/g) || []).length, 2);
  });
});
