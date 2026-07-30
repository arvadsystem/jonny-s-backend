import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageTimer, STAGE_EVENT } from '../src/metrics.js';

test('cada etapa registra una duracion no negativa y success:true en el camino feliz', async () => {
  const logs = [];
  const { timeStage } = createStageTimer({ log: (level, event, data) => logs.push({ level, event, data }), enabled: true });

  const result = await timeStage(101, 'qz_print', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, STAGE_EVENT);
  assert.equal(logs[0].data.job_id, 101);
  assert.equal(logs[0].data.stage, 'qz_print');
  assert.equal(logs[0].data.success, true);
  assert.ok(Number.isFinite(logs[0].data.duration_ms));
  assert.ok(logs[0].data.duration_ms >= 0);
});

test('una etapa que falla registra success:false, duracion no negativa, y sigue propagando el error', async () => {
  const logs = [];
  const { timeStage } = createStageTimer({ log: (level, event, data) => logs.push({ level, event, data }), enabled: true });
  const boom = new Error('QZ_PRINT_REJECTED');

  await assert.rejects(
    timeStage(202, 'qz_print', async () => { throw boom; }),
    /QZ_PRINT_REJECTED/
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].data.success, false);
  assert.ok(logs[0].data.duration_ms >= 0);
});

test('note() adjunta campos auditables como cache_hit sin exponer nada mas', async () => {
  const logs = [];
  const { timeStage } = createStageTimer({ log: (level, event, data) => logs.push({ level, event, data }), enabled: true });

  await timeStage(303, 'printers_find', async (note) => {
    note({ cache_hit: true });
    return ['ZKP8008'];
  });

  assert.equal(logs[0].data.cache_hit, true);
});

test('las metricas nunca incluyen token, certificados, firmas ni contenido del documento', async () => {
  const logs = [];
  const { timeStage } = createStageTimer({ log: (level, event, data) => logs.push({ level, event, data }), enabled: true });
  const secretLookingPayload = {
    token: 'super-secret-token',
    certificate: '-----BEGIN CERTIFICATE-----abc-----END CERTIFICATE-----',
    signature: 'a1b2c3',
    documento: '<html>factura completa</html>',
    base64: Buffer.from('contenido').toString('base64')
  };

  await timeStage(404, 'document_download', async () => secretLookingPayload);

  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /super-secret-token/);
  assert.doesNotMatch(serialized, /BEGIN CERTIFICATE/);
  assert.doesNotMatch(serialized, /factura completa/);
  // El valor de retorno de fn() nunca se copia dentro del log: solo job_id/stage/duration/success/meta.
  assert.deepEqual(Object.keys(logs[0].data).sort(), ['duration_ms', 'job_id', 'stage', 'success']);
});

test('con metricas deshabilitadas no se genera ningun log ni se llama performance.now()', async () => {
  const logs = [];
  const { timeStage, enabled } = createStageTimer({ log: (level, event, data) => logs.push({ level, event, data }), enabled: false });
  let called = false;

  const result = await timeStage(505, 'qz_connect', async () => { called = true; return 'value'; });

  assert.equal(enabled, false);
  assert.equal(called, true, 'la etapa real siempre debe ejecutarse, esten o no habilitadas las metricas');
  assert.equal(result, 'value');
  assert.deepEqual(logs, []);
});

test('sin etiquetar habilitado, un error tampoco genera logs pero si se propaga', async () => {
  const logs = [];
  const { timeStage } = createStageTimer({ log: (level, event, data) => logs.push({ level, event, data }), enabled: false });

  await assert.rejects(timeStage(606, 'api_complete', async () => { throw new Error('SIN_RUIDO'); }), /SIN_RUIDO/);
  assert.deepEqual(logs, []);
});
