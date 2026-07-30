import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import { FACTURA_REFERENCE_INSTANT_SQL } from '../infrastructure/fidelizacionRepository.js';
import {
  createFidelizacionMockClient,
  nakedTimestampToInstant,
  zoneAppliedBySql
} from './fidelizacionMockClient.mjs';

// ---------------------------------------------------------------------------
// Defecto confirmado en QA: VTA-00004 (id_factura 230) quedo SKIPPED_TERMINAL
// con motivo ACCUMULATION_DISABLED aunque cumplia todas las condiciones.
// ---------------------------------------------------------------------------
// Causa: facturas.fecha_hora_facturacion (y pedidos_pago_control.fecha_pago_confirmado)
// son `timestamp without time zone` que guardan HORA LOCAL DE HONDURAS, mientras
// que fidelizacion_configuracion_sucursal.vigente_desde/vigente_hasta -tambien
// `timestamp without time zone`- guardan HORA UTC. Al compararlos sin declarar
// zona, PostgreSQL interpretaba la hora local de la factura como si fuera UTC:
//
//   activacion de la config : 11:43:52 Honduras = 17:43:52 UTC  (guardado 17:43:52)
//   pago de la factura      : 12:08:57 Honduras = 18:08:57 UTC  (guardado 12:08:57)
//
//   comparacion defectuosa  : 12:08:57 < 17:43:52  -> config historica (desactivada)
//   comparacion correcta    : 18:08:57 > 17:43:52  -> config activa
//
// Estas pruebas NO son aserciones de texto sobre el SQL. El mock de PostgreSQL
// (fidelizacionMockClient.mjs) reproduce la semantica real de
// `timestamp without time zone` y deduce la zona a aplicar del TEXTO SQL REAL
// que emite el codigo de produccion: si se quitara el
// `AT TIME ZONE 'America/Tegucigalpa'` del repositorio, el mock volveria a
// interpretar la hora local como UTC -igual que PostgreSQL- y estas pruebas
// fallarian. Ver la prueba "sensibilidad" al final, que lo demuestra.

// Instantes reales del caso de QA.
const INSTANTE_ACTIVACION_UTC = '2026-07-28T17:43:52.000Z'; // 11:43:52 Honduras
const INSTANTE_FACTURA_UTC = '2026-07-28T18:08:57.000Z'; // 12:08:57 Honduras

// Lo que fisicamente hay guardado en cada columna sin zona.
const VIGENTE_DESDE_GUARDADO_UTC = '2026-07-28 17:43:52';
const FACTURA_GUARDADA_LOCAL = '2026-07-28 12:08:57';

const CONFIG_ANTERIOR_DESACTIVADA = {
  id_configuracion: 1,
  lempiras_por_punto: 100,
  acumulacion_habilitada: false,
  vigente_desde_naked: '2026-07-01 00:00:00',
  vigente_hasta_naked: VIGENTE_DESDE_GUARDADO_UTC,
  estado: false
};

const CONFIG_ACTIVA = {
  id_configuracion: 2,
  lempiras_por_punto: 100,
  acumulacion_habilitada: true,
  vigente_desde_naked: VIGENTE_DESDE_GUARDADO_UTC,
  vigente_hasta_naked: null,
  estado: true
};

// Contexto de la factura real de QA (VTA-00004).
const buildFacturaVta00004 = (overrides = {}) => ({
  id_pedido: 252,
  id_sucursal: 1,
  id_usuario: 9,
  id_cliente: 2956,
  monto_factura: 1130,
  tiene_pago_control: true,
  pago_control_monto_pendiente: 0,
  pago_control_estado_codigo: 'PAGADO_CONFIRMADO',
  fecha_referencia_local_naked: FACTURA_GUARDADA_LOCAL,
  ...overrides
});

const withMockedFidelizacionPoolConnect = async (client, run) => {
  const originalConnect = fidelizacionPool.connect;
  fidelizacionPool.connect = async () => client;
  try {
    return await run();
  } finally {
    fidelizacionPool.connect = originalConnect;
  }
};

const runAccumulation = async ({ idFactura, facturaContexts, activeConfigs, estadoFacturasIniciales }) => {
  const { client, state } = createFidelizacionMockClient({
    activeConfig: null,
    activeConfigs,
    facturaContexts,
    estadoFacturasIniciales: estadoFacturasIniciales || {}
  });
  const result = await withMockedFidelizacionPoolConnect(client, () => accumulateInvoicePoints({ idFactura }));
  return { result, state };
};

