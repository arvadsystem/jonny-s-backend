import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import pool from '../../config/db-connection.js';
import { fidelizacionService } from '../fidelizacion.js';
import {
  isExplicitRateConfirmation,
  isSameLempirasPorPuntoRate,
  requiresRateConfirmation
} from '../../services/fidelizacionService.js';

// routers/fidelizacion.js depende de permisos/sesion resueltos contra la DB
// real (requestHasAnyPermission, resolveRequestUserSucursalScope) sin un
// punto de inyeccion de dependencias, y sus bindings ESM no se pueden
// reemplazar desde afuera. Por eso estas pruebas verifican, sobre el codigo
// fuente real, que las reglas del switch administrativo quedaron
// implementadas exactamente como se pidio (mismo patron ya usado en este
// repo para routers grandes: postVentasTransactionRegression.test.mjs,
// fidelizacionBoundary.test.mjs).
const getRouterSource = async () => readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');

const getHandlerBlock = (source, marker) => {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `No se encontro "${marker}"`);
  const end = source.indexOf('\n  },', start);
  assert.notEqual(end, -1, `No se encontro el cierre de "${marker}"`);
  return source.slice(start, end);
};

describe('routers/fidelizacion.js: switch administrativo acumulacion_habilitada', () => {
  it('getConfiguracion devuelve acumulacion_habilitada en la respuesta', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async getConfiguracion(req)');
    assert.match(handler, /acumulacion_habilitada:\s*Boolean\(config\.acumulacion_habilitada\)/);
  });

  it('saveConfiguracion acepta acumulacion_habilitada como campo permitido', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(handler, /'acumulacion_habilitada'/);
  });

  it('saveConfiguracion rechaza con 400 cuando acumulacion_habilitada no es booleano (ej. el string "true")', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(
      handler,
      /typeof req\.body\.acumulacion_habilitada !== 'boolean'/,
      'debe validar el tipo real, no solo la verdad del valor (para rechazar strings como "true")'
    );
    const typeCheckIndex = handler.search(/typeof req\.body\.acumulacion_habilitada !== 'boolean'/);
    const surrounding = handler.slice(typeCheckIndex, typeCheckIndex + 400);
    assert.match(surrounding, /status:\s*400/);
  });

  it('si se omite acumulacion_habilitada, se resuelve con resolveEffectiveAcumulacionHabilitada (conserva la config previa; false solo si es la primera)', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(handler, /resolveEffectiveAcumulacionHabilitada\(\{\s*\n\s*inputProvided:\s*acumulacionHabilitadaProvided,\s*\n\s*inputValue:\s*acumulacionHabilitadaInput,\s*\n\s*previousConfig\s*\n\s*\}\)/);
  });

  it('lempiras_por_punto provisto pero invalido (0/negativo/NaN) se rechaza con 400 siempre, sin importar el switch', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(handler, /if \(lempirasPorPuntoProvided && !lempirasPorPuntoInput\)/);
  });

  it('la tasa final se resuelve con resolveEffectiveLempirasPorPunto y rechaza con 400 si no puede producir un valor > 0 (primera configuracion sin tasa)', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(handler, /resolveEffectiveLempirasPorPunto\(\{/);
    assert.match(handler, /if \(!lempirasResolution\.ok\)/);
    const rejectIdx = handler.search(/if \(!lempirasResolution\.ok\)/);
    const surrounding = handler.slice(rejectIdx, rejectIdx + 300);
    assert.match(surrounding, /400/);
  });

  it('el INSERT de configuracion persiste acumulacion_habilitada', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(handler, /INSERT INTO public\.fidelizacion_configuracion_sucursal[\s\S]*?acumulacion_habilitada/);
  });

  it('la auditoria incluye el valor anterior y nuevo de acumulacion_habilitada', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    const datosAntesIdx = handler.indexOf('datosAntes:');
    const datosDespuesIdx = handler.indexOf('datosDespues:');
    assert.ok(datosAntesIdx > -1 && datosDespuesIdx > -1);
    const datosAntesBlock = handler.slice(datosAntesIdx, datosDespuesIdx);
    const datosDespuesBlock = handler.slice(datosDespuesIdx, datosDespuesIdx + 300);
    assert.match(datosAntesBlock, /acumulacion_habilitada:\s*Boolean\(previousConfig\.acumulacion_habilitada\)/);
    assert.match(datosDespuesBlock, /acumulacion_habilitada:\s*acumulacionHabilitada/);
  });

  it('sigue rechazando campos desconocidos en el payload (unknownFieldsFromPayload)', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(handler, /unknownFieldsFromPayload\(req\.body, allowedFields\)/);
    assert.match(handler, /code:\s*'UNKNOWN_FIELDS'/);
  });

  it('mantiene los permisos administrativos existentes en ambos endpoints', async () => {
    const source = await getRouterSource();
    const getHandler = getHandlerBlock(source, 'async getConfiguracion(req)');
    const saveHandler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(getHandler, /fidelizacion_configurar_reglas/);
    assert.match(saveHandler, /fidelizacion_configurar_reglas/);
  });
});

