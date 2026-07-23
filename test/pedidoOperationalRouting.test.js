import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyPedidoInitialOperationalRouting,
  applyPedidoReplayOperationalRouting,
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
    modalidad: 'CONSUMO_LOCAL',
    origen_pedido: 'CAJA'
  });
  assert.equal(result.requiere_cocina, false);
  assert.equal(result.estado_operativo_inicial, 'COMPLETADO');
  assert.equal(result.accion_operativa, 'COMPLETAR');
});

test('2 helado tratado como producto terminado no se envia a cocina', () => {
  const result = classifyPedidoOperationalRouting([product(77)], {
    estado_pago: 'PAGADO_CONFIRMADO',
    canal: 'LOCAL',
    modalidad: 'CONSUMO_LOCAL',
    origen_pedido: 'CAJA'
  });
  assert.deepEqual(result.productos.map((line) => line.id_producto), [77]);
  assert.deepEqual(result.recetas, []);
  assert.equal(result.requiere_cocina, false);
});

test('3 producto con pago pendiente queda listo para entrega sin alterar pago', () => {
  const result = classifyPedidoOperationalRouting([product()], {
    estado_pago: 'PENDIENTE_PAGO',
    canal: 'POS',
    modalidad: 'PARA_LLEVAR',
    origen_pedido: 'CAJA'
  });
  assert.equal(result.estado_operativo_inicial, 'LISTO_PARA_ENTREGA');
  assert.equal(result.accion_operativa, 'LISTO_PARA_ENTREGA');
});

test('4 receta interna entra directamente a cocina', () => {
  const result = classifyPedidoOperationalRouting([recipe()], { origen_pedido: 'CAJA' });
  assert.equal(result.requiere_cocina, true);
  assert.equal(result.estado_operativo_inicial, 'EN_COCINA');
  assert.equal(result.accion_operativa, 'ENVIAR_COCINA');
});

test('menu publico y origen desconocido permanecen en validacion', () => {
  const publicResult = classifyPedidoOperationalRouting([recipe()], {
    origen_pedido: 'MENU',
    estado_pago: 'PAGADO_CONFIRMADO'
  });
  const unknownResult = classifyPedidoOperationalRouting([recipe()], {
    origen_pedido: 'OTRO'
  });
  assert.equal(publicResult.estado_operativo_inicial, 'PENDIENTE');
  assert.equal(publicResult.pendiente_validacion_publica, true);
  assert.equal(publicResult.requiere_revision, false);
  assert.equal(unknownResult.estado_operativo_inicial, 'PENDIENTE');
  assert.equal(unknownResult.origen_desconocido, true);
});

test('menu publico validado enruta por contenido', () => {
  const result = classifyPedidoOperationalRouting([recipe()], {
    origen_pedido: 'MENU',
    pago_confirmado_at: '2026-07-23T12:00:00-06:00'
  });
  assert.equal(result.pendiente_validacion_publica, false);
  assert.equal(result.estado_operativo_inicial, 'EN_COCINA');
});

