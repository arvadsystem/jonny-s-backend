import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyPaidInvoice, reservePaidInvoiceAccumulation } from '../../../modules/fidelizacion/index.js';
import { fidelizacionPool } from '../../../modules/fidelizacion/infrastructure/fidelizacionPool.js';

const getVentasSource = async () => readFile(new URL('../../ventas.js', import.meta.url), 'utf8');

// Recorre todo routers/ (incluyendo routers/ventas/services/*, excluyendo
// __tests__) para auditar que ningun OTRO archivo, ademas de ventas.js y sus
// propios helpers ya cubiertos, pueda dejar una factura completamente
// pagada sin pasar por el mismo disparador. Si algun dia se agrega un canal
// de pago nuevo (webhook, callback de proveedor, etc.) que escriba estas
// tablas directamente, esta prueba debe fallar hasta que se conecte a
// notifyPaidInvoice.
const listSourceFilesRecursive = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFilesRecursive(fullPath));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.mjs')) {
      files.push(fullPath);
    }
  }
  return files;
};

const getHandlerBlock = (source, routeMarker) => {
  const start = source.indexOf(routeMarker);
  assert.notEqual(start, -1, `No se encontro el handler "${routeMarker}"`);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1, `No se encontro el cierre del handler "${routeMarker}"`);
  return source.slice(start, end);
};

