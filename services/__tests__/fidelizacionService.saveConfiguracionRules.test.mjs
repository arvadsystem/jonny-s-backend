import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveEffectiveAcumulacionHabilitada,
  resolveEffectiveLempirasPorPunto
} from '../fidelizacionService.js';

// Pruebas de comportamiento puro (sin mocks de DB) sobre las reglas de
// saveConfiguracion para los bloqueantes 1 (tasa sin equivalencia valida) y
// 4 (payload antiguo que omite el switch). routers/fidelizacion.js llama a
// estas mismas funciones exportadas; no se duplica la logica aqui.

describe('resolveEffectiveLempirasPorPunto (bloqueante 1: tasa siempre > 0)', () => {
  it('primera configuracion, switch apagado, tasa vacia -> invalido (400 controlado)', () => {
    const result = resolveEffectiveLempirasPorPunto({
      inputProvided: false,
      inputValue: null,
      previousConfig: null
    });
    assert.equal(result.ok, false);
  });

  it('primera configuracion, switch apagado, tasa positiva -> guarda correctamente', () => {
    const result = resolveEffectiveLempirasPorPunto({
      inputProvided: true,
      inputValue: 5,
      previousConfig: null
    });
    assert.equal(result.ok, true);
    assert.equal(result.value, 5);
  });

  it('configuracion existente, switch apagado, tasa omitida -> conserva la anterior', () => {
    const result = resolveEffectiveLempirasPorPunto({
      inputProvided: false,
      inputValue: null,
      previousConfig: { lempiras_por_punto: 12.5, acumulacion_habilitada: false }
    });
    assert.equal(result.ok, true);
    assert.equal(result.value, 12.5);
  });

  it('configuracion existente, tasa cero (provista explicitamente) -> invalido', () => {
    // El router ya rechaza esto con 400 antes de llegar aqui (parsePositiveNumber(0) es null),
    // pero el helper tambien debe negarse a "salvarlo" cayendo a la tasa anterior.
    const result = resolveEffectiveLempirasPorPunto({
      inputProvided: true,
      inputValue: null,
      previousConfig: { lempiras_por_punto: 10, acumulacion_habilitada: true }
    });
    assert.equal(result.ok, false);
  });

  it('configuracion existente, tasa negativa (provista explicitamente) -> invalido', () => {
    const result = resolveEffectiveLempirasPorPunto({
      inputProvided: true,
      inputValue: null,
      previousConfig: { lempiras_por_punto: 10, acumulacion_habilitada: true }
    });
    assert.equal(result.ok, false);
  });

  it('nunca resuelve a 0: sin previa y sin input valido, ok=false (nunca value=0)', () => {
    const result = resolveEffectiveLempirasPorPunto({
      inputProvided: false,
      inputValue: null,
      previousConfig: { lempiras_por_punto: 0, acumulacion_habilitada: false }
    });
    assert.equal(result.ok, false);
    assert.notEqual(result.value, 0);
  });

  it('previousConfig con tasa previa invalida (NaN/negativa) tampoco se conserva', () => {
    const result = resolveEffectiveLempirasPorPunto({
      inputProvided: false,
      inputValue: null,
      previousConfig: { lempiras_por_punto: -5 }
    });
    assert.equal(result.ok, false);
  });
});

describe('resolveEffectiveAcumulacionHabilitada (bloqueante 4: payload antiguo no apaga el switch)', () => {
  it('configuracion previa encendida + payload sin switch -> continua encendida', () => {
    const value = resolveEffectiveAcumulacionHabilitada({
      inputProvided: false,
      inputValue: null,
      previousConfig: { acumulacion_habilitada: true }
    });
    assert.equal(value, true);
  });

  it('configuracion previa apagada + payload sin switch -> continua apagada', () => {
    const value = resolveEffectiveAcumulacionHabilitada({
      inputProvided: false,
      inputValue: null,
      previousConfig: { acumulacion_habilitada: false }
    });
    assert.equal(value, false);
  });

  it('primera configuracion sin switch -> queda apagada', () => {
    const value = resolveEffectiveAcumulacionHabilitada({
      inputProvided: false,
      inputValue: null,
      previousConfig: null
    });
    assert.equal(value, false);
  });

  it('switch explicito true -> valido, respeta el payload aunque haya configuracion previa apagada', () => {
    const value = resolveEffectiveAcumulacionHabilitada({
      inputProvided: true,
      inputValue: true,
      previousConfig: { acumulacion_habilitada: false }
    });
    assert.equal(value, true);
  });

  it('switch explicito false -> valido, respeta el payload aunque haya configuracion previa encendida', () => {
    const value = resolveEffectiveAcumulacionHabilitada({
      inputProvided: true,
      inputValue: false,
      previousConfig: { acumulacion_habilitada: true }
    });
    assert.equal(value, false);
  });
});
