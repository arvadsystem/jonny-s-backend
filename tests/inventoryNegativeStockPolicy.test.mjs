import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validarStockConBloqueo } from '../services/inventarioStockValidator.js';
import {
  analyzePedidoMovementState,
  buildLineMovementRows
} from '../services/inventarioMovimientoService.js';
import { buildSalsaConsumptionItemsFromPedidoDetails } from '../services/salsasPedidoSnapshotService.js';
import { attachSalsaInventorySnapshotsToLines } from '../routers/ventas/services/salsasInventoryService.js';
import { buildComplementLineConfig } from '../routers/ventas/services/ventasPayloadService.js';

process.env.CATALOGO_MAESTRO_READS_ENABLED = 'false';

const makeStockClient = ({
  products = {},
  insumos = {},
  almacenes = {
    10: { id_almacen: 10, id_sucursal: 6, estado: true },
    20: { id_almacen: 20, id_sucursal: 6, estado: true }
  }
} = {}) => ({
  async query(sql, params = []) {
    const text = String(sql);
    const ids = Array.isArray(params[0]) ? params[0].map(Number) : [];

    if (text.includes('FROM public.productos p')) {
      return {
        rows: ids
          .map((id) => products[id])
          .filter(Boolean)
          .map((row, index) => ({
            id_producto: Number(row.id_producto || ids[index]),
            id_producto_maestro: Number(row.id_producto_maestro || row.id_producto || ids[index]),
            nombre_producto: row.nombre_producto || `Producto ${row.id_producto || ids[index]}`,
            precio: row.precio ?? 1,
            estado: row.estado ?? true,
            cantidad: row.cantidad ?? 0,
            stock_minimo: row.stock_minimo ?? 0,
            id_almacen: row.id_almacen ?? 10,
            id_sucursal: row.id_sucursal ?? 6
          }))
      };
    }

    if (text.includes('FROM public.insumos i') && text.includes('FOR UPDATE')) {
      return {
        rows: ids
          .map((id) => insumos[id])
          .filter(Boolean)
          .map((row, index) => ({
            id_insumo: Number(row.id_insumo || ids[index]),
            nombre_insumo: row.nombre_insumo || `Insumo ${row.id_insumo || ids[index]}`,
            estado: row.estado ?? true,
            cantidad: row.cantidad ?? 0,
            stock_minimo: row.stock_minimo ?? 0,
            id_almacen: row.id_almacen ?? 20
          }))
      };
    }

    if (text.includes('FROM public.almacenes a')) {
      return {
        rows: ids
          .map((id) => almacenes[id])
          .filter(Boolean)
      };
    }

    return { rows: [] };
  }
});

const validate = (client, { productos = [], insumos = [], expectedInsumoWarehouseById = new Map() } = {}) =>
  validarStockConBloqueo({
    client,
    idSucursal: 6,
    productoQtyMap: new Map(productos),
    insumoQtyMap: new Map(insumos),
    expectedInsumoWarehouseById
  });

const stockShortages = (result) =>
  result.faltantes.filter((item) => item.motivo === 'STOCK_INSUFICIENTE');

const stockLowWarnings = (result) =>
  result.advertencias.filter((item) => item.motivo === 'STOCK_BAJO');

const makeSalsaClient = () => ({
  async query(sql) {
    const text = String(sql);
    if (text.includes('information_schema.columns')) {
      return {
        rows: [
          { column_name: 'id_insumo' },
          { column_name: 'cantidad_porcion' },
          { column_name: 'id_unidad_consumo' }
        ]
      };
    }
    if (text.includes('FROM public.salsas')) {
      return {
        rows: [{
          id_salsa: 40,
          id_complemento: 40,
          nombre: 'Cajun',
          estado: true,
          id_insumo: 400,
          cantidad_porcion: 2,
          id_unidad_consumo: 1
        }]
      };
    }
    if (text.includes('SELECT id_insumo, id_unidad_medida')) {
      return { rows: [{ id_insumo: 400, id_unidad_medida: 1, estado: true }] };
    }
    if (text.includes('FROM public.insumos_almacenes')) {
      return {
        rows: [{
          id_insumo: 400,
          id_almacen: 20,
          id_sucursal: 6,
          cantidad: 1,
          stock_minimo: 0
        }]
      };
    }
    if (text.includes('FROM public.unidades_medida')) {
      return { rows: [{ id_unidad_medida: 1 }] };
    }
    return { rows: [] };
  }
});

