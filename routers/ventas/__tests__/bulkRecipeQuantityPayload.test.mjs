import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { validarYDescontarPedido } from '../../../services/inventarioPedidoService.js';
import {
  normalizeItemType,
  normalizePedidoPayload,
  parseStrictPositiveQuantity
} from '../../../services/pedidoPayloadValidator.js';
import { resolvePedidoConsumo } from '../../../services/pedidoConsumoResolver.js';
import { buildSalsaConsumptionItemsFromPedidoDetails } from '../../../services/salsasPedidoSnapshotService.js';
import { buildSalsaInventorySnapshotsForReturn, roundInventoryQuantity } from '../../../services/ventasReversionService.js';
import {
  buildPedidoMovementReturnRows,
  classifyPedidoMovementReturnState
} from '../../../services/ventasReversionService.js';
import {
  analyzePedidoMovementState,
  buildLineMovementRows,
  normalizeOrigenConsumo,
  registrarMovimientosPedido
} from '../../../services/inventarioMovimientoService.js';
import {
  parseComplementosPayload,
  coercePositiveIntArray,
  parseEntityIdentifier
} from '../utils/parseUtils.js';
import { buildVentaKitchenPrintPayload } from '../handlers/ventasPrintHandlers.js';
import { buildVentaTicketPdfDefinition } from '../services/ventaTicketPdfService.js';
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

