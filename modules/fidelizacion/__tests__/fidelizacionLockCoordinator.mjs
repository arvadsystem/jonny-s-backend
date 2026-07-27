// Test-only helper: simula pg_advisory_xact_lock con bloqueo real entre dos
// "conexiones" mock independientes, para poder escribir una prueba de
// concurrencia genuina (bloqueante 3) sin depender de un Postgres real
// (testcontainers/pg-mem) que este proyecto no tiene instalado.
//
// Mutex por clave basado en una cadena de promesas: cada acquire(key) solo
// resuelve cuando le toca su turno (todo lo que se pidio antes para la
// misma clave ya libero). Esto reproduce el bloqueo real de
// pg_advisory_xact_lock: la segunda transaccion que pide el mismo lock
// queda genuinamente esperando (await) hasta que la primera hace
// COMMIT/ROLLBACK (ver fidelizacionMockClient.mjs: ahi es donde se llama a
// release()).
export const createFidelizacionLockCoordinator = () => {
  const chains = new Map();

  return {
    // Devuelve una promesa que resuelve a la funcion release() SOLO cuando
    // le toca el turno de esta clave (bloquea genuinamente si otra
    // "conexion" ya tiene el lock).
    acquire(key) {
      const prevTail = chains.get(key) || Promise.resolve();
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      chains.set(key, prevTail.then(() => held));
      return prevTail.then(() => release);
    }
  };
};
