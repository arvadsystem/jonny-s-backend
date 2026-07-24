export const STAGE_EVENT = 'print_stage_timing';

// Reloj monotonico: performance.now() nunca retrocede ni salta por ajustes del reloj del
// sistema, a diferencia de Date.now(). Solo se usa para medir duracion, nunca para
// timestamps de negocio (esos siguen viniendo de Date.now()/ISO en el resto del agente).
const monotonicNowMs = () => performance.now();

// timeStage nunca debe cambiar el resultado ni el flujo de la etapa que envuelve: cuando
// las metricas estan deshabilitadas, ejecuta fn() sin ningun costo adicional (ni siquiera
// performance.now()). Cuando estan habilitadas, agrega exactamente un log estructurado por
// etapa con duracion no negativa y success true/false, nunca contenido del trabajo.
//
// fn recibe un callback `note(fields)` opcional para adjuntar campos auditables adicionales
// (por ejemplo cache_hit) que solo se conocen dentro de la propia etapa -- se fusionan en el
// mismo evento en vez de requerir un segundo log separado.
export const createStageTimer = ({ log = () => {}, enabled = false } = {}) => {
  const timeStage = async (jobId, stage, fn) => {
    if (!enabled) return fn(() => {});

    const meta = {};
    const note = (fields) => Object.assign(meta, fields);
    const startedAt = monotonicNowMs();
    try {
      const result = await fn(note);
      log('info', STAGE_EVENT, {
        job_id: Number(jobId),
        stage,
        duration_ms: Math.max(0, Math.round(monotonicNowMs() - startedAt)),
        success: true,
        ...meta
      });
      return result;
    } catch (error) {
      log('info', STAGE_EVENT, {
        job_id: Number(jobId),
        stage,
        duration_ms: Math.max(0, Math.round(monotonicNowMs() - startedAt)),
        success: false,
        ...meta
      });
      throw error;
    }
  };

  return { timeStage, enabled };
};
