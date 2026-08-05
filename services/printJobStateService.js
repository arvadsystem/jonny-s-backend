export const PRINT_AGENT_EXPECTED_CLAIM_SECONDS = 120;

export const classifyPrintJobState = (job = {}) => {
  const state = String(job.estado || '').trim().toLowerCase();
  const attempts = Number(job.intentos || 0);
  const maxAttempts = Math.max(1, Number(job.max_intentos || 1));
  const agentOnline = job.agent_online === true;

  if (state === 'impreso') return { semantic_state: 'COMPLETADA', retryable: false };
  if (state === 'confirmacion_pendiente') {
    return { semantic_state: 'PENDIENTE_CONFIRMACION', retryable: false };
  }
  if (state === 'asignado' || state === 'imprimiendo') {
    return { semantic_state: 'PROCESANDO', retryable: false };
  }
  if (state === 'fallido') {
    return { semantic_state: 'FALLIDA_DEFINITIVA', retryable: false };
  }
  if (state === 'cancelado') {
    return { semantic_state: 'CANCELADA_USUARIO', retryable: false };
  }
  if (state === 'pendiente' && attempts > 0) {
    return { semantic_state: 'FALLIDA_REINTENTABLE', retryable: attempts < maxAttempts };
  }
  if (state === 'pendiente' && !agentOnline) {
    return {
      semantic_state: 'PENDIENTE_AGENTE_OFFLINE',
      retryable: true,
      expected_claim_seconds: PRINT_AGENT_EXPECTED_CLAIM_SECONDS
    };
  }
  return {
    semantic_state: 'PENDIENTE',
    retryable: true,
    expected_claim_seconds: PRINT_AGENT_EXPECTED_CLAIM_SECONDS
  };
};
