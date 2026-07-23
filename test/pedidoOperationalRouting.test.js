import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyPedidoInitialOperationalRouting,
  classifyPedidoOperationalRouting
} from '../routers/ventas/services/pedidoOperationalRoutingService.js';
import { resolvePedidoConsumo } from '../services/pedidoConsumoResolver.js';

const product = (id = 10, detailId = id) => ({
  id_detalle_pedido: detailId,
  tipo_item: 'PRODUCTO',
  id_producto: id,
  id_receta: null,
  nombre_item: `Producto ${id}`,
  cantidad: 1
});
const recipe = (id = 20, detailId = id) => ({
  id_detalle_pedido: detailId,
  tipo_item: 'RECETA',
  id_producto: null,
  id_receta: id,
  nombre_item: `Receta ${id}`,
  cantidad: 1
});

test('1 producto terminado pagado en local se completa sin cocina', () => {
  const result = classifyPedidoOperationalRouting([product()], {
    estado_pago: 'PAGADO_CONFIRMADO',
    canal: 'LOCAL',
    modalidad: 'CONSUMO_LOCAL'
  });
  assert.equal(result.requiere_cocina, false);
  assert.equal(result.estado_operativo_inicial, 'COMPLETADO');
  assert.equal(result.accion_operativa, 'COMPLETAR');
});

test('2 helado tratado como producto terminado no se envia a cocina', () => {
  const result = classifyPedidoOperationalRouting([product(77)], {
    estado_pago: 'PAGADO_CONFIRMADO',
    canal: 'LOCAL',
    modalidad: 'CONSUMO_LOCAL'
  });
  assert.deepEqual(result.productos.map((line) => line.id_producto), [77]);
  assert.deepEqual(result.recetas, []);
  assert.equal(result.requiere_cocina, false);
});

test('3 producto con pago pendiente queda listo para entrega sin alterar pago', () => {
  const result = classifyPedidoOperationalRouting([product()], {
    estado_pago: 'PENDIENTE_PAGO',
    canal: 'POS',
    modalidad: 'PARA_LLEVAR'
  });
  assert.equal(result.estado_operativo_inicial, 'LISTO_PARA_ENTREGA');
  assert.equal(result.accion_operativa, 'LISTO_PARA_ENTREGA');
});

test('4 receta conserva flujo pendiente hacia cocina', () => {
  const result = classifyPedidoOperationalRouting([recipe()]);
  assert.equal(result.requiere_cocina, true);
  assert.equal(result.estado_operativo_inicial, 'PENDIENTE');
  assert.equal(result.accion_operativa, 'ENVIAR_COCINA');
});

test('5 pedido mixto requiere cocina y separa receta de producto', () => {
  const result = classifyPedidoOperationalRouting([recipe(20, 1), product(10, 2)]);
  assert.equal(result.requiere_cocina, true);
  assert.deepEqual(result.items_preparables.map((line) => line.id_detalle_pedido), [1]);
  assert.deepEqual(result.items_entrega_conjunta.map((line) => line.id_detalle_pedido), [2]);
  assert.deepEqual(result.recetas.map((line) => line.id_detalle_pedido), [1]);
  assert.deepEqual(result.productos.map((line) => line.id_detalle_pedido), [2]);
});

test('6 pedido mixto conserva multiples productos como recordatorios', () => {
  const result = classifyPedidoOperationalRouting([
    recipe(20, 1),
    product(10, 2),
    product(11, 3),
    product(12, 4)
  ]);
  assert.equal(result.requiere_cocina, true);
  assert.deepEqual(result.productos.map((line) => line.id_producto), [10, 11, 12]);
});

test('7 linea sin producto ni receta queda bloqueada para revision', () => {
  const result = classifyPedidoOperationalRouting([{ id_detalle_pedido: 90 }]);
  assert.equal(result.requiere_revision, true);
  assert.deepEqual(result.items_sin_clasificar.map((line) => line.id_detalle_pedido), [90]);
  assert.equal(result.requiere_cocina, false);
  assert.equal(result.estado_operativo_inicial, 'PENDIENTE');
  assert.deepEqual(result.lineas_invalidas.map((line) => line.id_detalle_pedido), [90]);
});

test('8 linea con producto y receta queda bloqueada para revision', () => {
  const result = classifyPedidoOperationalRouting([{
    id_detalle_pedido: 91,
    id_producto: 10,
    id_receta: 20
  }]);
  assert.equal(result.requiere_revision, true);
  assert.equal(result.accion_operativa, 'REQUIERE_REVISION');
});

