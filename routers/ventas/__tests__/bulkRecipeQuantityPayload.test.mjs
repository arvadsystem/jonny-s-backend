import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { validarYDescontarPedido } from '../../../services/inventarioPedidoService.js';
import {
  buildLineMovementRows,
  registrarMovimientosPedido
} from '../../../services/inventarioMovimientoService.js';
import { normalizePedidoPayload } from '../../../services/pedidoPayloadValidator.js';
import { resolvePedidoConsumo } from '../../../services/pedidoConsumoResolver.js';
import { buildSalsaConsumptionItemsFromPedidoDetails } from '../../../services/salsasPedidoSnapshotService.js';
import { buildSalsaInventorySnapshotsForReturn } from '../../../services/ventasReversionService.js';
import { buildPedidoMovementReturnRows } from '../../../services/ventasReversionService.js';
import {
  buildSalsaConsumptionSnapshot,
  restoreSalsasInventoryFromSnapshots
} from '../services/salsasInventoryService.js';
import {
  resolveRecetaComplementMetadata,
  validateComplementSelectionBounds
} from '../services/complementosCatalogService.js';
import {
  buildComplementLineConfig,
  normalizeVentaItems
} from '../services/ventasPayloadService.js';

const makeResolverClient = ({ recipeComponents = [{ id_receta: 12, id_insumo: 200, insumo_factor: '3' }] } = {}) => ({
  async query(sql, params = []) {
    const text = String(sql);
    if (text.includes('information_schema.columns')) {
      const column = params[1];
      return { rowCount: ['id_extra', 'cant'].includes(column) ? 1 : 0, rows: ['id_extra', 'cant'].includes(column) ? [{ column_name: column }] : [] };
    }
    if (text.includes('FROM public.recetas')) {
      return { rows: [{ id_receta: 12, nombre_receta: '12 alitas', estado: true }] };
    }
    if (text.includes('FROM public.menu_extras')) {
      return {
        rows: [{
          id_extra: 8,
          codigo: 'QUESO',
          nombre: 'Queso',
          estado: true,
          id_insumo: 300,
          insumo_factor: '0.5',
          id_unidad_medida: 1
        }]
      };
    }
    if (text.includes('FROM public.detalle_recetas')) {
      return { rows: recipeComponents };
    }
    return { rowCount: 0, rows: [] };
  }
});

const makeTransactionClient = ({ recipeComponents = [] } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      const text = String(sql);
      if (text.includes('FROM public.sucursales')) {
        return { rowCount: 1, rows: [{ id_sucursal: 1, nombre_sucursal: 'Sucursal 1', estado: true }] };
      }
      if (text.includes('FROM public.movimientos_inventario') && text.includes('LIMIT 1')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('information_schema.columns')) {
        const column = params[1];
        return { rowCount: column === 'cant' ? 1 : 0, rows: column === 'cant' ? [{ column_name: column }] : [] };
      }
      if (text.includes('FROM public.recetas')) {
        return { rowCount: 1, rows: [{ id_receta: 12, nombre_receta: '12 alitas', estado: true }] };
      }
      if (text.includes('FROM public.menu_extras')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('FROM public.detalle_recetas')) {
        return { rows: recipeComponents };
      }
      return { rowCount: 0, rows: [] };
    }
  };
};

