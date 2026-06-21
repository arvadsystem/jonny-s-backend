import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePedidoPayload } from '../services/pedidoPayloadValidator.js';
import { resolvePedidoConsumo } from '../services/pedidoConsumoResolver.js';
import { buildSalsaConsumptionItemsFromPedidoDetails } from '../services/salsasPedidoSnapshotService.js';

const makeSelection = (idSalsa, idInsumo, nombre) => ({
  id_salsa: idSalsa,
  nombre,
  inventario: {
    id_salsa: idSalsa,
    nombre,
    id_insumo: idInsumo,
    id_insumo_maestro: idInsumo,
    id_almacen: 1,
    cantidad_porcion: 2,
    id_unidad_consumo: 7,
    cantidad_base_por_porcion: 2,
    cantidad_base_total: 2,
    id_unidad_base: 7,
    porciones: 1
  }
});

const detailRows = [
  {
    id_detalle_pedido: 101,
    configuracion_menu: {
      complementos: [makeSelection(1, 190, 'Bufalo'), makeSelection(3, 31, 'Chipotle')]
    }
  },
  {
    id_detalle_pedido: 102,
    configuracion_menu: {
      complementos: [makeSelection(1, 190, 'Bufalo'), makeSelection(2, 30, 'Cajun')]
    }
  }
];

const built = buildSalsaConsumptionItemsFromPedidoDetails(detailRows);
assert.deepEqual(built.errors, []);
assert.equal(built.items.length, 4, 'las selecciones de lineas distintas deben conservarse por separado');
assert.equal(built.items.filter((item) => item.id_salsa === 1).length, 2, 'Bufalo repetida en dos lineas debe producir dos porciones');

const historicalAggregate = makeSelection(1, 190, 'Bufalo');
historicalAggregate.inventario.cantidad_base_total = 4;
historicalAggregate.inventario.porciones = 2;
const historicalDuplicate = buildSalsaConsumptionItemsFromPedidoDetails([{
  id_detalle_pedido: 104,
  configuracion_menu: { complementos: [historicalAggregate, structuredClone(historicalAggregate)] }
}]);
assert.equal(historicalDuplicate.items.length, 1, 'un snapshot agregado historico repetido no debe duplicar consumo');
assert.equal(historicalDuplicate.items[0].cantidad, 4);

const normalized = normalizePedidoPayload({ id_sucursal: 1, id_pedido: 500, items: built.items });
assert.equal(normalized.ok, true, normalized.errors.join('; '));
const resolved = await resolvePedidoConsumo({ client: {}, items: normalized.value.items });
assert.equal(resolved.consumo.insumoQtyMap.get(190), 4, 'dos porciones de Bufalo deben sumar 4 oz');
assert.equal(resolved.consumo.insumoQtyMap.get(31), 2);
assert.equal(resolved.consumo.insumoQtyMap.get(30), 2);
assert.equal(resolved.insumoWarehouseById.get(190), 1, 'el almacen del snapshot debe preservarse');
assert.deepEqual([...resolved.insumoTraceById.get(190).detallePedidoIds], [101, 102], 'la traza debe conservar ambas lineas del pedido');

const legacySkipped = buildSalsaConsumptionItemsFromPedidoDetails(detailRows, {
  legacyConsumedByStockKey: new Map([['190:1', 4]])
});
assert.equal(legacySkipped.items.some((item) => item.id_insumo === 190), false, 'un consumo historico VENTA_SALSA no debe duplicarse en Cocina');
assert.equal(legacySkipped.items.length, 2, 'solo deben omitirse los snapshots ya consumidos');

const malformed = buildSalsaConsumptionItemsFromPedidoDetails([{
  id_detalle_pedido: 103,
  configuracion_menu: { complementos: [{ id_salsa: 2, inventario: { id_insumo: 30 } }] }
}]);
assert.equal(malformed.errors[0]?.code, 'SALSA_SNAPSHOT_INCOMPLETO');

const ventasSource = readFileSync(new URL('../routers/ventas.js', import.meta.url), 'utf8');
assert.doesNotMatch(ventasSource, /consumeSalsasInventoryFromSnapshots\s*\(/, 'Ventas no debe consumir salsas al crear venta o pedido pendiente');
const salsaServiceSource = readFileSync(new URL('../routers/ventas/services/salsasInventoryService.js', import.meta.url), 'utf8');
assert.match(salsaServiceSource, /cantidad_base_total: snapshot\.cantidad_base_por_porcion/, 'cada seleccion persistida debe guardar una sola porcion');
const cocinaSource = readFileSync(new URL('../routers/cocina.js', import.meta.url), 'utf8');
assert.match(cocinaSource, /buildSalsaConsumptionItemsFromPedidoDetails/, 'Cocina debe incorporar snapshots al payload canonico');
assert.match(cocinaSource, /estadoDestino === 'EN_PREPARACION'/, 'el evento canonico debe seguir siendo EN_PREPARACION');
assert.match(cocinaSource, /strictInsumoIds: strictSalsaInsumoIds/, 'los faltantes de salsa deben abortar aunque Cocina permita advertencias de receta');
const movementSource = readFileSync(new URL('../services/inventarioMovimientoService.js', import.meta.url), 'utf8');
assert.match(movementSource, /fetchExistingPedidoMovement/, 'el consumo debe reutilizar idempotencia por pedido');

console.log('OK salsas Cocina snapshot and idempotency contract QA');