const makeResolverClient = ({
  recipeComponents = [{ id_receta: 12, id_insumo: 200, insumo_factor: '3' }],
  recetasRows = [{ id_receta: 12, nombre_receta: '12 alitas', estado: true }],
  extrasRows = [{
    id_extra: 8,
    codigo: 'QUESO',
    nombre: 'Queso',
    estado: true,
    id_insumo: 300,
    insumo_factor: '0.5',
    id_unidad_medida: 1
  }]
} = {}) => ({
  async query(sql, params = []) {
    const text = String(sql);
    if (text.includes('information_schema.columns')) {
      const column = params[1];
      return { rowCount: ['id_extra', 'cant'].includes(column) ? 1 : 0, rows: ['id_extra', 'cant'].includes(column) ? [{ column_name: column }] : [] };
    }
    if (text.includes('FROM public.recetas')) {
      return { rows: recetasRows };
    }
    if (text.includes('FROM public.menu_extras')) {
      return { rows: extrasRows };
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
      if (text.includes('FROM public.pedidos')) {
        return { rowCount: 1, rows: [{ id_pedido: 10, id_sucursal: 1, id_estado_pedido: 1 }] };
      }
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

  it('rechaza cantidades de inventario no escalares o comerciales invalidas', () => {
    for (const cantidad of [true, false, [], [1], ['2'], {}, new Number(2), NaN, Infinity, -Infinity, '2abc', '1.5x', '', ' ', 0, -1, 1.5, '1.5', 1000]) {
      assert.equal(
        parseStrictPositiveQuantity(cantidad, { integer: true, max: 999 }),
        null,
        `debe rechazar ${JSON.stringify(cantidad)}`
      );
    }
  });

  it('valida cantidades fisicas con maximo seis decimales', () => {
    for (const cantidad of ['0.000001', '0.123456', '1.333333', '999999.999999']) {
      assert.equal(parseStrictPositiveQuantity(cantidad, { maxDecimals: 6 }), Number(cantidad));
    }
    assert.equal(parseStrictPositiveQuantity('0.1234567', { maxDecimals: 6 }), null);
  });

  it('normalizeItemType solo acepta strings', () => {
    assert.equal(normalizeItemType('RECETA'), 'RECETA');
    for (const tipo of [['RECETA'], { toString: () => 'RECETA' }, true, 1]) {
      assert.equal(normalizeItemType(tipo), null);
    }
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

  it('devuelve error cuando hay reglas formales de salsa sin rango aplicable', () => {
    const metadata = resolveRecetaComplementMetadata({
      receta: { nombre_receta: '18 ALITAS', descripcion: 'Orden de 18 alitas' },
      quantity: 99,
      rules: [
        { min_unidades: 1, max_unidades: 6, salsas_requeridas: 1 },
        { min_unidades: 7, max_unidades: 12, salsas_requeridas: 2 }
      ],
      allowedSauces: []
    });

    assert.equal(metadata.ok, false);
    assert.equal(metadata.code, 'VENTAS_REGLA_SALSA_NO_CONFIGURADA');
    assert.match(metadata.message, /18 ALITAS/);
  });

  it('detecta reglas de salsa traslapadas', () => {
    const metadata = resolveRecetaComplementMetadata({
      receta: { nombre_receta: '12 ALITAS', descripcion: 'Orden de 12 alitas' },
      rules: [
        { min_unidades: 1, max_unidades: 8, salsas_requeridas: 1 },
        { min_unidades: 7, max_unidades: 12, salsas_requeridas: 2 }
      ]
    });

    assert.equal(metadata.ok, false);
    assert.equal(metadata.code, 'VENTAS_REGLA_SALSA_AMBIGUA');
  });

  it('resuelve extras, ingredientes y salsas multiplicados por cantidad de linea', async () => {
    const result = await resolvePedidoConsumo({
      client: makeResolverClient(),
      items: [
        { tipo_item: 'RECETA', id_item: 12, id_receta: 12, cantidad: 99 },
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, cantidad: 99 },
        { tipo_item: 'SALSA', id_item: 5, id_salsa: 5, id_insumo: 400, id_almacen: 3, cantidad: 49.5 }
      ]
    });

    assert.deepEqual(result.faltantes, []);
    assert.equal(result.consumo.recetaQtyMap.get(12), 99);
    assert.equal(result.consumo.extraQtyMap.get(8), 99);
    assert.equal(result.consumo.insumoQtyMap.get(200), 297);
    assert.equal(result.consumo.insumoQtyMap.get(300), 49.5);
    assert.equal(result.consumo.insumoQtyMap.get(400), 49.5);
    assert.equal(result.consumo.movimientoRows.some((row) => row.id_detalle_pedido), false);
  });

  it('construye consumos por linea para receta, extra y salsa', async () => {
    const result = await resolvePedidoConsumo({
      client: makeResolverClient(),
      items: [
        { tipo_item: 'RECETA', id_item: 12, id_receta: 12, id_detalle_pedido: 700, cantidad: 99 },
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, id_detalle_pedido: 700, cantidad: 99 },
        { tipo_item: 'SALSA', id_item: 5, id_salsa: 5, id_detalle_pedido: 700, id_insumo: 400, id_almacen: 3, cantidad: 49.5 }
      ]
    });

    assert.deepEqual(result.faltantes, []);
    assert.deepEqual(
      result.consumo.movimientoRows.map((row) => [row.id_detalle_pedido, row.origen_consumo, row.id_insumo, row.cantidad]),
      [
        [700, 'SALSA', 400, 49.5],
        [700, 'EXTRA', 300, 49.5],
        [700, 'RECETA', 200, 297]
      ]
    );
  });

  it('conserva extras repetidos por linea sin asignar todo al primer contexto', async () => {
    const result = await resolvePedidoConsumo({
      client: makeResolverClient(),
      items: [
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, id_detalle_pedido: 700, cantidad: 1 },
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, id_detalle_pedido: 701, cantidad: 2 }
      ]
    });

    assert.deepEqual(result.faltantes, []);
    assert.equal(result.consumo.insumoQtyMap.get(300), 1.5);
    assert.deepEqual(
      result.consumo.movimientoRows.map((row) => [row.id_detalle_pedido, row.origen_consumo, row.id_insumo, row.cantidad]),
      [
        [700, 'EXTRA', 300, 0.5],
        [701, 'EXTRA', 300, 1]
      ]
    );
  });

  it('resuelve extras mixtos con snapshot por linea y catalogo por linea', async () => {
    const result = await resolvePedidoConsumo({
      client: makeResolverClient({
        extrasRows: [{
          id_extra: 8,
          codigo: 'QUESO',
          nombre: 'Queso',
          estado: true,
          id_insumo: 300,
          insumo_factor: '0.75',
          id_unidad_medida: 1
        }]
      }),
      items: [
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, id_detalle_pedido: 700, id_insumo: 300, cant: 0.5, cantidad: 1 },
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, id_detalle_pedido: 701, cantidad: 2 }
      ]
    });

    assert.deepEqual(result.faltantes, []);
    assert.equal(result.consumo.insumoQtyMap.get(300), 2);
    assert.deepEqual(
      result.consumo.movimientoRows.map((row) => [row.id_detalle_pedido, row.origen_consumo, row.id_insumo, row.cantidad]),
      [
        [700, 'EXTRA', 300, 0.5],
        [701, 'EXTRA', 300, 1.5]
      ]
    );
  });

  it('bloquea snapshot parcial de extra sin generar movimiento de fallback', async () => {
    const result = await resolvePedidoConsumo({
      client: makeResolverClient(),
      items: [
        { tipo_item: 'EXTRA', id_item: 8, id_extra: 8, id_detalle_pedido: 700, id_insumo: 300, cantidad: 2 }
      ]
    });

    assert.equal(result.faltantes[0].motivo, 'EXTRA_SNAPSHOT_INVENTARIO_INVALIDO');
    assert.equal(result.consumo.insumoQtyMap.has(300), false);
    assert.equal(result.consumo.movimientoRows.length, 0);
  });

  it('no expande recetas inactivas ni componentes invalidos aun con faltantes permitidos', async () => {
    const inactive = await resolvePedidoConsumo({
      client: makeResolverClient({
        recetasRows: [{ id_receta: 12, nombre_receta: '12 alitas', estado: false }]
      }),
      items: [{ tipo_item: 'RECETA', id_item: 12, id_receta: 12, id_detalle_pedido: 700, cantidad: 2 }]
    });
    const invalidComponents = await resolvePedidoConsumo({
      client: makeResolverClient({
        recipeComponents: [{ id_receta: 12, id_insumo: null, insumo_factor: '3' }]
      }),
      items: [{ tipo_item: 'RECETA', id_item: 12, id_receta: 12, id_detalle_pedido: 700, cantidad: 2 }]
    });

    assert.equal(inactive.faltantes[0].motivo, 'RECETA_INACTIVA');
    assert.equal(inactive.consumo.insumoQtyMap.size, 0);
    assert.equal(inactive.consumo.movimientoRows.length, 0);
    assert.equal(invalidComponents.faltantes[0].motivo, 'RECETA_CON_COMPONENTES_INVALIDOS');
    assert.equal(invalidComponents.consumo.insumoQtyMap.size, 0);
    assert.equal(invalidComponents.consumo.movimientoRows.length, 0);
  });

  it('exige trazabilidad completa por linea para consumos fisicos descontables', () => {
    assert.throws(() => buildLineMovementRows({
      movementRows: [{ tipo_recurso: 'insumo', id_insumo: 200, cantidad: 1, origen_consumo: 'RECETA' }],
      productosById: new Map(),
      insumosById: new Map([[200, { id_insumo: 200, id_almacen: 1 }]]),
      idPedido: 10,
      shortagesByResource: new Map()
    }), (error) => error.code === 'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA');
  });

  it('filtra recursos excluidos antes de construir filas trazadas', () => {
    const rows = buildLineMovementRows({
      movementRows: [
        { tipo_recurso: 'insumo', id_insumo: 200, id_detalle_pedido: 700, cantidad: 1, origen_consumo: 'RECETA' },
        { tipo_recurso: 'insumo', id_insumo: 201, id_detalle_pedido: 701, cantidad: 2, origen_consumo: 'EXTRA' }
      ],
      productosById: new Map(),
      insumosById: new Map([
        [200, { id_insumo: 200, id_almacen: 1 }],
        [201, { id_insumo: 201, id_almacen: 1 }]
      ]),
      idPedido: 10,
      excludedInsumoIds: new Set([201]),
      shortagesByResource: new Map()
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id_insumo, 200);
    assert.equal(rows[0].id_ref, 10);
  });

  it('registrarMovimientosPedido inserta salidas trazadas con id_ref completo y retorna conteo real', async () => {
    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql: String(sql), params });
        return { rowCount: 1, rows: [] };
      }
    };

    const count = await registrarMovimientosPedido({
      client,
      idPedido: 55,
      actorUserId: 9,
      productoQtyMap: new Map(),
      insumoQtyMap: new Map(),
      productosById: new Map(),
      insumosById: new Map([[200, { id_insumo: 200, id_almacen: 3 }]]),
      movementRows: [{ tipo_recurso: 'insumo', id_insumo: 200, id_detalle_pedido: 700, cantidad: 1.25, origen_consumo: 'RECETA' }],
      shortagesByResource: new Map()
    });

    const insert = queries.find((entry) => entry.sql.includes('INSERT INTO public.movimientos_inventario'));
    assert.equal(count, 1);
    assert.ok(insert);
    assert.deepEqual(insert.params.slice(0, 8), [1.25, 3, null, 200, 700, 'RECETA', 'PEDIDO', 55]);
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
        { cantidad: 198, id_almacen: 1, id_producto: 10, id_insumo: null, id_detalle_pedido: 700, origen_consumo: 'PRODUCTO' },
        { cantidad: 49.5, id_almacen: 2, id_producto: null, id_insumo: 400, id_detalle_pedido: 701, origen_consumo: 'RECETA' }
      ],
      lineas: [
        { id_detalle_pedido: 701, cantidad_vendida: 99, cantidad_revertida: 33 }
      ]
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].cantidad, 16.5);
    assert.equal(rows[0].id_detalle_pedido, 701);
    assert.equal(rows[0].id_movimiento_origen, null);
  });

  it('calcula devoluciones disponibles por movimiento origen', () => {
    const rows = buildPedidoMovementReturnRows({
      movements: [
        { id_movimiento: 901, cantidad: 99, id_almacen: 2, id_producto: null, id_insumo: 400, id_detalle_pedido: 701, origen_consumo: 'RECETA' }
      ],
      lineas: [
        { id_detalle_pedido: 701, cantidad_vendida: 99, cantidad_revertida: 30 }
      ],
      returnedByOrigin: new Map([[901, 20]])
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id_movimiento_origen, 901);
    assert.equal(rows[0].cantidad, 30);
    assert.equal(rows[0].cantidad_disponible, 79);
  });

  it('devuelve exactamente el remanente fisico al completar la linea', () => {
    const movements = [
      { id_movimiento: 901, cantidad: 0.0025, id_almacen: 2, id_producto: null, id_insumo: 400, id_detalle_pedido: 701, origen_consumo: 'RECETA' }
    ];
    const first = buildPedidoMovementReturnRows({
      movements,
      lineas: [{ id_detalle_pedido: 701, cantidad_vendida: 99, cantidad_revertida: 33 }],
      returnedByOrigin: new Map()
    });
    const second = buildPedidoMovementReturnRows({
      movements,
      lineas: [{ id_detalle_pedido: 701, cantidad_vendida: 99, cantidad_revertida: 33 }],
      returnedByOrigin: new Map([[901, first[0].cantidad]])
    });
    const third = buildPedidoMovementReturnRows({
      movements,
      lineas: [{
        id_detalle_pedido: 701,
        cantidad_vendida: 99,
        cantidad_revertida: 33,
        cantidad_pendiente_antes: 33,
        completa_linea: true
      }],
      returnedByOrigin: new Map([[901, first[0].cantidad + second[0].cantidad]])
    });

    assert.equal(roundInventoryQuantity(first[0].cantidad + second[0].cantidad + third[0].cantidad), 0.0025);
  });

  it('clasifica estados de reversion de movimientos originales', () => {
    const traced = [{
      id_movimiento: 1,
      cantidad: 1,
      id_almacen: 1,
      id_producto: null,
      id_insumo: 2,
      id_detalle_pedido: 700,
      origen_consumo: 'RECETA',
      ref_origen: 'PEDIDO',
      tipo: 'SALIDA'
    }];

    assert.equal(classifyPedidoMovementReturnState({ movements: [], lineas: [] }), 'NO_ORIGINAL_MOVEMENTS');
    assert.equal(classifyPedidoMovementReturnState({
      movements: traced,
      lineas: [{ id_detalle_pedido: 700 }],
      returnedByOrigin: new Map([[1, 1]])
    }), 'ALREADY_FULLY_RETURNED');
    assert.equal(classifyPedidoMovementReturnState({
      movements: traced,
      lineas: [{ id_detalle_pedido: 700 }],
      returnedByOrigin: new Map([[1, 1.000001]])
    }), 'TRACE_INCONSISTENT');
    assert.equal(classifyPedidoMovementReturnState({
      movements: [{ ...traced[0], id_movimiento: null }],
      lineas: [{ id_detalle_pedido: 700 }]
    }), 'TRACE_INCONSISTENT');
    assert.equal(classifyPedidoMovementReturnState({
      movements: [{ ...traced[0], id_detalle_pedido: 999 }],
      lineas: [{ id_detalle_pedido: 700 }]
    }), 'TRACE_INCONSISTENT');
    assert.equal(classifyPedidoMovementReturnState({
      movements: [{ ...traced[0], id_detalle_pedido: null }],
      lineas: [{ id_detalle_pedido: 700 }],
      tipoReversion: 'PARCIAL'
    }), 'LEGACY_PARTIAL_BLOCKED');
    assert.equal(classifyPedidoMovementReturnState({
      movements: [{ ...traced[0], id_detalle_pedido: null }],
      lineas: [{ id_detalle_pedido: 700 }],
      tipoReversion: 'TOTAL'
    }), 'LEGACY_TOTAL_ALLOWED');
  });

  it('detecta pedido ya descontado completo y pedido parcial inconsistente', () => {
    const expectedRows = [
      { id_detalle_pedido: 700, ref_origen: 'PEDIDO', origen_consumo: 'RECETA', id_almacen: 1, id_producto: null, id_insumo: 200, cantidad: 297 },
      { id_detalle_pedido: 701, ref_origen: 'PEDIDO', origen_consumo: 'PRODUCTO', id_almacen: 1, id_producto: 10, id_insumo: null, cantidad: 1 }
    ];
    const complete = analyzePedidoMovementState({
      expectedRows,
      existingRows: expectedRows.map((row, index) => ({ ...row, id_movimiento: index + 1 }))
    });
    const partial = analyzePedidoMovementState({
      expectedRows,
      existingRows: [{ ...expectedRows[0], id_movimiento: 1 }]
    });

    assert.equal(complete.state, 'COMPLETE');
    assert.equal(partial.state, 'PARTIAL');
    assert.equal(partial.missing.length, 1);
  });

  it('normaliza origen_consumo y rechaza valores no permitidos', () => {
    assert.equal(normalizeOrigenConsumo(' receta '), 'RECETA');
    assert.throws(() => normalizeOrigenConsumo('RECETA_COMPONENTE'), /origen_consumo invalido/);
  });

  it('valida identificadores estrictamente y rechaza complementos duplicados', () => {
    for (const value of [12, '12', '0012']) {
      assert.equal(parseEntityIdentifier(value, 'id_receta').ok, true);
    }
    for (const value of ['12abc', '7-extra', '10.5', 10.5, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, [12], true, { id: 12 }, new Number(12)]) {
      assert.equal(parseEntityIdentifier(value, 'id_receta').ok, false, `debe rechazar ${String(value)}`);
    }
    assert.deepEqual(parseEntityIdentifier(null, 'id_receta'), { ok: true, value: null });
    assert.deepEqual(coercePositiveIntArray(['12', '12abc', 7, [8], true]), [12, 7]);

    const duplicate = parseComplementosPayload([{ id_complemento: 5 }, { id_complemento: 5 }]);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'VENTAS_COMPLEMENTO_DUPLICADO');
  });

  it('preserva precision fisica de inventario', () => {
    assert.equal(roundInventoryQuantity(0.005 * 0.5), 0.0025);
    assert.equal(roundInventoryQuantity(1.333333), 1.333333);
  });

  it('construye payload de cocina con cantidades de extras y salsas', () => {
    const payload = buildVentaKitchenPrintPayload({
      items: [{
        cantidad: 99,
        nombre_item: '12 ALITAS',
        extras: [{ id_extra: 8, nombre: 'Queso', cantidad_por_orden: 1, cantidad_total: 99 }],
        configuracion_menu: {
          complementos: [
            { id_complemento: 5, id_salsa: 5, nombre: 'Barbecue', porciones_por_orden: 1, porciones_total: 99 },
            { id_complemento: 6, id_salsa: 6, nombre: 'Cajun', porciones_por_orden: 1, porciones_total: 99 }
          ]
        }
      }]
    });

    assert.equal(payload.items[0].extras[0].cantidad_por_orden, 1);
    assert.equal(payload.items[0].extras[0].cantidad_total, 99);
    assert.equal(payload.items[0].complementos[0].id_salsa, 5);
    assert.equal(payload.items[0].complementos[0].porciones_total, 99);
  });

  it('construye definicion PDF con observacion, total cero y cantidades', () => {
    const doc = buildVentaTicketPdfDefinition({
      codigo_venta: 'VTA-TEST',
      nombre_sucursal: 'QA',
      id_sesion_caja: 1,
      nombre_usuario: 'cajero',
      items: [{
        cantidad: 99,
        nombre_item: '12 ALITAS',
        sub_total: 9900,
        total_linea: 0,
        observacion: 'Sin cebolla',
        extras: [{ nombre: 'Queso', cantidad_por_orden: 1, cantidad_total: 99, subtotal: 0 }],
        complementos: [
          { id_salsa: 5, nombre: 'Barbecue', porciones_por_orden: 1, porciones_total: 99 },
          { id_salsa: 6, nombre: 'Cajun', porciones_por_orden: 1, porciones_total: 99 }
        ]
      }],
      total: 0,
      sub_total: 9900,
      facturacion: { ticket: {} }
    });
    const serialized = JSON.stringify(doc.content);
    assert.match(serialized, /L 0.00/);
    assert.match(serialized, /Sin cebolla/);
    assert.match(serialized, /Extra: Queso 1 por orden - 99 total/);
    assert.match(serialized, /Salsas: Barbecue, Cajun 2 por orden - 198 total/);
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