describe('ventas bulk recipe quantity payload', () => {
  it('normaliza cantidades validas 1..999 para venta de caja', () => {
    for (const cantidad of [1, 9, 10, 99, 998, 999]) {
      const result = normalizeVentaItems([{ id_receta: 12, cantidad }]);
      assert.equal(result.ok, true);
      assert.equal(result.data[0].cantidad, cantidad);
    }
  });

  it('rechaza 0, negativos, decimales, texto y cantidades mayores a 999', () => {
    for (const cantidad of [0, -1, -10, 1.5, '2.5', 'abc', '10a', '', ' ', 1000, 1234]) {
      const result = normalizeVentaItems([{ id_receta: 12, cantidad }]);
      assert.equal(result.ok, false, `debe rechazar ${JSON.stringify(cantidad)}`);
    }
  });

  it('normaliza payload de inventario con cantidad positiva y rechaza cantidad invalida', () => {
    const ok = normalizePedidoPayload({
      id_sucursal: 1,
      id_pedido: 10,
      items: [{ tipo_item: 'RECETA', id_receta: 12, cantidad: 99 }]
    });
    const invalid = normalizePedidoPayload({
      id_sucursal: 1,
      id_pedido: 10,
      items: [{ tipo_item: 'RECETA', id_receta: 12, cantidad: 0 }]
    });

    assert.equal(ok.ok, true);
    assert.equal(ok.value.items[0].cantidad, 99);
    assert.equal(invalid.ok, false);
  });

  it('incluye cantidad por orden y total en configuracion_menu', () => {
    const config = buildComplementLineConfig({
      complementos_metadata: { requiere_complementos: true, minimo_complementos: 2, maximo_complementos: 2 },
      complementos_detalle: [{ id_complemento: 5, id_salsa: 5, nombre: 'Barbecue' }],
      extras_detalle: [{
        id_extra: 8,
        codigo: 'QUESO',
        nombre: 'Queso',
        cantidad: 99,
        cantidad_por_orden: 1,
        cantidad_total: 99,
        precio_unitario: 10,
        subtotal: 990,
        id_insumo: 300,
        cant: 0.5,
        id_unidad_medida: 1
      }]
    });

    assert.equal(config.extras[0].cantidad, 99);
    assert.equal(config.extras[0].cantidad_por_orden, 1);
    assert.equal(config.extras[0].cantidad_total, 99);
    assert.equal(config.extras[0].subtotal, 990);
    assert.equal(config.minimo_complementos, 2);
    assert.equal(config.maximo_complementos, 2);
  });

  it('calcula snapshot de salsa por orden y consumo fisico por cantidad de linea', () => {
    const snapshot = buildSalsaConsumptionSnapshot({
      id_salsa: 5,
      id_complemento: 5,
      nombre: 'Barbecue',
      id_insumo_configurado: 400,
      id_almacen: 3,
      id_unidad_base: 1,
      cantidad_consumo_configurada: 1,
      cantidad_consumo_base: 0.25,
      usa_catalogo_maestro: false
    }, 2, 99);

    assert.equal(snapshot.porciones_por_orden, 2);
    assert.equal(snapshot.cantidad_linea, 99);
    assert.equal(snapshot.porciones_total, 198);
    assert.equal(snapshot.cantidad_base_por_porcion, 0.25);
    assert.equal(snapshot.cantidad_base_total, 49.5);
  });

  it('calcula reglas de salsas por orden aunque la linea tenga cantidad masiva', () => {
    const metadata = resolveRecetaComplementMetadata({
      receta: { nombre_receta: '12 ALITAS', descripcion: 'Orden de 12 alitas' },
      quantity: 99,
      rules: [
        { min_unidades: 1, max_unidades: 6, salsas_requeridas: 1 },
        { min_unidades: 7, max_unidades: 12, salsas_requeridas: 2 }
      ],
      allowedSauces: [
        { id_complemento: 5, id_salsa: 5, nombre: 'Barbecue', disponible: true },
        { id_complemento: 6, id_salsa: 6, nombre: 'Buffalo', disponible: true }
      ]
    });

    assert.equal(metadata.minimo_complementos, 2);
    assert.equal(metadata.maximo_complementos, 2);
  });

  it('bloquea complementos incompletos salvo autorizacion explicita', () => {
    const blocked = validateComplementSelectionBounds({
      selectedCount: 1,
      minimo: 2,
      maximo: 2,
      allowIncomplete: false,
      nombreItem: '12 ALITAS'
    });
    const authorized = validateComplementSelectionBounds({
      selectedCount: 1,
      minimo: 2,
      maximo: 2,
      allowIncomplete: true,
      nombreItem: '12 ALITAS'
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'VENTAS_COMPLEMENTOS_INCOMPLETOS');
    assert.equal(authorized.ok, true);
  });

  it('resuelve extras, ingredientes y salsas multiplicados por cantidad de linea', async () => {
    const result = await resolvePedidoConsumo({
      client: makeResolverClient(),
      items: [
        { tipo_item: 'RECETA', id_item: 12, id_receta: 12, id_detalle_pedido: 701, cantidad: 99 },
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, id_detalle_pedido: 702, cantidad: 99 },
        { tipo_item: 'SALSA', id_item: 5, id_salsa: 5, id_insumo: 400, id_almacen: 3, id_detalle_pedido: 703, cantidad: 49.5 }
      ]
    });

    assert.deepEqual(result.faltantes, []);
    assert.equal(result.consumo.recetaQtyMap.get(12), 99);
    assert.equal(result.consumo.extraQtyMap.get(8), 99);
    assert.equal(result.consumo.insumoQtyMap.get(200), 297);
    assert.equal(result.consumo.insumoQtyMap.get(300), 49.5);
    assert.equal(result.consumo.insumoQtyMap.get(400), 49.5);
    assert.deepEqual(
      result.consumo.movimientoRows.map((row) => ({
        detalle: row.id_detalle_pedido,
        origen: row.origen_consumo,
        insumo: row.id_insumo,
        cantidad: row.cantidad
      })),
      [
        { detalle: 703, origen: 'SALSA', insumo: 400, cantidad: 49.5 },
        { detalle: 702, origen: 'EXTRA', insumo: 300, cantidad: 49.5 },
        { detalle: 701, origen: 'RECETA', insumo: 200, cantidad: 297 }
      ]
    );
  });

  it('construye movimientos trazados por linea sin agregar recursos compartidos', () => {
    const rows = buildLineMovementRows({
      idPedido: 9001,
      actorUserId: 4,
      movementRows: [
        { tipo_recurso: 'producto', id_producto: 10, id_detalle_pedido: 801, cantidad: 1, origen_consumo: 'PRODUCTO' },
        { tipo_recurso: 'producto', id_producto: 10, id_detalle_pedido: 802, cantidad: 2, origen_consumo: 'PRODUCTO' },
        { tipo_recurso: 'insumo', id_insumo: 20, id_detalle_pedido: 803, cantidad: 3, origen_consumo: 'RECETA' },
        { tipo_recurso: 'insumo', id_insumo: 20, id_detalle_pedido: 804, cantidad: 4, origen_consumo: 'EXTRA' }
      ],
      productosById: new Map([[10, { id_producto: 10, id_almacen: 5 }]]),
      insumosById: new Map([[20, { id_insumo: 20, id_almacen: 6 }]])
    });

    assert.deepEqual(
      rows.map((row) => ({
        id_ref: row.id_ref,
        id_pedido_trazabilidad: row.id_pedido_trazabilidad,
        id_detalle_pedido: row.id_detalle_pedido,
        origen_consumo: row.origen_consumo,
        id_almacen: row.id_almacen,
        id_producto: row.id_producto,
        id_insumo: row.id_insumo,
        cantidad: row.cantidad
      })),
      [
        { id_ref: 9001, id_pedido_trazabilidad: 9001, id_detalle_pedido: 801, origen_consumo: 'PRODUCTO', id_almacen: 5, id_producto: 10, id_insumo: null, cantidad: 1 },
        { id_ref: 9001, id_pedido_trazabilidad: 9001, id_detalle_pedido: 802, origen_consumo: 'PRODUCTO', id_almacen: 5, id_producto: 10, id_insumo: null, cantidad: 2 },
        { id_ref: 9001, id_pedido_trazabilidad: 9001, id_detalle_pedido: 803, origen_consumo: 'RECETA', id_almacen: 6, id_producto: null, id_insumo: 20, cantidad: 3 },
        { id_ref: 9001, id_pedido_trazabilidad: 9001, id_detalle_pedido: 804, origen_consumo: 'EXTRA', id_almacen: 6, id_producto: null, id_insumo: 20, cantidad: 4 }
      ]
    );
  });

  it('inserta movimientos de inventario en una sola sentencia batch', async () => {
    const inserts = [];
    const client = {
      async query(sql, params = []) {
        if (String(sql).includes('INSERT INTO public.movimientos_inventario')) {
          inserts.push({ sql: String(sql), params });
        }
        return { rows: [], rowCount: 2 };
      }
    };

    const count = await registrarMovimientosPedido({
      client,
      idPedido: 9100,
      actorUserId: 4,
      productoQtyMap: new Map(),
      insumoQtyMap: new Map([[20, 7]]),
      productosById: new Map(),
      insumosById: new Map([[20, { id_insumo: 20, id_almacen: 6 }]]),
      movementRows: [
        { tipo_recurso: 'insumo', id_insumo: 20, id_detalle_pedido: 811, cantidad: 3, origen_consumo: 'RECETA' },
        { tipo_recurso: 'insumo', id_insumo: 20, id_detalle_pedido: 812, cantidad: 4, origen_consumo: 'RECETA' }
      ]
    });

    assert.equal(count, 2);
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].sql, /VALUES\s+\('SALIDA', \$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10\), \('SALIDA', \$11,/);
    assert.equal(inserts[0].params[4], 811);
    assert.equal(inserts[0].params[5], 'RECETA');
    assert.equal(inserts[0].params[7], 9100);
    assert.equal(inserts[0].params[8], 9100);
    assert.equal(inserts[0].params[14], 812);
  });

  it('propaga error de lote para que la venta haga rollback transaccional', async () => {
    let insertAttempts = 0;
    const client = {
      async query(sql) {
        if (String(sql).includes('INSERT INTO public.movimientos_inventario')) {
          insertAttempts += 1;
          const error = new Error('batch failed');
          error.code = '23514';
          throw error;
        }
        return { rows: [], rowCount: 0 };
      }
    };

    await assert.rejects(
      () => registrarMovimientosPedido({
        client,
        idPedido: 9101,
        productoQtyMap: new Map(),
        insumoQtyMap: new Map([[20, 3]]),
        productosById: new Map(),
        insumosById: new Map([[20, { id_insumo: 20, id_almacen: 6 }]]),
        movementRows: [
          { tipo_recurso: 'insumo', id_insumo: 20, id_detalle_pedido: 811, cantidad: 3, origen_consumo: 'RECETA' }
        ]
      }),
      /batch failed/
    );
    assert.equal(insertAttempts, 1);
  });

  it('extrae consumo total desde configuracion_menu sin reconstruir por una sola orden', () => {
    const snapshot = {
      id_salsa: 5,
      id_insumo: 400,
      id_almacen: 3,
      id_unidad_base: 1,
      nombre: 'Barbecue',
      cantidad_base_por_porcion: 0.25,
      porciones_por_orden: 2,
      cantidad_linea: 99,
      porciones_total: 198,
      cantidad_base_total: 49.5
    };
    const result = buildSalsaConsumptionItemsFromPedidoDetails([
      {
        id_detalle_pedido: 777,
        configuracion_menu: {
          componentes: {
            seleccion: [{ id_salsa: 5, nombre: 'Barbecue', inventario: snapshot }]
          }
        }
      }
    ]);

    assert.equal(result.errors.length, 0);
    assert.equal(result.items[0].cantidad, 49.5);
    assert.equal(result.items[0].snapshot.porciones_total, 198);
  });

  it('revierte exactamente el total persistido proporcional a la cantidad revertida', () => {
    const snapshots = buildSalsaInventorySnapshotsForReturn([
      {
        cantidad_revertida: 99,
        origen_snapshot: {
          cantidad: 99,
          componentes: {
            seleccion: [{
              id_salsa: 5,
              inventario: {
                id_salsa: 5,
                id_insumo: 400,
                id_almacen: 3,
                cantidad_base_total: 49.5,
                porciones: 2,
                porciones_total: 198,
                cantidad_linea: 99
              }
            }]
          }
        }
      }
    ]);

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].cantidad_base_total, 49.5);
  });

  it('registra entrada de reversion por la misma cantidad total del snapshot', async () => {
    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql: String(sql), params });
        if (String(sql).includes('FROM public.insumos_almacenes')) {
          return { rowCount: 1, rows: [{ cantidad: 802 }] };
        }
        return { rowCount: 1, rows: [] };
      }
    };

    await restoreSalsasInventoryFromSnapshots({
      client,
      snapshots: [{ id_insumo: 400, id_almacen: 3, cantidad_base_total: 198, nombre: 'Barbecue' }],
      idReversion: 55,
      codigoReversion: 'REV-55',
      codigoVenta: 'VTA-10'
    });

    const insert = queries.find((entry) => entry.sql.includes("VALUES ('ENTRADA'"));
    assert.ok(insert);
    assert.equal(insert.params[0], 198);
  });

  it('construye devoluciones proporcionales desde movimientos originales del pedido', () => {
    const rows = buildPedidoMovementReturnRows({
      movements: [
        { cantidad: 198, id_almacen: 1, id_producto: 10, id_insumo: null },
        { cantidad: 49.5, id_almacen: 2, id_producto: null, id_insumo: 400 }
      ],
      lineas: [
        { cantidad_vendida: 99, cantidad_revertida: 33 }
      ]
    });

    assert.equal(rows.length, 2);
    assert.equal(rows[0].cantidad, 66);
    assert.equal(rows[1].cantidad, 16.5);
  });

  it('bloquea venta transaccional por receta sin componentes sin crear registros parciales', async () => {
    const client = makeTransactionClient({ recipeComponents: [] });
    const result = await validarYDescontarPedido({
      id_sucursal: 1,
      id_pedido: 10,
      items: [{ tipo_item: 'RECETA', id_receta: 12, cantidad: 99 }]
    }, { dbClient: client });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONFIGURACION_INVENTARIO_INVALIDA');
    assert.equal(client.queries.some((entry) => /\bINSERT\b/i.test(entry.sql)), false);
  });

  it('mantiene detalle_pedido.cantidad como fuente primaria en facturacion de pendientes', async () => {
    const ventasSource = await readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

    assert.match(ventasSource, /dp\.cantidad/);
    assert.match(ventasSource, /const cantidadPersistida = Number\(row\.cantidad \?\? 0\);/);
    assert.match(ventasSource, /: inferKitchenItemQuantity\(subTotal, precioBase\);/);
  });

  it('incluye observacion de item en el PDF de ticket', async () => {
    const source = await readFile(new URL('../services/ventaTicketPdfService.js', import.meta.url), 'utf8');

    assert.match(source, /Nota: \$\{observacion\}/);
    assert.match(source, /String\(item\.observacion \|\| ''\)\.trim\(\)/);
  });
});