test('matriz puntual de origen conserva pago independiente del ruteo', () => {
  for (const estadoPago of ['PAGADO_CONFIRMADO', 'PENDIENTE_PAGO']) {
    const internal = classifyPedidoOperationalRouting([recipe()], {
      origen_pedido: 'CAJA',
      estado_pago: estadoPago
    });
    assert.equal(internal.estado_operativo_inicial, 'EN_COCINA');
  }
  const publicProduct = classifyPedidoOperationalRouting([product()], {
    origen_pedido: 'MENU',
    estado_pago: 'PAGADO_CONFIRMADO'
  });
  assert.equal(publicProduct.estado_operativo_inicial, 'PENDIENTE');
  assert.equal(publicProduct.pendiente_validacion_publica, true);
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
  const routingSource = fs.readFileSync(
    new URL('../routers/ventas/services/pedidoOperationalRoutingService.js', import.meta.url),
    'utf8'
  );
  const routeStart = source.indexOf("router.put('/ventas/pedidos-menu/:id/estado'");
  const routeEnd = source.indexOf("router.get('/ventas/pedidos-pendientes'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /WHERE id_pedido = \$1[\s\S]*?FOR UPDATE/);
  assert.match(route, /transitionPedidoToKitchenState/);
  assert.match(routingSource, /visible_en_cocina_at = COALESCE/);
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
  assert.match(source, /buildKitchenOrderEligibilityPredicate\('p'/);
  assert.match(source, /buildKitchenProductPredicate\('dp'/);
  assert.match(routingSource, /buildKitchenOrderEligibilityPredicate[\s\S]*?EXISTS \([\s\S]*?NOT EXISTS \(/);
  assert.match(routingSource, /buildKitchenPreparationPredicate[\s\S]*?buildValidKitchenRecipePredicate[\s\S]*?buildValidStandaloneKitchenExtraPredicate/);
  assert.match(routingSource, /buildKitchenProductPredicate[\s\S]*?buildProductDeliverWithOrderPredicate/);
  assert.doesNotMatch(routingSource, /NOT IN \('false', '0', 'no'\)/);
  assert.match(source, /row\.kds_instruccion_operativa/);
  assert.match(routingSource, /ENTREGAR_JUNTO_CON_EL_PEDIDO/);
});

const operationalStateRows = [
  { id_estado_pedido: 1, descripcion: 'PENDIENTE' },
  { id_estado_pedido: 2, descripcion: 'EN_COCINA' },
  { id_estado_pedido: 3, descripcion: 'EN_PREPARACION' },
  { id_estado_pedido: 4, descripcion: 'LISTO_PARA_ENTREGA' },
  { id_estado_pedido: 5, descripcion: 'COMPLETADO' },
  { id_estado_pedido: 6, descripcion: 'NO_ENTREGADO' }
];

const buildOperationalRoutingClient = ({
  currentState = 'PENDIENTE',
  lines = [recipe(20, 100)],
  origin = 'CAJA',
  estadoPago = 'PENDIENTE_PAGO',
  pagoConfirmadoAt = null,
  failAt = null
} = {}) => {
  const calls = [];
  let persistedState = currentState;
  let visibleAt = currentState === 'PENDIENTE' ? null : '2026-07-23T12:00:00-06:00';
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (failAt === 'before_commit' && sql === 'COMMIT') throw new Error('COMMIT_FAILED');
        return { rowCount: null, rows: [] };
      }
      if (/FROM public\.pedidos p[\s\S]*FOR UPDATE/.test(sql)) {
        const row = operationalStateRows.find((entry) => entry.descripcion === persistedState);
        return {
          rowCount: 1,
          rows: [{
            id_estado_pedido: row?.id_estado_pedido || 99,
            estado_pedido: persistedState,
            visible_en_cocina_at: visibleAt
          }]
        };
      }
      if (/SELECT estado_pago,[\s\S]*FROM public\.pedidos/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            estado_pago: estadoPago,
            canal: 'LOCAL',
            modalidad: 'CONSUMO_LOCAL',
            origen_pedido: origin,
            pago_confirmado_at: pagoConfirmadoAt
          }]
        };
      }
      if (/FROM public\.detalle_pedido/.test(sql)) {
        if (failAt === 'detail') throw new Error('DETAIL_READ_FAILED');
        return { rowCount: lines.length, rows: lines };
      }
      if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
        if (failAt === 'catalog') throw new Error('CATALOG_READ_FAILED');
        return { rowCount: operationalStateRows.length, rows: operationalStateRows };
      }
      if (/UPDATE public\.pedidos/.test(sql)) {
        if (failAt === 'update') throw new Error('STATE_UPDATE_FAILED');
        const target = operationalStateRows.find((entry) => entry.id_estado_pedido === Number(params[1]));
        persistedState = target?.descripcion || persistedState;
        if (persistedState === 'EN_COCINA' && !visibleAt) {
          visibleAt = '2026-07-23T12:00:00-06:00';
        }
        return {
          rowCount: 1,
          rows: [{
            id_pedido: 5,
            id_estado_pedido: target?.id_estado_pedido,
            visible_en_cocina_at: visibleAt
          }]
        };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };
  return {
    client,
    calls,
    getPersistedState: () => persistedState
  };
};

test('ruteo inicial solo avanza desde PENDIENTE y no toca estado financiero', async () => {
  const fixture = buildOperationalRoutingClient();
  const result = await applyPedidoInitialOperationalRouting({ client: fixture.client, idPedido: 5 });
  assert.equal(result.estado_pedido, 'EN_COCINA');
  assert.equal(result.transicion_operativa_aplicada, true);
  const update = fixture.calls.find((call) => /UPDATE public\.pedidos/.test(call.sql));
  assert.doesNotMatch(update.sql, /estado_pago/);
  assert.match(update.sql, /visible_en_cocina_at = COALESCE/);
});

test('linea invalida permanece en PENDIENTE como no-op de revision', async () => {
  const fixture = buildOperationalRoutingClient({
    lines: [{ ...recipe(20, 100), cantidad: 0 }]
  });
  const result = await applyPedidoInitialOperationalRouting({ client: fixture.client, idPedido: 5 });
  assert.equal(result.estado_pedido, 'PENDIENTE');
  assert.equal(result.requiere_revision, true);
  assert.equal(result.ruteo_inicial_noop, true);
  assert.equal(fixture.calls.some((call) => /UPDATE public\.pedidos/.test(call.sql)), false);
});