describe('politica de stock negativo en ventas e inventario', () => {
  it('PRODUCTO: stock 10, venta 1 queda suficiente y saldo proyectado 9', async () => {
    const result = await validate(makeStockClient({
      products: { 1: { id_producto: 1, cantidad: 10 } }
    }), { productos: [[1, 1]] });

    assert.equal(result.faltantes.length, 0);
    assert.equal(result.excludedResources.productoIds.size, 0);
  });

  it('PRODUCTO: stock 10, minimo 5, venta 7 queda STOCK_BAJO sin faltante negativo', async () => {
    const result = await validate(makeStockClient({
      products: { 1: { id_producto: 1, cantidad: 10, stock_minimo: 5 } }
    }), { productos: [[1, 7]] });
    const [warning] = stockLowWarnings(result);

    assert.equal(result.faltantes.length, 0);
    assert.equal(warning.id_producto, 1);
    assert.equal(warning.requerido, 7);
    assert.equal(warning.faltante, 0);
    assert.equal(warning.saldo_proyectado, 3);
    assert.equal(warning.stock_minimo, 5);
  });

  it('PRODUCTO: stock 3, venta 8 se reporta como warning de saldo proyectado -5', async () => {
    const result = await validate(makeStockClient({
      products: { 1: { id_producto: 1, cantidad: 3 } }
    }), { productos: [[1, 8]] });
    const [shortage] = stockShortages(result);

    assert.equal(shortage.id_producto, 1);
    assert.equal(shortage.requerido, 8);
    assert.equal(shortage.disponible, 3);
    assert.equal(shortage.faltante, 5);
    assert.equal(shortage.saldo_proyectado, -5);
    assert.equal(result.excludedResources.productoIds.size, 0);
  });

  it('PRODUCTO: stock 0, venta 99 se reporta como warning de saldo proyectado -99', async () => {
    const result = await validate(makeStockClient({
      products: { 1: { id_producto: 1, cantidad: 0 } }
    }), { productos: [[1, 99]] });
    const [shortage] = stockShortages(result);

    assert.equal(shortage.faltante, 99);
    assert.equal(shortage.saldo_proyectado, -99);
  });

  it('RECETA: ingredientes suficientes no generan faltantes', async () => {
    const result = await validate(makeStockClient({
      insumos: { 200: { id_insumo: 200, cantidad: 10 } }
    }), { insumos: [[200, 8]] });

    assert.equal(result.faltantes.length, 0);
  });

  it('RECETA: un ingrediente insuficiente queda como warning y no se excluye', async () => {
    const result = await validate(makeStockClient({
      insumos: { 200: { id_insumo: 200, cantidad: 3 } }
    }), { insumos: [[200, 8]] });
    const [shortage] = stockShortages(result);

    assert.equal(shortage.id_insumo, 200);
    assert.equal(shortage.saldo_proyectado, -5);
    assert.equal(result.excludedResources.insumoIds.size, 0);
  });

  it('RECETA: varios ingredientes insuficientes se reportan individualmente', async () => {
    const result = await validate(makeStockClient({
      insumos: {
        200: { id_insumo: 200, cantidad: 1 },
        201: { id_insumo: 201, cantidad: 2 }
      }
    }), { insumos: [[200, 8], [201, 99]] });
    const shortages = stockShortages(result);

    assert.equal(shortages.length, 2);
    assert.deepEqual(shortages.map((item) => item.saldo_proyectado), [-7, -97]);
  });

  it('RECETA: cantidades 1, 8, 99 y 999 multiplican consumo esperado', async () => {
    for (const cantidad of [1, 8, 99, 999]) {
      const consumoPorOrden = 2;
      const requerido = cantidad * consumoPorOrden;
      const result = await validate(makeStockClient({
        insumos: { 200: { id_insumo: 200, cantidad: 0 } }
      }), { insumos: [[200, requerido]] });
      const [shortage] = stockShortages(result);
      assert.equal(shortage.requerido, requerido);
      assert.equal(shortage.saldo_proyectado, -requerido);
    }
  });

  it('EXTRA: suficiente, insuficiente y stock 0 se separan de configuracion invalida', async () => {
    const sufficient = await validate(makeStockClient({
      insumos: { 300: { id_insumo: 300, nombre_insumo: 'Extra queso', cantidad: 5 } }
    }), { insumos: [[300, 3]] });
    assert.equal(sufficient.faltantes.length, 0);

    const insufficient = await validate(makeStockClient({
      insumos: { 300: { id_insumo: 300, nombre_insumo: 'Extra queso', cantidad: 1 } }
    }), { insumos: [[300, 3]] });
    assert.equal(stockShortages(insufficient)[0].saldo_proyectado, -2);

    const zero = await validate(makeStockClient({
      insumos: { 300: { id_insumo: 300, nombre_insumo: 'Extra queso', cantidad: 0 } }
    }), { insumos: [[300, 3]] });
    assert.equal(stockShortages(zero)[0].saldo_proyectado, -3);

    const invalidConfig = await validate(makeStockClient({ insumos: {} }), { insumos: [[300, 3]] });
    assert.equal(invalidConfig.faltantes[0].motivo, 'INSUMO_NO_ENCONTRADO');
    assert.equal(invalidConfig.excludedResources.insumoIds.has(300), true);
  });

  it('SALSA: suficiente, insuficiente, stock 0 y varias salsas sobre mismo insumo respetan consumo agregado', async () => {
    const expectedWarehouse = new Map([[400, 20]]);
    const sufficient = await validate(makeStockClient({
      insumos: { 400: { id_insumo: 400, nombre_insumo: 'Salsa Cajun', cantidad: 12, id_almacen: 20 } }
    }), { insumos: [[400, 12]], expectedInsumoWarehouseById: expectedWarehouse });
    assert.equal(sufficient.faltantes.length, 0);

    const insufficient = await validate(makeStockClient({
      insumos: { 400: { id_insumo: 400, nombre_insumo: 'Salsa Cajun', cantidad: 3, id_almacen: 20 } }
    }), { insumos: [[400, 12]], expectedInsumoWarehouseById: expectedWarehouse });
    assert.equal(stockShortages(insufficient)[0].saldo_proyectado, -9);

    const zero = await validate(makeStockClient({
      insumos: { 400: { id_insumo: 400, nombre_insumo: 'Salsa Cajun', cantidad: 0, id_almacen: 20 } }
    }), { insumos: [[400, 12]], expectedInsumoWarehouseById: expectedWarehouse });
    assert.equal(stockShortages(zero)[0].saldo_proyectado, -12);
  });

  it('SALSA: configuracion invalida sigue bloqueable por id_insumo o conversion/almacen invalido', async () => {
    const missing = await validate(makeStockClient({ insumos: {} }), { insumos: [[400, 1]] });
    assert.equal(missing.faltantes[0].motivo, 'INSUMO_NO_ENCONTRADO');
    assert.equal(missing.excludedResources.insumoIds.has(400), true);

    const wrongWarehouse = await validate(makeStockClient({
      insumos: { 400: { id_insumo: 400, nombre_insumo: 'Salsa Cajun', cantidad: 10, id_almacen: 20 } }
    }), { insumos: [[400, 1]], expectedInsumoWarehouseById: new Map([[400, 10]]) });
    assert.equal(wrongWarehouse.faltantes[0].motivo, 'SALSA_SNAPSHOT_ALMACEN_NO_COINCIDE');
  });

  it('COMBINACIONES: producto + receta + extra + salsa pueden quedar todos insuficientes al mismo tiempo', async () => {
    const result = await validate(makeStockClient({
      products: { 1: { id_producto: 1, cantidad: 0 } },
      insumos: {
        200: { id_insumo: 200, nombre_insumo: 'Receta pollo', cantidad: 0 },
        300: { id_insumo: 300, nombre_insumo: 'Extra queso', cantidad: 0 },
        400: { id_insumo: 400, nombre_insumo: 'Salsa Cajun', cantidad: 0 }
      }
    }), {
      productos: [[1, 8]],
      insumos: [[200, 8], [300, 8], [400, 8]]
    });

    assert.equal(stockShortages(result).length, 4);
    assert.equal(result.excludedResources.productoIds.size, 0);
    assert.equal(result.excludedResources.insumoIds.size, 0);
  });

  it('IDEMPOTENCIA: PEDIDO y FALTANTE_COCINA son equivalentes para la identidad fisica', () => {
    const expectedRows = [{
      id_detalle_pedido: 900,
      id_ref: 700,
      id_pedido_trazabilidad: 700,
      ref_origen: 'PEDIDO',
      origen_consumo: 'SALSA',
      id_almacen: 20,
      id_insumo: 400,
      cantidad: 16
    }];
    const existingRows = [{
      id_movimiento: 1,
      id_detalle_pedido: 900,
      id_ref: 700,
      id_pedido_trazabilidad: 700,
      ref_origen: 'FALTANTE_COCINA',
      origen_consumo: 'SALSA',
      id_almacen: 20,
      id_insumo: 400,
      cantidad: 16
    }];

    assert.equal(analyzePedidoMovementState({ expectedRows, existingRows }).state, 'COMPLETE');
  });

  it('MOVIMIENTOS: buildLineMovementRows mantiene ref_origen PEDIDO aunque haya shortage', () => {
    const rows = buildLineMovementRows({
      movementRows: [{
        tipo_recurso: 'insumo',
        id_detalle_pedido: 900,
        id_insumo: 400,
        cantidad: 16,
        origen_consumo: 'SALSA'
      }],
      productosById: new Map(),
      insumosById: new Map([[400, { id_insumo: 400, id_almacen: 20 }]]),
      actorUserId: 1,
      idPedido: 700,
      refOrigen: 'PEDIDO',
      shortagesByResource: new Map([['insumo:400', { requerido: 16, disponible: 1, faltante: 15 }]])
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].ref_origen, 'PEDIDO');
    assert.equal(rows[0].cantidad, 16);
  });

  it('SALSA ROUND-TRIP: snapshot persiste consumo total para cantidades 1, 8, 99 y 999', async () => {
    for (const cantidad of [1, 8, 99, 999]) {
      const line = {
        kind: 'RECETA',
        cantidad,
        complementos_detalle: [{ id_salsa: 40, id_complemento: 40, nombre: 'Cajun' }]
      };
      await attachSalsaInventorySnapshotsToLines({
        client: makeSalsaClient(),
        lines: [line],
        idSucursal: 6
      });

      const configuracion_menu = buildComplementLineConfig(line);
      const consumo = buildSalsaConsumptionItemsFromPedidoDetails([{
        id_detalle_pedido: 1000 + cantidad,
        configuracion_menu
      }]);

      assert.equal(consumo.errors.length, 0);
      assert.equal(consumo.items.length, 1);
      assert.equal(consumo.items[0].cantidad, cantidad * 2);
    }
  });

  it('SALSA SNAPSHOT LEGACY: reconstruye total si falta cantidad_base_total y no descarta salsas_por_unidad no vacio', () => {
    const consumo = buildSalsaConsumptionItemsFromPedidoDetails([{
      id_detalle_pedido: 901,
      configuracion_menu: {
        complementos: [],
        salsas_por_unidad: [{
          id_salsa: 40,
          nombre: 'Cajun',
          inventario: {
            id_insumo: 400,
            id_almacen: 20,
            id_unidad_base: 1,
            cantidad_base_por_porcion: 2,
            porciones_por_orden: 1,
            cantidad_linea: 8
          }
        }]
      }
    }]);

    assert.equal(consumo.errors.length, 0);
    assert.equal(consumo.items[0].cantidad, 16);
  });
});