describe('Fidelizacion / vigencia por zona horaria: la fecha local de factura se compara como instante real', () => {
  // 12.1 + 12.3 + Caso F
  it('CASO QA (VTA-00004): venta 12:08:57 Honduras con config activada 11:43:52 Honduras -> acumula, no ACCUMULATION_DISABLED', async () => {
    const { result, state } = await runAccumulation({
      idFactura: 230,
      facturaContexts: { 230: buildFacturaVta00004() },
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA]
    });

    assert.notEqual(result.reason, 'ACCUMULATION_DISABLED', 'el defecto original devolvia exactamente este motivo');
    assert.equal(result.created, true);
    // Tasa 100, total L 1,130.00 -> floor(1130 / 100) = 11 puntos.
    assert.equal(result.points, 11);

    // Movimiento ACUMULACION con origen FACTURA y saldo incrementado en 11.
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.movimientos[0].id_factura, 230);
    assert.equal(state.movimientos[0].tipo, 'ACUMULACION');
    assert.equal(state.movimientos[0].origen, 'FACTURA');
    assert.equal(state.saldos.get(2956).puntos_disponibles, 11);

    // Estado durable PROCESSED, no SKIPPED_TERMINAL.
    assert.equal(state.estadoFacturas.get(230).estado, 'PROCESSED');
  });

  // 12.2 + Caso B
  it('venta ANTERIOR a la activacion (11:30 Honduras = 17:30 UTC): usa la config historica desactivada -> ACCUMULATION_DISABLED', async () => {
    const { result, state } = await runAccumulation({
      idFactura: 231,
      facturaContexts: {
        231: buildFacturaVta00004({ fecha_referencia_local_naked: '2026-07-28 11:30:00' })
      },
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA]
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_DISABLED');
    assert.equal(state.movimientos.length, 0);
  });

  // 12.4
  it('limite INCLUSIVO: una factura cuyo instante es exactamente vigente_desde ya usa la config nueva', async () => {
    // 11:43:52 Honduras == 17:43:52 UTC == vigente_desde exacto.
    const { result } = await runAccumulation({
      idFactura: 232,
      facturaContexts: {
        232: buildFacturaVta00004({ fecha_referencia_local_naked: '2026-07-28 11:43:52' })
      },
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA]
    });

    assert.equal(result.created, true, 'vigente_desde es inclusivo (<=)');
    assert.equal(result.points, 11);
  });

  // 12.5
  it('limite EXCLUSIVO: una factura cuyo instante es exactamente vigente_hasta ya NO usa esa config', async () => {
    // Solo existe la config anterior, que termina exactamente en 17:43:52 UTC.
    // Una factura en ese instante exacto no debe encontrar configuracion.
    const { result, state } = await runAccumulation({
      idFactura: 233,
      facturaContexts: {
        233: buildFacturaVta00004({ fecha_referencia_local_naked: '2026-07-28 11:43:52' })
      },
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA]
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CONFIG_NOT_FOUND', 'vigente_hasta es exclusivo (>)');
    assert.equal(state.movimientos.length, 0);
  });

  // 12.6
  it('snapshot durable: fecha_referencia se guarda como el instante real 18:08:57Z, no como 12:08:57Z', async () => {
    const { state } = await runAccumulation({
      idFactura: 234,
      facturaContexts: { 234: buildFacturaVta00004() },
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA]
    });

    const fila = state.estadoFacturas.get(234);
    assert.ok(fila.fecha_referencia, 'la fila durable debe conservar la fecha de referencia');
    assert.equal(new Date(fila.fecha_referencia).toISOString(), INSTANTE_FACTURA_UTC);
    assert.notEqual(new Date(fila.fecha_referencia).toISOString(), '2026-07-28T12:08:57.000Z');
  });

  // 12.7
  it('sin doble conversion: una fecha que ya llega como instante (18:08:57Z) permanece igual, no se corre a 00:08:57Z', async () => {
    const { state, result } = await runAccumulation({
      idFactura: 235,
      facturaContexts: {
        // Sin `fecha_referencia_local_naked`: la fecha ya es un instante.
        235: buildFacturaVta00004({
          fecha_referencia_local_naked: undefined,
          fecha_referencia_config: INSTANTE_FACTURA_UTC
        })
      },
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA]
    });

    assert.equal(result.created, true);
    const guardada = new Date(state.estadoFacturas.get(235).fecha_referencia).toISOString();
    assert.equal(guardada, INSTANTE_FACTURA_UTC);
    assert.notEqual(guardada, '2026-07-29T00:08:57.000Z', 'sintoma clasico de aplicar el offset dos veces');
  });

  // 12.9 + Caso E
  it('un SKIPPED_TERMINAL previo (como la factura 230 real) NO se reabre ni recibe puntos retroactivos', async () => {
    const { result, state } = await runAccumulation({
      idFactura: 230,
      facturaContexts: { 230: buildFacturaVta00004() },
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA],
      estadoFacturasIniciales: {
        230: { estado: 'SKIPPED_TERMINAL', motivo: 'ACCUMULATION_DISABLED', elegibilidad_determinada: true }
      }
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_DISABLED');
    assert.equal(state.movimientos.length, 0, 'no se otorgan puntos retroactivos');
    assert.equal(state.estadoFacturas.get(230).estado, 'SKIPPED_TERMINAL', 'el estado terminal permanece intacto');
    assert.equal(state.saldos.size, 0, 'ningun saldo se toca');
  });

  // 12.9 (idempotencia)
  it('idempotencia por id_factura: una segunda ejecucion sobre una factura ya procesada no duplica el movimiento', async () => {
    const facturaContexts = { 236: buildFacturaVta00004() };
    const { client, state } = createFidelizacionMockClient({
      activeConfig: null,
      activeConfigs: [CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA],
      facturaContexts
    });

    await withMockedFidelizacionPoolConnect(client, async () => {
      const primero = await accumulateInvoicePoints({ idFactura: 236 });
      assert.equal(primero.created, true);
      const segundo = await accumulateInvoicePoints({ idFactura: 236 });
      assert.equal(segundo.created, false);
      assert.equal(segundo.reason, 'ALREADY_REGISTERED');
    });

    assert.equal(state.movimientos.length, 1, 'un unico movimiento por id_factura');
    assert.equal(state.saldos.get(2956).puntos_disponibles, 11);
  });
});

