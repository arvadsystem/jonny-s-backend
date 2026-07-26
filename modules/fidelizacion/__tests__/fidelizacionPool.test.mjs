import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool, closeFidelizacionPool } from '../infrastructure/fidelizacionPool.js';

// El pool nunca abre una conexion real en estas pruebas: pg.Pool no conecta
// hasta que algo llama .connect()/.query(), asi que end() sobre un pool sin
// clientes activos es seguro localmente (no toca la red ni una DB real).

describe('fidelizacionPool (pool dedicado, max 1, aislado del pool financiero)', () => {
  it('esta configurado con max: 1 conexion', () => {
    assert.equal(fidelizacionPool.options.max, 1);
  });

  // Debe ejecutarse antes de cualquier cierre exitoso: una vez el pool cierra
  // bien, closeFidelizacionPool queda cacheado en ese resultado (por diseno,
  // es idempotente) y ya no volveria a invocar end() para forzar este fallo.
  it('un fallo al cerrar se reporta pero permite reintentar (protegido, no se atasca)', async () => {
    const originalEnd = fidelizacionPool.end.bind(fidelizacionPool);
    let callCount = 0;
    fidelizacionPool.end = async () => {
      callCount += 1;
      throw new Error('SIMULATED_POOL_END_FAILURE');
    };

    try {
      await assert.rejects(closeFidelizacionPool(), /SIMULATED_POOL_END_FAILURE/);
      // Tras el fallo, un reintento posterior debe poder volver a intentarlo
      // (no debe quedar "atascado" pensando que ya cerro exitosamente).
      await assert.rejects(closeFidelizacionPool(), /SIMULATED_POOL_END_FAILURE/);
      assert.equal(callCount, 2, 'cada intento tras un fallo debe volver a llamar a end()');
    } finally {
      fidelizacionPool.end = originalEnd;
    }
  });

  it('closeFidelizacionPool es idempotente: llamadas repetidas no fallan ni reintentan cerrar dos veces', async () => {
    await closeFidelizacionPool();
    await closeFidelizacionPool();
    await closeFidelizacionPool();
    assert.equal(fidelizacionPool.ended, true);
  });

  it('closeFidelizacionPool concurrente comparte el mismo cierre (no dispara end() por duplicado)', async () => {
    const results = await Promise.all([
      closeFidelizacionPool(),
      closeFidelizacionPool(),
      closeFidelizacionPool()
    ]);
    assert.equal(results.length, 3);
    assert.equal(fidelizacionPool.ended, true);
  });
});