describe('Frontera Ventas -> Fidelizacion (modules/fidelizacion)', () => {
  it('Ventas importa la frontera del modulo de fidelizacion, no el servicio directo', async () => {
    const source = await getVentasSource();
    assert.match(source, /import \{ notifyPaidInvoice, reservePaidInvoiceAccumulation \} from '\.\.\/modules\/fidelizacion\/index\.js';/);
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

  it('Ventas nunca importa ni usa el pool dedicado de fidelizacion', async () => {
    const source = await getVentasSource();
    assert.doesNotMatch(source, /fidelizacionPool/);
    assert.doesNotMatch(source, /infrastructure\/fidelizacionPool/);
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

  it('modules/fidelizacion/index.js expone publicamente solo la reserva y la notificacion', async () => {
    const moduleIndex = await import('../../../modules/fidelizacion/index.js');
    assert.deepEqual(Object.keys(moduleIndex).sort(), ['notifyPaidInvoice', 'reservePaidInvoiceAccumulation']);
  });

  it('respuesta 201 aunque notifyPaidInvoice falle: la respuesta ya se envio antes de que la notificacion resuelva o rechace', async () => {
    const originalConnect = fidelizacionPool.connect;
    fidelizacionPool.connect = async () => { throw new Error('FIDELIZACION_DB_DOWN'); };

    const res = {
      statusCode: null,
      body: null,
      sent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        this.sent = true;
        return this;
      }
    };

    try {
      // Reproduce exactamente el patron usado en routers/ventas.js: primero
      // se responde, despues se notifica sin esperar ni afectar la respuesta.
      res.status(201).json({ id_factura: 123, fidelizacion: null });
      assert.equal(res.sent, true);
      assert.equal(res.statusCode, 201);

      let notifyOutcome = 'pending';
      const notifyPromise = notifyPaidInvoice({ idFactura: 123 })
        .then(() => { notifyOutcome = 'resolved'; })
        .catch(() => { notifyOutcome = 'caught'; });

      // La respuesta ya quedo enviada independientemente de lo que haga la notificacion.
      assert.equal(res.sent, true);
      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.body, { id_factura: 123, fidelizacion: null });

      await notifyPromise;
      assert.equal(notifyOutcome, 'resolved', 'notifyPaidInvoice nunca debe rechazar, incluso con la DB caida');
      assert.equal(res.statusCode, 201, 'la respuesta ya enviada no debe alterarse por el resultado de la notificacion');
    } finally {
      fidelizacionPool.connect = originalConnect;
    }
  });

  it('durabilidad: los 5 flujos completamente pagados reservan ANTES de su COMMIT y notifican DESPUES', async () => {
    const source = await getVentasSource();

    // Cada reserva debe quedar emparejada con un COMMIT posterior y, mas
    // adelante, con su notificacion. Se recorre el archivo en orden.
    const eventos = [...source.matchAll(/reservePaidInvoiceAccumulation\(\{|await client\.query\('COMMIT'\)|notifyPaidInvoice\(\{/g)]
      .map((m) => (m[0].startsWith('reserve') ? 'RESERVA' : m[0].includes('COMMIT') ? 'COMMIT' : 'NOTIFY'));

    const reservas = eventos.filter((e) => e === 'RESERVA').length;
    assert.equal(reservas, 5, 'deben existir exactamente 5 reservas: registrar-pago + venta directa (RPC v1/v2/v3 y legado)');

    // Para cada RESERVA debe haber un COMMIT despues y luego un NOTIFY.
    for (let i = 0; i < eventos.length; i += 1) {
      if (eventos[i] !== 'RESERVA') continue;
      const resto = eventos.slice(i + 1);
      const commitIdx = resto.indexOf('COMMIT');
      const notifyIdx = resto.indexOf('NOTIFY');
      assert.notEqual(commitIdx, -1, `la reserva #${i} debe ir seguida de un COMMIT`);
      assert.notEqual(notifyIdx, -1, `la reserva #${i} debe ir seguida de una notificacion`);
      assert.ok(commitIdx < notifyIdx, `la reserva #${i} debe confirmarse (COMMIT) antes de notificar`);
    }
  });

  it('durabilidad: toda reserva usa el client de la transaccion financiera y solo el id_factura', async () => {
    const source = await getVentasSource();
    const calls = [...source.matchAll(/reservePaidInvoiceAccumulation\(\{([^}]*)\}\)/g)];
    assert.equal(calls.length, 5);
    for (const call of calls) {
      const args = call[1].trim();
      assert.match(
        args,
        /^client,\s*idFactura(:\s*[\w.?]+)?$/,
        `la reserva debe recibir el client financiero y solo el id_factura: "${args}"`
      );
    }
  });

  it('durabilidad: la reserva se hace con await (dentro de la transaccion), la notificacion sigue siendo fire-and-forget', async () => {
    const source = await getVentasSource();
    // La reserva NO puede ser fire-and-forget: debe completarse antes del COMMIT.
    const sinAwait = [...source.matchAll(/(^|[^\w.])(?<!await )reservePaidInvoiceAccumulation\(/gm)];
    assert.equal(sinAwait.length, 0, 'toda reserva debe ejecutarse con await antes del COMMIT');
    assert.doesNotMatch(source, /void reservePaidInvoiceAccumulation/, 'la reserva nunca debe ser fire-and-forget');
  });

  it('pago parcial en registrar-pago: no reserva ni notifica (ambos bajo el mismo guard)', async () => {
    const source = await getVentasSource();
    const handler = getHandlerBlock(source, "router.post('/ventas/pedidos/:id/registrar-pago'");

    const reservaIdx = handler.indexOf('reservePaidInvoiceAccumulation(');
    const guardIdx = handler.lastIndexOf('if (pedidoPagadoCompleto) {', reservaIdx);
    assert.notEqual(guardIdx, -1, 'la reserva debe estar dentro de un bloque if (pedidoPagadoCompleto)');
    // El unico codigo entre el guard y la reserva es la confirmacion legada del pedido.
    const entreGuardYReserva = handler.slice(guardIdx, reservaIdx);
    assert.doesNotMatch(entreGuardYReserva, /\n\s*\}/, 'la reserva no debe quedar fuera del bloque del guard');
  });

  it('respuesta 201 intacta aunque la reserva falle: reservePaidInvoiceAccumulation nunca lanza', async () => {
    // Contrato ejecutable (no regex): con un client que falla en TODA
    // consulta, la reserva resuelve sin lanzar, de modo que la transaccion
    // financiera puede continuar hacia su COMMIT y su 201.
    const clientQueRompe = {
      query: async () => { throw new Error('FALLA_TOTAL_DE_LA_RESERVA'); }
    };

    let outcome;
    await assert.doesNotReject(
      (async () => { outcome = await reservePaidInvoiceAccumulation({ client: clientQueRompe, idFactura: 123 }); })(),
      'la reserva nunca debe propagar un error hacia la transaccion de Ventas'
    );
    assert.equal(outcome.reserved, false);
    assert.equal(outcome.reason, 'SAVEPOINT_ERROR');
  });

  it('multicanal: ningun archivo de routers/ fuera de ventas.js crea una factura (INSERT INTO public.facturas)', async () => {
    const routersDir = fileURLToPath(new URL('../../../routers', import.meta.url));
    const files = await listSourceFilesRecursive(routersDir);
    assert.ok(files.length > 5, 'la lista de archivos de routers/ parece incompleta');

    const offenders = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      // Nota: en routers/ventas.js la tabla se referencia sin el prefijo
      // "public." (INSERT INTO facturas (...)); el \s*\( al final excluye
      // deliberadamente facturas_cobros/facturas_reversiones_intentos.
      if (/INSERT INTO (?:public\.)?facturas\s*\(/.test(source)) {
        offenders.push(path.relative(routersDir, file));
      }
    }

    assert.deepEqual(
      offenders,
      ['ventas.js'],
      `solo routers/ventas.js debe crear facturas; si se agrego un canal de pago nuevo (${offenders.filter((f) => f !== 'ventas.js').join(', ')}), debe conectarse a notifyPaidInvoice antes de crear facturas ahi`
    );
  });

  it('multicanal: ningun archivo de routers/ fuera de ventas.js (y sus propios helpers) escribe PAGADO_CONFIRMADO/monto_pendiente=0', async () => {
    const routersDir = fileURLToPath(new URL('../../../routers', import.meta.url));
    const files = await listSourceFilesRecursive(routersDir);

    // Los helpers de routers/ventas/services/*.js (p.ej. persistImmediateSalePaymentState,
    // ventaImmediatePaymentStateService.js) SI referencian PAGADO_CONFIRMADO/monto_pendiente=0,
    // pero solo son invocados desde dentro de routers/ventas.js (los 5 puntos
    // ya cubiertos arriba, verificados en el propio archivo). Se permiten
    // explicitamente porque son parte del mismo modulo de Ventas, no un
    // canal de pago independiente.
    const allowedDirs = ['ventas.js', `ventas${path.sep}`];

    const offenders = [];
    for (const file of files) {
      const relative = path.relative(routersDir, file);
      if (allowedDirs.some((allowed) => relative === allowed || relative.startsWith(allowed))) continue;
      const source = await readFile(file, 'utf8');
      if (/PAGADO_CONFIRMADO/.test(source) && /(UPDATE|INSERT)/.test(source)) {
        offenders.push(relative);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `ningun canal fuera de Ventas debe escribir PAGADO_CONFIRMADO directamente; conectar a notifyPaidInvoice: ${offenders.join(', ')}`
    );
  });

  it('POST /ventas/pedidos-menu/:id/confirmar-pago NO llama a notifyPaidInvoice: no es un punto de facturacion (solo gate previo a cocina)', async () => {
    const source = await getVentasSource();
    const handler = getHandlerBlock(source, "router.post('/ventas/pedidos-menu/:id/confirmar-pago'");
    // Confirmar-pago solo actualiza pedidos.estado_pago (columna legada,
    // usada como gate para permitir que el pedido pase a cocina) -nunca
    // crea una factura ni toca pedidos_pago_control-. La factura real (y
    // la notificacion a fidelizacion) se genera despues, cuando el pedido
    // se cobra de verdad via registrar-pago (mismo endpoint generico que
    // ya usan tanto los pedidos pendientes del POS como los del menu
    // publico, porque ambos crean su propia fila de pedidos_pago_control
    // al ser creados).
    assert.doesNotMatch(handler, /notifyPaidInvoice/, 'confirmar-pago no debe notificar: todavia no existe una factura que acumule puntos');
    assert.doesNotMatch(handler, /INSERT INTO public\.facturas/, 'confirmar-pago nunca crea una factura');
    assert.doesNotMatch(handler, /pedidos_pago_control/, 'confirmar-pago nunca toca pedidos_pago_control');
  });
});