test('replays de EN_COCINA y estados avanzados nunca regresan el pedido', async () => {
  for (const currentState of ['EN_COCINA', 'EN_PREPARACION', 'LISTO_PARA_ENTREGA', 'COMPLETADO', 'NO_ENTREGADO']) {
    const fixture = buildOperationalRoutingClient({ currentState });
    const result = await applyPedidoInitialOperationalRouting({ client: fixture.client, idPedido: 5 });
    assert.equal(result.estado_pedido, currentState);
    assert.equal(result.ruteo_inicial_noop, true);
    assert.equal(fixture.calls.some((call) => /UPDATE public\.pedidos/.test(call.sql)), false);
  }
});

test('estado actual desconocido falla cerrado sin UPDATE', async () => {
  const fixture = buildOperationalRoutingClient({ currentState: 'ESTADO_NUEVO' });
  await assert.rejects(
    () => applyPedidoInitialOperationalRouting({ client: fixture.client, idPedido: 5 }),
    (error) => error.code === 'VENTAS_PEDIDO_ESTADO_OPERATIVO_DESCONOCIDO'
  );
  assert.equal(fixture.calls.some((call) => /UPDATE public\.pedidos/.test(call.sql)), false);
});

test('fallos de catalogo, detalle y UPDATE se propagan sin exito silencioso', async () => {
  for (const failAt of ['catalog', 'detail', 'update']) {
    const fixture = buildOperationalRoutingClient({ failAt });
    await assert.rejects(
      () => applyPedidoInitialOperationalRouting({ client: fixture.client, idPedido: 5 }),
      new RegExp(failAt === 'catalog' ? 'CATALOG' : failAt === 'detail' ? 'DETAIL' : 'STATE_UPDATE')
    );
  }
});

test('fallo antes de COMMIT ejecuta ROLLBACK y se propaga al caller', async () => {
  const fixture = buildOperationalRoutingClient({ failAt: 'before_commit' });
  await assert.rejects(
    () => applyPedidoReplayOperationalRouting({ client: fixture.client, idPedido: 5 }),
    /COMMIT_FAILED/
  );
  assert.equal(fixture.calls.some((call) => call.sql === 'ROLLBACK'), true);
});

test('dos replays concurrentes se serializan y producen un UPDATE y un no-op', async () => {
  let persistedState = 'PENDIENTE';
  let visibleAt = null;
  let updateCount = 0;
  let lockCount = 0;
  let transactionTail = Promise.resolve();

  const createConcurrentClient = () => {
    let releaseTransaction = null;
    return {
      query: async (sql, params = []) => {
        if (sql === 'BEGIN') {
          const previousTransaction = transactionTail;
          transactionTail = new Promise((resolve) => {
            releaseTransaction = resolve;
          });
          await previousTransaction;
          return { rowCount: null, rows: [] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          releaseTransaction?.();
          return { rowCount: null, rows: [] };
        }
        if (/FROM public\.pedidos p[\s\S]*FOR UPDATE/.test(sql)) {
          lockCount += 1;
          const row = operationalStateRows.find((entry) => entry.descripcion === persistedState);
          return {
            rowCount: 1,
            rows: [{
              id_estado_pedido: row.id_estado_pedido,
              estado_pedido: persistedState,
              visible_en_cocina_at: visibleAt
            }]
          };
        }
        if (/SELECT estado_pago,[\s\S]*FROM public\.pedidos/.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              estado_pago: 'PENDIENTE_PAGO',
              canal: 'LOCAL',
              modalidad: 'CONSUMO_LOCAL',
              origen_pedido: 'CAJA',
              pago_confirmado_at: null
            }]
          };
        }
        if (/FROM public\.detalle_pedido/.test(sql)) {
          return { rowCount: 1, rows: [recipe(20, 100)] };
        }
        if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
          return { rowCount: operationalStateRows.length, rows: operationalStateRows };
        }
        if (/UPDATE public\.pedidos/.test(sql)) {
          updateCount += 1;
          persistedState = 'EN_COCINA';
          visibleAt ||= '2026-07-23T12:00:00-06:00';
          return {
            rowCount: 1,
            rows: [{
              id_pedido: 5,
              id_estado_pedido: Number(params[1]),
              visible_en_cocina_at: visibleAt
            }]
          };
        }
        throw new Error(`SQL inesperado: ${sql}`);
      }
    };
  };

  const results = await Promise.all([
    applyPedidoReplayOperationalRouting({ client: createConcurrentClient(), idPedido: 5 }),
    applyPedidoReplayOperationalRouting({ client: createConcurrentClient(), idPedido: 5 })
  ]);
  assert.equal(results.filter((result) => result.transicion_operativa_aplicada).length, 1);
  assert.equal(results.filter((result) => result.ruteo_inicial_noop).length, 1);
  assert.equal(persistedState, 'EN_COCINA');
  assert.equal(updateCount, 1);
  assert.equal(lockCount, 2);
});