describe('Fidelizacion / vigencia por zona horaria: regresiones del flujo de acumulacion', () => {
  // 12.10
  it('factura no pagada por completo (monto pendiente > 0) sigue sin acumular', async () => {
    const { result, state } = await runAccumulation({
      idFactura: 240,
      facturaContexts: {
        240: buildFacturaVta00004({ pago_control_monto_pendiente: 500 })
      },
      activeConfigs: [CONFIG_ACTIVA]
    });

    assert.equal(result.created, false);
    assert.equal(state.movimientos.length, 0);
  });

  it('factura sin cliente sigue devolviendo MISSING_REQUIRED_DATA', async () => {
    const { result } = await runAccumulation({
      idFactura: 241,
      facturaContexts: {
        241: buildFacturaVta00004({ id_cliente: null, id_pedido: null })
      },
      activeConfigs: [CONFIG_ACTIVA]
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'MISSING_REQUIRED_DATA');
  });

  it('sin ninguna configuracion vigente sigue devolviendo CONFIG_NOT_FOUND', async () => {
    const { result } = await runAccumulation({
      idFactura: 242,
      facturaContexts: { 242: buildFacturaVta00004() },
      activeConfigs: []
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CONFIG_NOT_FOUND');
  });

  it('perfil de cliente incompleto sigue siendo un skip de negocio, no un error tecnico', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfig: null,
      activeConfigs: [CONFIG_ACTIVA],
      facturaContexts: { 243: buildFacturaVta00004({ id_cliente: 777 }) },
      clienteProfiles: { 777: { estado: true, nombre: 'Sin Telefono', telefono: null } }
    });

    const result = await withMockedFidelizacionPoolConnect(client, () => accumulateInvoicePoints({ idFactura: 243 }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.movimientos.length, 0);
  });

  it('cuenta dividida: cada factura calcula sus puntos con SU propio monto (floor individual), no con el total del pedido', async () => {
    // Dos facturas del MISMO pedido: 150 y 150 con tasa 100 -> 1 + 1 = 2 puntos,
    // nunca floor(300/100) = 3. La regla de redondeo por factura no cambia.
    const { client, state } = createFidelizacionMockClient({
      activeConfig: null,
      activeConfigs: [CONFIG_ACTIVA],
      facturaContexts: {
        244: buildFacturaVta00004({ monto_factura: 150 }),
        245: buildFacturaVta00004({ monto_factura: 150 })
      }
    });

    await withMockedFidelizacionPoolConnect(client, async () => {
      const a = await accumulateInvoicePoints({ idFactura: 244 });
      const b = await accumulateInvoicePoints({ idFactura: 245 });
      assert.equal(a.points, 1);
      assert.equal(b.points, 1);
    });

    assert.equal(state.saldos.get(2956).puntos_disponibles, 2);
  });
});

describe('Fidelizacion / vigencia por zona horaria: la conversion no depende del TZ del proceso', () => {
  // 12.8 + Casos C y D
  const buildChildScript = () => {
    const poolUrl = new URL('../infrastructure/fidelizacionPool.js', import.meta.url).href;
    const accumulateUrl = new URL('../application/accumulateInvoicePoints.js', import.meta.url).href;
    const mockUrl = new URL('./fidelizacionMockClient.mjs', import.meta.url).href;

    return `
      (async () => {
        const { fidelizacionPool } = await import(${JSON.stringify(poolUrl)});
        const { accumulateInvoicePoints } = await import(${JSON.stringify(accumulateUrl)});
        const { createFidelizacionMockClient } = await import(${JSON.stringify(mockUrl)});

        const { client, state } = createFidelizacionMockClient({
          activeConfig: null,
          activeConfigs: ${JSON.stringify([CONFIG_ANTERIOR_DESACTIVADA, CONFIG_ACTIVA])},
          facturaContexts: { 230: ${JSON.stringify(buildFacturaVta00004())} }
        });

        fidelizacionPool.connect = async () => client;
        const result = await accumulateInvoicePoints({ idFactura: 230 });
        const fila = state.estadoFacturas.get(230);

        console.log('RESULT_JSON:' + JSON.stringify({
          tz: process.env.TZ || null,
          created: result.created,
          reason: result.reason || null,
          points: result.points ?? null,
          fechaReferencia: fila && fila.fecha_referencia
            ? new Date(fila.fecha_referencia).toISOString()
            : null
        }));
      })().catch((error) => {
        console.log('RESULT_JSON:' + JSON.stringify({ error: String(error && error.message || error) }));
      });
    `;
  };

  const runUnderTimeZone = (timeZone) => {
    const child = spawnSync(
      process.execPath,
      ['-e', buildChildScript()],
      { env: { ...process.env, TZ: timeZone }, encoding: 'utf8', timeout: 60000 }
    );

    const line = String(child.stdout || '')
      .split(/\r?\n/)
      .find((row) => row.startsWith('RESULT_JSON:'));

    assert.ok(line, `el proceso hijo (TZ=${timeZone}) no produjo resultado. stderr: ${child.stderr}`);
    return JSON.parse(line.slice('RESULT_JSON:'.length));
  };

  it('TZ=UTC y TZ=America/Tegucigalpa producen el MISMO instante y el MISMO resultado de acumulacion', () => {
    const enUtc = runUnderTimeZone('UTC');
    const enHonduras = runUnderTimeZone('America/Tegucigalpa');

    for (const [etiqueta, salida] of [['UTC', enUtc], ['America/Tegucigalpa', enHonduras]]) {
      assert.equal(salida.error, undefined, `fallo bajo TZ=${etiqueta}: ${salida.error}`);
      assert.equal(salida.created, true, `no acumulo bajo TZ=${etiqueta}`);
      assert.equal(salida.points, 11, `puntos incorrectos bajo TZ=${etiqueta}`);
      assert.equal(salida.fechaReferencia, INSTANTE_FACTURA_UTC, `instante incorrecto bajo TZ=${etiqueta}`);
    }

    assert.equal(enUtc.fechaReferencia, enHonduras.fechaReferencia);
    assert.equal(enUtc.points, enHonduras.points);
  });
});

describe('Fidelizacion / vigencia por zona horaria: contrato del punto canonico de conversion', () => {
  it('existe UN solo fragmento canonico y las tres consultas de acumulacion lo reutilizan', async () => {
    const source = await readFile(new URL('../infrastructure/fidelizacionRepository.js', import.meta.url), 'utf8');

    assert.match(FACTURA_REFERENCE_INSTANT_SQL, /AT TIME ZONE 'America\/Tegucigalpa'/);
    assert.match(FACTURA_REFERENCE_INSTANT_SQL, /COALESCE\(upc\.fecha_pago_confirmado, f\.fecha_hora_facturacion\)/);

    // Ninguna consulta arma la fecha de referencia por su cuenta: todas
    // interpolan la constante canonica.
    const interpolaciones = [...source.matchAll(/\$\{FACTURA_REFERENCE_INSTANT_SQL\}/g)];
    assert.equal(interpolaciones.length, 4, 'contexto LIVE, snapshot durable, candidatos y periodo de gracia');

    const construccionesCrudas = [...source.matchAll(
      /COALESCE\(upc\.fecha_pago_confirmado, f\.fecha_hora_facturacion\)(?! AT TIME ZONE)/g
    )];
    assert.equal(construccionesCrudas.length, 0, 'no debe quedar ninguna construccion sin declarar la zona');
  });

  it('getActiveFidelizacionConfig declara la zona de vigente_desde/vigente_hasta y conserva inclusivo/exclusivo', async () => {
    const source = await readFile(new URL('../../../services/fidelizacionService.js', import.meta.url), 'utf8');
    const inicio = source.indexOf('export const getActiveFidelizacionConfig');
    const fin = source.indexOf('const ensureSaldoRow', inicio);
    const bloque = source.slice(inicio, fin);

    assert.match(bloque, /\(fcs\.vigente_desde AT TIME ZONE 'UTC'\) <= COALESCE\(\$2::timestamptz, NOW\(\)\)/);
    assert.match(bloque, /\(fcs\.vigente_hasta AT TIME ZONE 'UTC'\) > COALESCE\(\$2::timestamptz, NOW\(\)\)/);
    // Nunca se resta un intervalo fijo a mano.
    assert.doesNotMatch(bloque, /interval '6 hours'/i);
  });

  it('no existe ningun ajuste manual de 6 horas en JavaScript ni en SQL de fidelizacion', async () => {
    const archivos = [
      new URL('../infrastructure/fidelizacionRepository.js', import.meta.url),
      new URL('../application/accumulateInvoicePoints.js', import.meta.url),
      new URL('../application/reservePaidInvoiceAccumulation.js', import.meta.url),
      new URL('../../../services/fidelizacionService.js', import.meta.url)
    ];

    for (const archivo of archivos) {
      const source = await readFile(archivo, 'utf8');
      assert.doesNotMatch(source, /getHours\(\)\s*\+\s*6/, `ajuste manual en ${archivo.pathname}`);
      assert.doesNotMatch(source, /setHours\([^)]*\+\s*6/, `ajuste manual en ${archivo.pathname}`);
      assert.doesNotMatch(source, /interval\s+'6 hours'/i, `ajuste manual en ${archivo.pathname}`);
    }
  });

  // Sensibilidad: demuestra que las pruebas de arriba SI dependen de que el SQL
  // real declare la zona -no pasarian igual con el codigo anterior al arreglo-.
  it('sensibilidad: con el SQL real la factura vale 18:08:57Z; con el SQL anterior (sin AT TIME ZONE) valdria 12:08:57Z', () => {
    const sqlCorregido = FACTURA_REFERENCE_INSTANT_SQL;
    const sqlAnterior = 'COALESCE(upc.fecha_pago_confirmado, f.fecha_hora_facturacion)';

    assert.equal(zoneAppliedBySql(sqlCorregido), 'America/Tegucigalpa');
    assert.equal(zoneAppliedBySql(sqlAnterior), 'UTC', 'sin AT TIME ZONE, PostgreSQL usa el TimeZone de la sesion');

    const conArreglo = nakedTimestampToInstant(FACTURA_GUARDADA_LOCAL, zoneAppliedBySql(sqlCorregido));
    const sinArreglo = nakedTimestampToInstant(FACTURA_GUARDADA_LOCAL, zoneAppliedBySql(sqlAnterior));

    assert.equal(conArreglo.toISOString(), INSTANTE_FACTURA_UTC);
    assert.equal(sinArreglo.toISOString(), '2026-07-28T12:08:57.000Z');

    // Y esa diferencia es exactamente la que decidia el defecto:
    const activacion = new Date(INSTANTE_ACTIVACION_UTC);
    assert.ok(conArreglo >= activacion, 'con el arreglo la venta cae DESPUES de la activacion');
    assert.ok(sinArreglo < activacion, 'sin el arreglo caia ANTES, seleccionando la config desactivada');
  });
});
