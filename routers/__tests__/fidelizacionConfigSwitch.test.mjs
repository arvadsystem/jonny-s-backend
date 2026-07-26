import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

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

  it('el valor por defecto de acumulacion_habilitada cuando se omite es false', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(
      handler,
      /req\.body\.acumulacion_habilitada === undefined\s*\n?\s*\?\s*false/
    );
  });

  it('lempiras_por_punto solo es obligatorio (>0) cuando acumulacion_habilitada es true', async () => {
    const source = await getRouterSource();
    const handler = getHandlerBlock(source, 'async saveConfiguracion(req)');
    assert.match(handler, /if \(acumulacionHabilitada && !lempirasPorPuntoInput\)/);
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
