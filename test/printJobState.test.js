import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrintJobState, PRINT_AGENT_EXPECTED_CLAIM_SECONDS } from '../services/printJobStateService.js';

test('pendiente sin intentos distingue agente offline de cola normal', () => {
  assert.equal(classifyPrintJobState({ estado: 'pendiente', intentos: 0, agent_online: false }).semantic_state, 'PENDIENTE_AGENTE_OFFLINE');
  assert.equal(classifyPrintJobState({ estado: 'pendiente', intentos: 0, agent_online: true }).semantic_state, 'PENDIENTE');
  assert.equal(PRINT_AGENT_EXPECTED_CLAIM_SECONDS, 120);
});

test('reintento, procesamiento, confirmacion y finales no se mezclan', () => {
  assert.deepEqual(classifyPrintJobState({ estado: 'pendiente', intentos: 1, max_intentos: 5, agent_online: false }), {
    semantic_state: 'FALLIDA_REINTENTABLE', retryable: true
  });
  assert.equal(classifyPrintJobState({ estado: 'asignado' }).semantic_state, 'PROCESANDO');
  assert.equal(classifyPrintJobState({ estado: 'imprimiendo' }).semantic_state, 'PROCESANDO');
  assert.equal(classifyPrintJobState({ estado: 'confirmacion_pendiente' }).semantic_state, 'PENDIENTE_CONFIRMACION');
  assert.equal(classifyPrintJobState({ estado: 'impreso' }).semantic_state, 'COMPLETADA');
  assert.equal(classifyPrintJobState({ estado: 'fallido', intentos: 5, max_intentos: 5 }).semantic_state, 'FALLIDA_DEFINITIVA');
  assert.equal(classifyPrintJobState({ estado: 'cancelado' }).semantic_state, 'CANCELADA_USUARIO');
});
