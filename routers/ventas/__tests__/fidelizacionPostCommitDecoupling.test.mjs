import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import pool from '../../../config/db-connection.js';
import { registerVentaFidelizacionAfterCommit } from '../../ventas.js';
import { createFidelizacionMockClient } from '../../../services/__tests__/fidelizacionMockClient.mjs';

const getVentasSource = async () => readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

const getFunctionBlock = (source, startMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `No se encontro "${startMarker}"`);
  const end = source.indexOf('\n};', start);
  assert.notEqual(end, -1, `No se encontro el cierre de "${startMarker}"`);
  return source.slice(start, end);
};

const getHandlerBlock = async (source, routeMarker) => {
  const start = source.indexOf(routeMarker);
  assert.notEqual(start, -1, `No se encontro el handler "${routeMarker}"`);
  const end = source.indexOf("\n});", start);
  assert.notEqual(end, -1, `No se encontro el cierre del handler "${routeMarker}"`);
  return source.slice(start, end);
};

const withMockedPoolConnect = async (connectImpl, run) => {
  const originalConnect = pool.connect;
  pool.connect = connectImpl;
  try {
    await run();
  } finally {
    pool.connect = originalConnect;
  }
};

describe('Desacople estructural: fidelizacion nunca antes del COMMIT financiero', () => {
  it('registerVentaFidelizacionAfterCommit no depende de una variable ventasPerf fuera de alcance', async () => {
    const source = await getVentasSource();
    const block = getFunctionBlock(source, 'const registerVentaFidelizacionAfterCommit = async');
    assert.doesNotMatch(block, /\bventasPerf\./, 'no debe referenciar el tracker del handler llamador');
    assert.match(block, /createVentasPerfTracker\(\)/, 'debe usar su propio tracker de performance');
  });

  it('POST /ventas/pedidos/:id/registrar-pago no llama registerFacturaLoyaltyAccumulation antes del COMMIT', async () => {
    const source = await getVentasSource();
    const handler = await getHandlerBlock(
      source,
      "router.post('/ventas/pedidos/:id/registrar-pago'"
    );
    assert.doesNotMatch(handler, /registerFacturaLoyaltyAccumulation\(/);
    const commitIndex = handler.indexOf("await client.query('COMMIT');");
    const jsonIndex = handler.indexOf('res.status(201).json(');
    const deferredIndex = handler.indexOf('registerVentaFidelizacionAfterCommit(');
    assert.ok(commitIndex > -1 && jsonIndex > -1 && deferredIndex > -1);
    assert.ok(commitIndex < jsonIndex, 'la respuesta debe enviarse despues del COMMIT');
    assert.ok(jsonIndex < deferredIndex, 'la fidelizacion se dispara despues de responder al cliente');
  });

  it('POST /ventas/pedidos/:id/registrar-pago solo dispara fidelizacion cuando el pago quedo completo', async () => {
    const source = await getVentasSource();
    const handler = await getHandlerBlock(
      source,
      "router.post('/ventas/pedidos/:id/registrar-pago'"
    );
    assert.match(
      handler,
      /if \(pedidoPagadoCompleto\) \{\s*void registerVentaFidelizacionAfterCommit\(/,
      'el disparo diferido debe quedar condicionado a pago completo (pago dividido incompleto no acumula)'
    );
  });

  it('POST /ventas (venta directa legado) no llama registerFacturaLoyaltyAccumulation antes del COMMIT', async () => {
    const source = await getVentasSource();
    const legacyStart = source.indexOf('const correlativoStart = ventasPerf.now();');
    assert.notEqual(legacyStart, -1, 'No se localizo el inicio del flujo legado de creacion de venta.');
    const legacyEnd = source.indexOf('} catch (err) {', legacyStart);
    const legacyBlock = source.slice(legacyStart, legacyEnd);
    assert.doesNotMatch(legacyBlock, /registerFacturaLoyaltyAccumulation\(/);
    const commitIndex = legacyBlock.indexOf("await client.query('COMMIT');");
    const jsonIndex = legacyBlock.indexOf('res.status(201).json(createVentaResponse);');
    const deferredIndex = legacyBlock.indexOf('registerVentaFidelizacionAfterCommit(');
    assert.ok(commitIndex > -1 && jsonIndex > -1 && deferredIndex > -1);
    assert.ok(commitIndex < jsonIndex);
    assert.ok(jsonIndex < deferredIndex);
  });
});

describe('Comportamiento real de registerVentaFidelizacionAfterCommit (pool simulado, sin red/DB real)', () => {
  it('venta inmediata: acumula en su propia transaccion y hace COMMIT', async () => {
    const { client, state } = createFidelizacionMockClient();
    let released = false;
    const originalRelease = client.release;
    client.release = () => { released = true; if (originalRelease) originalRelease(); };

    await withMockedPoolConnect(async () => client, async () => {
      await registerVentaFidelizacionAfterCommit({
        idFactura: 701,
        idPedido: null,
        idCliente: 5,
        idSucursal: 1,
        idUsuarioEjecutor: 9,
        montoFactura: 300
      });
    });

    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.includes('BEGIN'));
    assert.ok(sqlCalls.includes('COMMIT'));
    assert.ok(!sqlCalls.includes('ROLLBACK'));
    assert.equal(state.movimientos.length, 1);
    assert.equal(released, true);
  });

  it('fallo simulado de fidelizacion: hace ROLLBACK de su propia transaccion y NUNCA propaga el error', async () => {
    const { client, state } = createFidelizacionMockClient({
      failOn: 'FROM public.fidelizacion_configuracion_sucursal'
    });
    let released = false;
    const originalRelease = client.release;
    client.release = () => { released = true; if (originalRelease) originalRelease(); };

    await withMockedPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        registerVentaFidelizacionAfterCommit({
          idFactura: 702,
          idPedido: null,
          idCliente: 5,
          idSucursal: 1,
          idUsuarioEjecutor: 9,
          montoFactura: 300
        }),
        'un fallo de fidelizacion nunca debe propagarse al llamador'
      );
    });

    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.includes('BEGIN'));
    assert.ok(sqlCalls.includes('ROLLBACK'));
    assert.ok(!sqlCalls.includes('COMMIT'));
    assert.equal(state.movimientos.length, 0);
    assert.equal(released, true, 'el cliente debe liberarse incluso si fidelizacion falla');
  });

  it('factura ya acumulada: la llamada diferida es idempotente y no duplica el movimiento', async () => {
    const { client, state } = createFidelizacionMockClient({
      movimientos: [{ id_movimiento: 1, id_factura: 703, tipo: 'ACUMULACION', origen: 'FACTURA' }]
    });

    await withMockedPoolConnect(async () => client, async () => {
      await registerVentaFidelizacionAfterCommit({
        idFactura: 703,
        idCliente: 5,
        idSucursal: 1,
        montoFactura: 300
      });
    });

    assert.equal(state.movimientos.length, 1, 'no debe insertar un segundo movimiento');
    assert.ok(state.calls.map((c) => c.sql).includes('COMMIT'));
  });
});