// ---------------------------------------------------------------------------
// Confirmacion obligatoria de la equivalencia de la tasa
// ---------------------------------------------------------------------------
// Defecto confirmado en QA: lempiras_por_punto significa "lempiras necesarios
// para ganar 1 punto" (puntos = floor(total / tasa)), pero el campo era
// ambiguo. Se guardo 0.01 creyendo lo contrario y una compra de L 1,130.00
// acumulo 113,000 puntos. La formula no cambia; se agrega una confirmacion
// explicita cuando la tasa se define por primera vez o cambia de valor.
//
// A diferencia del bloque de arriba (aserciones sobre el codigo fuente), estas
// pruebas EJECUTAN el handler real (fidelizacionService.saveConfiguracion) con
// pool.connect parcheado a un client de PostgreSQL simulado, y afirman sobre
// las consultas realmente emitidas: un rechazo debe ocurrir ANTES de desactivar
// la configuracion anterior, de insertar la nueva y de tocar los productos.
const normalizeSqlText = (sqlRaw) => String(sqlRaw).replace(/\s+/g, ' ').trim();

const buildSaveConfigClient = ({ previousConfig = null, userSucursalId = 1 } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sqlRaw, params = []) => {
      const sql = normalizeSqlText(sqlRaw);
      calls.push({ sql, params });

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.startsWith('LOCK TABLE')) return { rows: [], rowCount: 0 };

      // Alcance de sucursal (utils/sucursalScope.js).
      if (sql.includes('FROM public.usuarios u') && sql.includes('LEFT JOIN public.empleados e')) {
        return { rows: [{ id_sucursal: userSucursalId }], rowCount: 1 };
      }
      if (sql.includes('FROM public.v_usuarios_sucursales_scope')) {
        return { rows: [{ id_sucursal: userSucursalId, es_principal: true }], rowCount: 1 };
      }
      if (sql.includes('FROM public.sucursales')) {
        return { rows: [{ id_sucursal: userSucursalId, nombre_sucursal: 'El Carmen', estado: true }], rowCount: 1 };
      }

      // Configuracion vigente (getActiveFidelizacionConfig).
      if (sql.includes('FROM public.fidelizacion_configuracion_sucursal fcs')) {
        return { rows: previousConfig ? [previousConfig] : [], rowCount: previousConfig ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO public.fidelizacion_configuracion_sucursal')) {
        return { rows: [{ id_configuracion: 99 }], rowCount: 1 };
      }
      // Sin tabla bitacoras -> insertFidelizacionAuditLog no escribe nada.
      if (sql.includes('to_regclass')) {
        return { rows: [{ reg: null }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => {}
  };
};

const configReq = (body) => ({
  user: { id_usuario: 7 },
  __isSuperAdmin: false,
  __accessContext: {
    idUsuario: 7,
    isSuperAdmin: false,
    roles: new Set(),
    permissions: new Set(['FIDELIZACION_CONFIGURAR_REGLAS', 'FIDELIZACION_GESTIONAR_PRODUCTOS_CANJEABLES'])
  },
  body,
  params: {},
  query: {}
});

const runSaveConfiguracion = async ({ body, previousConfig = null }) => {
  const client = buildSaveConfigClient({ previousConfig });
  const originalConnect = pool.connect;
  pool.connect = async () => client;
  let result = null;
  let error = null;
  try {
    result = await fidelizacionService.saveConfiguracion(configReq(body));
  } catch (caught) {
    error = caught;
  } finally {
    pool.connect = originalConnect;
  }
  return { result, error, calls: client.calls };
};

// Escrituras que NUNCA deben ocurrir cuando falta la confirmacion.
const assertNoConfigWrites = (calls) => {
  const desactivaAnterior = calls.some((call) => /^UPDATE public\.fidelizacion_configuracion_sucursal/.test(call.sql));
  const insertaNueva = calls.some((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_configuracion_sucursal'));
  const tocaProductos = calls.some((call) => /fidelizacion_productos_canjeables_sucursal/.test(call.sql));

  assert.equal(desactivaAnterior, false, 'no debe desactivar la configuracion anterior');
  assert.equal(insertaNueva, false, 'no debe insertar una configuracion nueva');
  assert.equal(tocaProductos, false, 'no debe tocar los productos canjeables');
};

const assertRateConfirmationRejected = ({ result, error, calls }) => {
  const status = result?.status ?? error?.httpStatus;
  const code = result?.body?.code ?? error?.code;
  assert.equal(status, 400);
  assert.equal(code, 'FIDELIZACION_RATE_CONFIRMATION_REQUIRED');
  assertNoConfigWrites(calls);
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'), 'debe hacer ROLLBACK');
};

const CONFIG_PREVIA_100 = {
  id_configuracion: 5,
  id_sucursal: 1,
  lempiras_por_punto: 100,
  acumulacion_habilitada: true,
  vigente_desde: '2026-07-01T00:00:00Z',
  vigente_hasta: null,
  estado: true
};

describe('routers/fidelizacion.js: saveConfiguracion exige confirmar_equivalencia cuando la tasa se define o cambia', () => {
  it('primera configuracion SIN confirmar_equivalencia -> 400, sin desactivar, sin insertar, sin tocar productos', async () => {
    const salida = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 100, productos_canjeables: [] },
      previousConfig: null
    });
    assertRateConfirmationRejected(salida);
  });

  it('primera configuracion CON confirmar_equivalencia: true -> continua y guarda la tasa', async () => {
    const { result, error, calls } = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 100, confirmar_equivalencia: true, productos_canjeables: [] },
      previousConfig: null
    });

    assert.equal(error, null, `no debia fallar: ${error && error.message}`);
    assert.equal(result.status, 200);
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_configuracion_sucursal'));
    assert.ok(insert, 'debe insertar la configuracion');
    assert.equal(insert.params[1], 100);
  });

  it('cambio de tasa 100 -> 50 SIN confirmar -> 400 y ninguna escritura', async () => {
    const salida = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 50, productos_canjeables: [] },
      previousConfig: CONFIG_PREVIA_100
    });
    assertRateConfirmationRejected(salida);
  });

  it('cambio de tasa 100 -> 50 CON confirmar_equivalencia: true -> continua', async () => {
    const { result, error, calls } = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 50, confirmar_equivalencia: true, productos_canjeables: [] },
      previousConfig: CONFIG_PREVIA_100
    });

    assert.equal(error, null, `no debia fallar: ${error && error.message}`);
    assert.equal(result.status, 200);
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_configuracion_sucursal'));
    assert.equal(insert.params[1], 50);
  });

  it('tasa equivalente (anterior 100, nueva "100.00") NO exige confirmacion: un guardado administrativo normal no se bloquea', async () => {
    const { result, error, calls } = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: '100.00', productos_canjeables: [] },
      previousConfig: CONFIG_PREVIA_100
    });

    assert.equal(error, null, `no debia fallar: ${error && error.message}`);
    assert.equal(result.status, 200);
    assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_configuracion_sucursal')));
  });

  it('la tasa previa puede llegar como string desde el driver ("100.00" vs 100 nueva) y tampoco exige confirmacion', async () => {
    const { result, error } = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 100, productos_canjeables: [] },
      previousConfig: { ...CONFIG_PREVIA_100, lempiras_por_punto: '100.00' }
    });

    assert.equal(error, null, `no debia fallar: ${error && error.message}`);
    assert.equal(result.status, 200);
  });

  it('omitir lempiras_por_punto (solo se edita el switch/productos) conserva la tasa y NO exige confirmacion', async () => {
    const { result, error } = await runSaveConfiguracion({
      body: { id_sucursal: 1, acumulacion_habilitada: false, productos_canjeables: [] },
      previousConfig: CONFIG_PREVIA_100
    });

    assert.equal(error, null, `no debia fallar: ${error && error.message}`);
    assert.equal(result.status, 200);
  });

  it('confirmar_equivalencia debe ser el booleano true: "true", 1, "1", {}, [] y false se rechazan', async () => {
    for (const valorFalso of ['true', 1, '1', {}, [], false]) {
      const salida = await runSaveConfiguracion({
        body: {
          id_sucursal: 1,
          lempiras_por_punto: 100,
          confirmar_equivalencia: valorFalso,
          productos_canjeables: []
        },
        previousConfig: null
      });
      assertRateConfirmationRejected(salida);
    }
  });

  it('tasa 0.01 con confirmacion es tecnicamente aceptada y se guarda exacta (no se redondea a 0)', async () => {
    const { result, error, calls } = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 0.01, confirmar_equivalencia: true, productos_canjeables: [] },
      previousConfig: CONFIG_PREVIA_100
    });

    assert.equal(error, null, `no debia fallar: ${error && error.message}`);
    assert.equal(result.status, 200);
    const insert = calls.find((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_configuracion_sucursal'));
    assert.equal(insert.params[1], 0.01, 'la tasa debe guardarse exactamente como 0.01');
    assert.notEqual(insert.params[1], 0);
  });

  it('el rechazo ocurre DESPUES de leer la configuracion previa pero ANTES de cualquier escritura', async () => {
    const { calls } = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 50, productos_canjeables: [] },
      previousConfig: CONFIG_PREVIA_100
    });

    const indiceLectura = calls.findIndex((call) => call.sql.includes('FROM public.fidelizacion_configuracion_sucursal fcs'));
    const indiceRollback = calls.findIndex((call) => call.sql === 'ROLLBACK');
    assert.ok(indiceLectura >= 0, 'debe leer la configuracion previa para saber si la tasa cambio');
    assert.ok(indiceRollback > indiceLectura, 'el ROLLBACK ocurre despues de la lectura');
    assertNoConfigWrites(calls);
  });

  it('confirmar_equivalencia es un campo permitido (no dispara UNKNOWN_FIELDS)', async () => {
    const { result, error } = await runSaveConfiguracion({
      body: { id_sucursal: 1, lempiras_por_punto: 100, confirmar_equivalencia: true, productos_canjeables: [] },
      previousConfig: null
    });
    const code = result?.body?.code ?? error?.code;
    assert.notEqual(code, 'UNKNOWN_FIELDS');
  });
});

