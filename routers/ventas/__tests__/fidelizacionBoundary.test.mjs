import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

const getVentasSource = async () => readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

const getHandlerBlock = (source, routeMarker) => {
  const start = source.indexOf(routeMarker);
  assert.notEqual(start, -1, `No se encontro el handler "${routeMarker}"`);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1, `No se encontro el cierre del handler "${routeMarker}"`);
  return source.slice(start, end);
};

describe('Frontera Ventas -> Fidelizacion (modules/fidelizacion)', () => {
  it('Ventas importa notifyPaidInvoice desde el modulo de fidelizacion, no el servicio directo', async () => {
    const source = await getVentasSource();
    assert.match(source, /import \{ notifyPaidInvoice \} from '\.\.\/modules\/fidelizacion\/index\.js';/);
    assert.doesNotMatch(source, /from '\.\.\/services\/fidelizacionService\.js'/);
  });

  it('No existe registerFacturaLoyaltyAccumulation dentro de routers/ventas.js', async () => {
    const source = await getVentasSource();
    assert.doesNotMatch(source, /registerFacturaLoyaltyAccumulation/);
  });

  it('No existe pool.connect ni advisory lock de fidelizacion dentro de routers/ventas.js', async () => {
    const source = await getVentasSource();
    assert.doesNotMatch(source, /pg_advisory_xact_lock/);
    assert.doesNotMatch(source, /VENTAS_FIDELIZACION_ADVISORY_LOCK_CLASS/);
    assert.doesNotMatch(source, /registerVentaFidelizacionAfterCommit/);
  });

  it('Ventas solo notifica el id_factura: cada llamada a notifyPaidInvoice pasa un unico campo idFactura', async () => {
    const source = await getVentasSource();
    const calls = [...source.matchAll(/notifyPaidInvoice\(\{([^}]*)\}\)/g)];
    assert.ok(calls.length >= 5, 'se esperaban al menos 5 puntos de notificacion (legado x2, RPC v1/v2/v3)');
    for (const call of calls) {
      const argsText = call[1].trim();
      assert.match(argsText, /^idFactura(:\s*[\w.?]+)?$/, `argumento inesperado en notifyPaidInvoice: "${argsText}"`);
    }
  });

  it('Toda llamada a notifyPaidInvoice queda protegida con .catch(() => undefined)', async () => {
    const source = await getVentasSource();
    const guarded = [...source.matchAll(/notifyPaidInvoice\(\{[^}]*\}\)(\.catch\(\(\) => undefined\))?/g)];
    assert.ok(guarded.length >= 5);
    for (const match of guarded) {
      assert.ok(match[1], `falta .catch(() => undefined) en: ${match[0]}`);
    }
  });

  it('Pago dividido incompleto no notifica; pago completo si notifica', async () => {
    const source = await getVentasSource();
    const handler = getHandlerBlock(source, "router.post('/ventas/pedidos/:id/registrar-pago'");
    assert.match(
      handler,
      /if \(pedidoPagadoCompleto\) \{\s*void notifyPaidInvoice\(\{ idFactura \}\)\.catch\(\(\) => undefined\);\s*\}/,
      'la notificacion debe quedar condicionada a pago completo'
    );
  });

  it('POST /ventas/pedidos/:id/registrar-pago notifica despues del COMMIT y de responder', async () => {
    const source = await getVentasSource();
    const handler = getHandlerBlock(source, "router.post('/ventas/pedidos/:id/registrar-pago'");
    const commitIndex = handler.indexOf("await client.query('COMMIT');");
    const jsonIndex = handler.indexOf('res.status(201).json(');
    const notifyIndex = handler.indexOf('notifyPaidInvoice(');
    assert.ok(commitIndex > -1 && jsonIndex > -1 && notifyIndex > -1);
    assert.ok(commitIndex < jsonIndex);
    assert.ok(jsonIndex < notifyIndex);
  });

  it('POST /ventas (venta directa legado) notifica despues del COMMIT y de responder', async () => {
    const source = await getVentasSource();
    const legacyStart = source.indexOf('const correlativoStart = ventasPerf.now();');
    assert.notEqual(legacyStart, -1, 'No se localizo el inicio del flujo legado de creacion de venta.');
    const legacyEnd = source.indexOf('} catch (err) {', legacyStart);
    const legacyBlock = source.slice(legacyStart, legacyEnd);
    assert.doesNotMatch(legacyBlock, /registerFacturaLoyaltyAccumulation\(/);
    const commitIndex = legacyBlock.indexOf("await client.query('COMMIT');");
    const jsonIndex = legacyBlock.indexOf('res.status(201).json(createVentaResponse);');
    const notifyIndex = legacyBlock.indexOf('notifyPaidInvoice(');
    assert.ok(commitIndex > -1 && jsonIndex > -1 && notifyIndex > -1);
    assert.ok(commitIndex < jsonIndex);
    assert.ok(jsonIndex < notifyIndex);
  });
});
