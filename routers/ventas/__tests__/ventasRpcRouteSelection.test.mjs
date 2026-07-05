import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  IDEMPOTENCY_MODE,
  resolvePedidoPendienteIdempotencyMode,
  resolveVentaIdempotencyMode,
  resolvePedidoPendienteRpcSkipReason,
  shouldUsePedidoPendienteRpcV2
} from '../services/ventasRpcRoutingService.js';

const readVentasSource = () => readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

describe('ventas RPC route selection', () => {
  it('POST /ventas selecciona V3 antes del fallback por salsas', async () => {
    const source = await readVentasSource();
    const handlerStart = source.indexOf("router.post('/ventas', checkPermission(['VENTAS_CREAR'])");
    const v3Branch = source.indexOf('if (ventasRpcV3Enabled) {', handlerStart);
    const salsaFallback = source.indexOf("rpc_disabled_reason = 'SALSAS_INVENTARIO_NO_SOPORTADAS_RPC_V2'", handlerStart);
    assert.ok(v3Branch > handlerStart);
    assert.ok(salsaFallback > v3Branch);
    assert.match(source.slice(v3Branch, salsaFallback), /persistence_mode = 'rpc_v3'/);
  });

  it('pedido pendiente V2 acepta salsas y excluye solo cuenta dividida', () => {
    assert.equal(shouldUsePedidoPendienteRpcV2({
      pedidoPendienteRpcV2Enabled: true,
      cuentaDivisionPlan: null,
      pedidoLines: [{ item_index: 0, salsa_snapshot: { id_salsa: 2 } }]
    }), true);
    assert.equal(shouldUsePedidoPendienteRpcV2({
      pedidoPendienteRpcV2Enabled: true,
      cuentaDivisionPlan: { pagos: [] },
      pedidoLines: [{ item_index: 0 }]
    }), false);
    assert.equal(resolvePedidoPendienteRpcSkipReason({
      cuentaDivisionPlan: { pagos: [] },
      pedidoPendienteRpcV2Enabled: true,
      pedidoPendienteHasSalsasInventario: false,
      pedidoPendienteRpcEnabled: true
    }), 'CUENTA_DIVIDIDA_NO_SOPORTADA_RPC_V2');
  });

  it('flags nuevas apagadas conservan idempotencia externa y rutas previas', () => {
    assert.equal(resolveVentaIdempotencyMode({
      ventasRpcV3Enabled: false,
      idempotencyKey: 'idem-1'
    }), IDEMPOTENCY_MODE.EXTERNAL);
    assert.equal(resolvePedidoPendienteIdempotencyMode({
      pedidoPendienteRpcV2Enabled: false,
      cuentaDivididaSolicitada: false,
      idempotencyKey: 'idem-1'
    }), IDEMPOTENCY_MODE.EXTERNAL);
    assert.equal(shouldUsePedidoPendienteRpcV2({
      pedidoPendienteRpcV2Enabled: false,
      cuentaDivisionPlan: null,
      pedidoLines: [{ item_index: 0 }]
    }), false);
  });
});