test('9 doble clic se atiende como replay idempotente en la ruta explicita', () => {
  const source = fs.readFileSync(new URL('../routers/ventas.js', import.meta.url), 'utf8');
  const routeStart = source.indexOf("router.put('/ventas/pedidos-menu/:id/estado'");
  const routeEnd = source.indexOf("router.get('/ventas/pedidos-pendientes'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /currentCode === normalizedTargetCode/);
  assert.match(route, /idempotent_replay: true/);
});

test('10 solicitudes concurrentes serializan por pedido antes de transicionar', () => {
  const source = fs.readFileSync(new URL('../routers/ventas.js', import.meta.url), 'utf8');
  const routeStart = source.indexOf("router.put('/ventas/pedidos-menu/:id/estado'");
  const routeEnd = source.indexOf("router.get('/ventas/pedidos-pendientes'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /WHERE id_pedido = \$1[\s\S]*?FOR UPDATE/);
  assert.match(route, /visible_en_cocina_at = COALESCE/);
});

test('11 fallo de impresion no controla la transicion operacional', () => {
  const auditSource = fs.readFileSync(new URL('../routers/ventas/handlers/ventasPrintHandlers.js', import.meta.url), 'utf8');
  const queueSource = fs.readFileSync(new URL('../routers/printing.js', import.meta.url), 'utf8');
  assert.doesNotMatch(auditSource, /markPedidoVisibleInKitchen|isInitialKitchenDispatchEvent/);
  assert.doesNotMatch(queueSource, /markPedidoVisibleInKitchen|onInsertedTransaction/);
});

test('12 inventario protege el pedido contra un segundo descuento', () => {
  const source = fs.readFileSync(new URL('../services/inventarioPedidoService.js', import.meta.url), 'utf8');
  const existingCheck = source.indexOf('fetchExistingPedidoMovement(client, idPedido)');
  const consumption = source.indexOf('resolvePedidoConsumo({');
  const register = source.indexOf('registrarMovimientosPedido({');
  assert.ok(existingCheck >= 0 && existingCheck < consumption && consumption < register);
  assert.match(source, /error\.code = 'PEDIDO_YA_DESCONTADO'/);
});

test('13 producto terminado no genera consumo de ingredientes', async () => {
  const result = await resolvePedidoConsumo({
    client: { query: async () => { throw new Error('No se esperaba consulta para un producto aislado.'); } },
    items: [{
      tipo_item: 'PRODUCTO',
      id_item: 10,
      id_producto: 10,
      id_detalle_pedido: 100,
      cantidad: 2
    }]
  });
  assert.equal(result.consumo.productoQtyMap.get(10), 2);
  assert.equal(result.consumo.insumoQtyMap.size, 0);
  assert.deepEqual(result.consumo.movimientoRows.map((row) => row.tipo_recurso), ['producto']);
});

test('14 consulta KDS oculta pedidos solo-producto e incluye recordatorios en mixtos', () => {
  const source = fs.readFileSync(new URL('../routers/cocina.js', import.meta.url), 'utf8');
  const routingSource = fs.readFileSync(
    new URL('../routers/ventas/services/kitchenPrintRoutingService.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /EXISTS \([\s\S]*?buildKitchenPreparationPredicate\('dp_route'\)/);
  assert.match(source, /buildKitchenProductPredicate\('dp'/);
  assert.match(routingSource, /buildKitchenPreparationPredicate[\s\S]*?id_receta IS NOT NULL[\s\S]*?buildValidStandaloneKitchenExtraPredicate/);
  assert.match(routingSource, /buildKitchenProductPredicate[\s\S]*?entregar_con_pedido[\s\S]*?NOT IN \('false', '0', 'no'\)/);
  assert.match(source, /row\.id_producto !== null[\s\S]*?ENTREGAR_JUNTO_CON_EL_PEDIDO/);
  assert.match(source, /ENTREGAR_JUNTO_CON_EL_PEDIDO/);
});

test('aplicacion inicial persiste el estado derivado sin tocar el estado financiero', async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT estado_pago, canal, tipo_entrega AS modalidad/.test(sql)) {
        return { rowCount: 1, rows: [{ estado_pago: 'PENDIENTE_PAGO', canal: 'POS', modalidad: 'PARA_LLEVAR' }] };
      }
      if (/FROM public\.detalle_pedido/.test(sql)) {
        return { rowCount: 1, rows: [product(10, 100)] };
      }
      if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
        return { rowCount: 2, rows: [
          { id_estado_pedido: 1, descripcion: 'PENDIENTE' },
          { id_estado_pedido: 3, descripcion: 'LISTO_PARA_ENTREGA' }
        ] };
      }
      if (/UPDATE public\.pedidos/.test(sql)) {
        return { rowCount: 1, rows: [{ id_pedido: 5, id_estado_pedido: 3, visible_en_cocina_at: null }] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };

  const result = await applyPedidoInitialOperationalRouting({ client, idPedido: 5 });
  assert.equal(result.estado_pedido, 'LISTO_PARA_ENTREGA');
  const update = calls.find((call) => /UPDATE public\.pedidos/.test(call.sql));
  assert.doesNotMatch(update.sql, /estado_pago/);
  assert.deepEqual(update.params, [5, 3]);
});

test('aplicacion inicial no cambia estado cuando la cantidad operativa es invalida', async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (/SELECT estado_pago, canal, tipo_entrega AS modalidad/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ estado_pago: 'PENDIENTE_PAGO', canal: 'POS', modalidad: 'PARA_LLEVAR' }]
        };
      }
      if (/FROM public\.detalle_pedido/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ ...recipe(20, 100), cantidad: 0 }]
        };
      }
      throw new Error(`No se esperaba ejecutar SQL adicional: ${sql}`);
    }
  };

  await assert.rejects(
    () => applyPedidoInitialOperationalRouting({ client, idPedido: 5 }),
    (error) => error.status === 409
      && error.code === 'VENTAS_PEDIDO_REQUIERE_REVISION'
      && error.lineas_invalidas[0].motivo === 'CANTIDAD_INVALIDA'
  );
  assert.equal(calls.some((sql) => /UPDATE public\.pedidos/.test(sql)), false);
});
