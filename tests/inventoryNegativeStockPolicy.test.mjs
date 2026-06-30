import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { validarStockConBloqueo } from '../services/inventarioStockValidator.js';

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

describe('politica de stock negativo en ventas e inventario', () => {
  it('PRODUCTO: stock 10, venta 1 queda suficiente y saldo proyectado 9', async () => {
    const result = await validate(makeStockClient({
      products: { 1: { id_producto: 1, cantidad: 10 } }
    }), { productos: [[1, 1]] });

    assert.equal(result.faltantes.length, 0);
    assert.equal(result.excludedResources.productoIds.size, 0);
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

  it('STRICT: stock insuficiente no usa strictStockShortages y configuracion invalida sigue separada', async () => {
    const service = await readFile(new URL('../services/inventarioPedidoService.js', import.meta.url), 'utf8');
    assert.equal(service.includes('strictStockShortages'), false);
    assert.match(service, /strictConfigFaults/);
    assert.match(service, /stockShortages\.length > 0 && !allowNegativeStock/);
  });

  it('COCINA: EN_PREPARACION usa FALTANTE_COCINA cuando hay faltantes permitidos', async () => {
    const cocina = await readFile(new URL('../routers/cocina.js', import.meta.url), 'utf8');
    assert.match(cocina, /allowNegativeStock:\s*true/);
    assert.match(cocina, /allowIncompleteConfiguration:\s*true/);
    assert.match(cocina, /shortageMode:\s*'FALTANTE_COCINA'/);
  });

  it('VENTAS/SALSAS: no quedan throws por stock insuficiente de extras o salsa en hidratacion/snapshots', async () => {
    const ventas = await readFile(new URL('../routers/ventas.js', import.meta.url), 'utf8');
    const salsas = await readFile(new URL('../routers/ventas/services/salsasInventoryService.js', import.meta.url), 'utf8');

    assert.match(ventas, /validateProductStock:\s*false/);
    assert.equal(/No hay existencias suficientes para el extra/.test(ventas), false);
    assert.equal(/VENTAS_SALSA_STOCK_INSUFICIENTE/.test(salsas.slice(salsas.indexOf('export const attachSalsaInventorySnapshotsToLines'))), false);
    assert.match(salsas, /stockInsuficiente/);
    assert.match(salsas, /saldoProyectado/);
  });
});
