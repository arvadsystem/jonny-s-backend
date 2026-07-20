import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  persistImmediateSalePaymentState,
  reconcileVentaResponseWithPersistedPedidoState
} from '../routers/ventas/services/ventaImmediatePaymentStateService.js';
import {
  initializePedidoPendingKitchen,
  isInitialKitchenDispatchEvent,
  markPedidoVisibleInKitchen
} from '../routers/ventas/services/pedidoKitchenVisibilityService.js';

const venta = {
  id_usuario: 44,
  id_sesion_caja: 71,
  total: 29200,
  contexto: { canal: 'LOCAL', modalidad: 'CONSUMO_LOCAL' }
};

const buildImmediatePaymentDb = ({ existingControl = false } = {}) => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
        return { rowCount: 2, rows: [
          { id_estado_pedido: 1, descripcion: 'PENDIENTE' },
          { id_estado_pedido: 2, descripcion: 'EN_COCINA' }
        ] };
      }
      if (/FROM public\.cat_pedidos_estados_pago/.test(sql)) {
        return { rowCount: 1, rows: [{ id_estado_pago_pedido: 9 }] };
      }
      if (/UPDATE public\.pedidos\s/.test(sql)) return { rowCount: 1, rows: [] };
      if (/SELECT id_pedido_pago_control/.test(sql)) {
        return existingControl
          ? { rowCount: 1, rows: [{ id_pedido_pago_control: 88 }] }
          : { rowCount: 0, rows: [] };
      }
      if (/UPDATE public\.pedidos_pago_control/.test(sql)) return { rowCount: 1, rows: [] };
      if (/INSERT INTO public\.pedidos_pago_control/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };
  return { client, calls };
};

test('venta inmediata persiste pago confirmado, canal y modalidad exactos', async () => {
  const fixture = buildImmediatePaymentDb();
  await persistImmediateSalePaymentState({
    client: fixture.client,
    idPedido: 218,
    idFactura: 172,
    venta
  });

  const pedidoUpdate = fixture.calls.find((call) => /UPDATE public\.pedidos\s/.test(call.sql));
  assert.ok(pedidoUpdate);
  assert.deepEqual(pedidoUpdate.params, [218, 'PAGADO_CONFIRMADO', 44, 'LOCAL', 'CONSUMO_LOCAL', 1]);
  assert.match(pedidoUpdate.sql, /pago_confirmado_at = COALESCE/);
  assert.match(pedidoUpdate.sql, /id_usuario_pago_confirmado = COALESCE/);
  assert.match(pedidoUpdate.sql, /validacion_pago_vence_at = NULL/);
  assert.match(pedidoUpdate.sql, /cancelado_por_timeout_at = NULL/);
  assert.match(pedidoUpdate.sql, /visible_en_cocina_at = NULL/);

  const controlInsert = fixture.calls.find((call) => /INSERT INTO public\.pedidos_pago_control/.test(call.sql));
  assert.ok(controlInsert);
  assert.deepEqual(controlInsert.params, [218, 9, 29200, 44, 71, 172]);
  assert.match(controlInsert.sql, /monto_pendiente/);
  assert.match(controlInsert.sql, /VALUES \(\$1, \$2, NULL, \$3, \$3, 0/);
});

test('reconciliacion idempotente actualiza el control existente sin duplicarlo', async () => {
  const fixture = buildImmediatePaymentDb({ existingControl: true });
  await persistImmediateSalePaymentState({
    client: fixture.client,
    idPedido: 218,
    idFactura: 172,
    venta
  });

  assert.equal(fixture.calls.filter((call) => /INSERT INTO public\.pedidos_pago_control/.test(call.sql)).length, 0);
  const update = fixture.calls.find((call) => /UPDATE public\.pedidos_pago_control/.test(call.sql));
  assert.ok(update);
  assert.deepEqual(update.params, [88, 9, 29200, 44, 71, 172]);
  assert.match(update.sql, /fecha_pago_confirmado = COALESCE/);
});

test('pedido nuevo queda pendiente y fuera de cocina antes de aceptar la comanda', async () => {
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
        return { rowCount: 1, rows: [{ id_estado_pedido: 1, descripcion: 'PENDIENTE' }] };
      }
      if (/UPDATE public\.pedidos/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };

  await initializePedidoPendingKitchen({ client, idPedido: 217 });
  const update = calls.find((call) => /UPDATE public\.pedidos/.test(call.sql));
  assert.deepEqual(update.params, [217, 1]);
  assert.match(update.sql, /visible_en_cocina_at = NULL/);
});