describe('services/fidelizacionService.js: helpers de confirmacion de tasa (funciones puras)', () => {
  it('isSameLempirasPorPuntoRate compara numericamente, no como texto', () => {
    assert.equal(isSameLempirasPorPuntoRate(100, '100.00'), true);
    assert.equal(isSameLempirasPorPuntoRate('100', 100), true);
    assert.equal(isSameLempirasPorPuntoRate(0.01, '0.010'), true);
    assert.equal(isSameLempirasPorPuntoRate(100, 50), false);
    assert.equal(isSameLempirasPorPuntoRate(100, 0.01), false);
    assert.equal(isSameLempirasPorPuntoRate(null, 100), false);
    assert.equal(isSameLempirasPorPuntoRate('abc', 100), false);
  });

  it('requiresRateConfirmation: sin configuracion previa siempre exige confirmacion', () => {
    assert.equal(requiresRateConfirmation({ previousConfig: null, nextLempirasPorPunto: 100 }), true);
  });

  it('requiresRateConfirmation: exige solo cuando la tasa efectiva cambia', () => {
    const previousConfig = { lempiras_por_punto: 100 };
    assert.equal(requiresRateConfirmation({ previousConfig, nextLempirasPorPunto: 100 }), false);
    assert.equal(requiresRateConfirmation({ previousConfig, nextLempirasPorPunto: '100.00' }), false);
    assert.equal(requiresRateConfirmation({ previousConfig, nextLempirasPorPunto: 50 }), true);
    assert.equal(requiresRateConfirmation({ previousConfig, nextLempirasPorPunto: 0.01 }), true);
  });

  it('isExplicitRateConfirmation solo acepta el booleano true', () => {
    assert.equal(isExplicitRateConfirmation(true), true);
    for (const valor of ['true', 1, '1', {}, [], false, null, undefined, 'yes']) {
      assert.equal(isExplicitRateConfirmation(valor), false, `no debe aceptar ${JSON.stringify(valor)}`);
    }
  });
});
