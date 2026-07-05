import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

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

  it('pedido pendiente V2 acepta salsas y excluye solo cuenta dividida', async () => {
    const source = await readVentasSource();
    const handlerStart = source.indexOf("router.post('/ventas/pedidos-pendientes'");
    const v2Condition = source.indexOf('const shouldUsePedidoPendienteRpcV2 =', handlerStart);
    const v1Condition = source.indexOf('const shouldUsePedidoPendienteRpcV1 =', handlerStart);
    const v2Block = source.slice(v2Condition, v1Condition);
    assert.match(v2Block, /pedidoPendienteRpcV2Enabled/);
    assert.match(v2Block, /!cuentaDivisionPlan/);
    assert.doesNotMatch(v2Block, /pedidoPendienteHasSalsasInventario/);
    assert.match(source, /CUENTA_DIVIDIDA_NO_SOPORTADA_RPC_V2/);
  });
});