test('aceptar comanda marca EN_COCINA sin reemplazar una fecha ya establecida', async () => {
  const calls = [];
  const visibleAt = new Date('2026-07-20T12:00:00Z');
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
        return { rowCount: 1, rows: [{ id_estado_pedido: 2, descripcion: 'EN_COCINA' }] };
      }
      if (/UPDATE public\.pedidos/.test(sql)) {
        return { rowCount: 1, rows: [{ id_pedido: 217, id_estado_pedido: 2, visible_en_cocina_at: visibleAt }] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };

  const result = await markPedidoVisibleInKitchen({ client, idPedido: 217 });
  const update = calls.find((call) => /UPDATE public\.pedidos/.test(call.sql));
  assert.deepEqual(update.params, [217, 2]);
  assert.match(update.sql, /visible_en_cocina_at = COALESCE/);
  assert.equal(result.visible_en_cocina_at, visibleAt);
});

test('fallo al localizar pedido impide confirmar la transicion a cocina', async () => {
  const client = {
    query: async (sql) => {
      if (/SELECT id_estado_pedido, descripcion FROM estados_pedido/.test(sql)) {
        return { rowCount: 1, rows: [{ id_estado_pedido: 2, descripcion: 'EN_COCINA' }] };
      }
      if (/UPDATE public\.pedidos/.test(sql)) return { rowCount: 0, rows: [] };
      throw new Error(`SQL inesperado: ${sql}`);
    }
  };

  await assert.rejects(
    () => markPedidoVisibleInKitchen({ client, idPedido: 999 }),
    (error) => error.code === 'PRINT_PEDIDO_NOT_FOUND' && error.status === 404
  );
});

test('respuesta idempotente se reconcilia con el estado realmente persistido', async () => {
  const visibleAt = null;
  const client = {
    query: async (sql, params) => {
      assert.match(sql, /FROM public\.pedidos p/);
      assert.deepEqual(params, [218]);
      return {
        rowCount: 1,
        rows: [{
          id_pedido: 218,
          estado_pago: 'PAGADO_CONFIRMADO',
          canal: 'LOCAL',
          modalidad: 'CONSUMO_LOCAL',
          id_estado_pedido: 1,
          visible_en_cocina_at: visibleAt,
          estado_pedido: 'Pendiente'
        }]
      };
    }
  };

  const response = await reconcileVentaResponseWithPersistedPedidoState({
    client,
    response: {
      id_pedido: 218,
      estado_pago: 'PENDIENTE_PAGO',
      estado_pedido: 'EN_COCINA',
      canal: 'DELIVERY',
      modalidad: 'DELIVERY',
      visible_en_cocina_at: '2026-07-20T12:00:00.000Z',
      idempotent_replay: true,
      contexto: { canal: 'DELIVERY', modalidad: 'DELIVERY' },
      pedido: { id_pedido: 218, estado_pedido: 'EN_COCINA' }
    }
  });

  assert.equal(response.idempotent_replay, true);
  assert.equal(response.estado_pago, 'PAGADO_CONFIRMADO');
  assert.equal(response.estado_pedido, 'PENDIENTE');
  assert.equal(response.id_estado_pedido, 1);
  assert.equal(response.visible_en_cocina_at, null);
  assert.deepEqual(response.contexto, { canal: 'LOCAL', modalidad: 'CONSUMO_LOCAL' });
  assert.deepEqual(response.pedido, {
    id_pedido: 218,
    id_estado_pedido: 1,
    estado_pedido: 'PENDIENTE',
    visible_en_cocina_at: null
  });
});

test('pedido con pago pendiente responde PENDIENTE_PAGO y permanece fuera de cocina', async () => {
  const client = {
    query: async () => ({
      rowCount: 1,
      rows: [{
        id_pedido: 219,
        estado_pago: 'PENDIENTE_PAGO',
        canal: 'POS',
        modalidad: 'PARA_LLEVAR',
        id_estado_pedido: 1,
        visible_en_cocina_at: null,
        estado_pedido: 'PENDIENTE'
      }]
    })
  };

  const response = await reconcileVentaResponseWithPersistedPedidoState({
    client,
    response: {
      id_pedido: 219,
      estado_pago: 'PENDIENTE_PAGO',
      estado_pedido: 'EN_COCINA'
    }
  });

  assert.equal(response.estado_pago, 'PENDIENTE_PAGO');
  assert.equal(response.estado_pedido, 'PENDIENTE');
  assert.equal(response.visible_en_cocina_at, null);
  assert.equal(response.canal, 'POS');
  assert.equal(response.modalidad, 'PARA_LLEVAR');
});

test('RPC V1 usa el id de rpcCreateResult y no referencia una variable fuera de alcance', () => {
  const source = fs.readFileSync(new URL('../routers/ventas.js', import.meta.url), 'utf8');
  const start = source.indexOf('if (ventasRpcV1Enabled && !ventaHasExtras && !ventaHasSalsasInventario)');
  const end = source.indexOf('const correlativoStart = ventasPerf.now();', start);
  assert.ok(start >= 0 && end > start);
  const rpcV1Block = source.slice(start, end);

  assert.match(
    rpcV1Block,
    /initializePedidoPendingKitchen\(\{ client, idPedido: rpcCreateResult\.response\?\.id_pedido \}\)/
  );
  assert.doesNotMatch(rpcV1Block, /rpcResponseBody/);
});

test('RPC V1, V2, V3 y legacy reconcilian la respuesta antes de guardarla o devolverla', () => {
  const source = fs.readFileSync(new URL('../routers/ventas.js', import.meta.url), 'utf8');
  const immediateStart = source.indexOf("router.post('/ventas', checkPermission(['VENTAS_CREAR'])");
  const immediateSource = source.slice(immediateStart);

  assert.ok(immediateStart >= 0);
  assert.match(immediateSource, /if \(ventasRpcV3Enabled\)[\s\S]*?rpcV3ResponseBody = await reconcileVentaResponseWithPersistedPedidoState/);
  assert.match(immediateSource, /if \(ventasRpcV2Enabled[\s\S]*?rpcV2ResponseBody = await reconcileVentaResponseWithPersistedPedidoState/);
  assert.match(immediateSource, /if \(ventasRpcV1Enabled[\s\S]*?rpcV1ResponseBody = await reconcileVentaResponseWithPersistedPedidoState/);
  assert.match(immediateSource, /const createVentaResponse = await reconcileVentaResponseWithPersistedPedidoState/);
});

test('solo aceptar una comanda inicial habilita la transicion a cocina', () => {
  assert.equal(isInitialKitchenDispatchEvent({
    tipo_documento: 'COMANDA',
    estado: 'ENVIADA',
    metadata: { promptAction: 'initial' }
  }), true);
  assert.equal(isInitialKitchenDispatchEvent({
    tipo_documento: 'COMANDA',
    estado: 'CANCELADA',
    metadata: { promptAction: 'initial' }
  }), false);
  assert.equal(isInitialKitchenDispatchEvent({
    tipo_documento: 'COMANDA',
    estado: 'ENVIADA',
    metadata: { promptAction: 'reprint' }
  }), false);
});
