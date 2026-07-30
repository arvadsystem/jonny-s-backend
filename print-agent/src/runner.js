import { createStageTimer } from './metrics.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sanitize = (error) => String(error?.code || error?.message || 'PRINT_FAILED').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
const RESOLVED_STATES = new Set(['pendiente', 'impreso', 'fallido', 'cancelado']);
const isResolvedForJournal = (remote) => Boolean(
  remote && (RESOLVED_STATES.has(String(remote.estado)) || remote.assigned_to_agent === false)
);
// Tope de vueltas de drenaje dentro de una sola llamada a claimAndProcess. Cada trabajo
// disponible cuesta como minimo una vuelta; 25 cubre con margen una rafaga real de una
// sucursal sin arriesgar un loop sin fin si algo se comporta de forma inesperada. Lo que
// quede por encima del tope lo recoge el siguiente polling o la siguiente señal.
export const MAX_DRAIN_ITERATIONS = 25;

export const createRunner = ({ config, api, qz, stateStore, log = () => {}, delayImpl = delay }) => {
  let stopped = false;
  let failures = 0;
  let claimInProgress = false;
  // Una señal que llega mientras claimInProgress ya esta activo no debe perderse: en vez
  // de descartarla, se marca claimPending para forzar una vuelta extra de drenaje antes de
  // liberar el guard, sin permitir nunca una segunda ejecucion concurrente.
  let claimPending = false;
  // Cuenta cuantas señales fueron diferidas durante la vuelta de drenaje activa, para
  // registrar un solo resumen al final en vez de un log por cada claim_deferred (Fase 6).
  let deferredSignalCount = 0;
  const uncertainLogged = new Set();
  const { timeStage } = createStageTimer({ log, enabled: config.perfLogsEnabled === true });

  const removeJournal = async (jobId, event, data = {}) => {
    await stateStore.remove(jobId);
    uncertainLogged.delete(Number(jobId));
    log('info', event, { job_id: Number(jobId), ...data });
  };

  const logUncertainOnce = (record, error = null) => {
    const jobId = Number(record.job_id);
    if (uncertainLogged.has(jobId)) return;
    uncertainLogged.add(jobId);
    log('error', 'print_outcome_uncertain', {
      job_id: jobId,
      ...(error ? { code: sanitize(error) } : {})
    });
  };

  const readRemoteStatus = async (record) => {
    try {
      return (await api.status(record.job_id)).job;
    } catch (error) {
      log('error', 'print_status_pending', { job_id: record.job_id, code: sanitize(error) });
      return undefined;
    }
  };

  const completePrintedRecord = async (record) => {
    try {
      await api.complete(record.job_id);
      await removeJournal(record.job_id, 'print_confirmation_reconciled');
      return;
    } catch (error) {
      const remote = await readRemoteStatus(record);
      if (isResolvedForJournal(remote)) {
        await removeJournal(record.job_id, 'print_journal_admin_resolved', { state: remote.estado });
        return;
      }
      log('error', 'print_confirmation_pending', { job_id: record.job_id, code: sanitize(error) });
    }
  };

  const dispatchPrepared = async (job, prepared) => {
    await timeStage(job.id_trabajo, 'journal_mark_dispatch_started', () => stateStore.markDispatchStarted(job));
    try {
      // qz.dispatch ya mide su propia etapa qz_print internamente (qzClient.js); aqui solo
      // se conserva intacta la barrera de resultado fisico incierto ante cualquier rechazo.
      await qz.dispatch(prepared);
    } catch (error) {
      // Desde la invocacion de qz.print, cualquier rechazo tiene resultado fisico ambiguo.
      logUncertainOnce({ job_id: job.id_trabajo }, error);
      return true;
    }

    await timeStage(job.id_trabajo, 'journal_mark_printed_unconfirmed', () => stateStore.markPrintedUnconfirmed(job));
    try {
      await timeStage(job.id_trabajo, 'api_complete', () => api.complete(job.id_trabajo));
      await removeJournal(job.id_trabajo, 'print_complete');
    } catch (error) {
      log('error', 'print_confirmation_pending', { job_id: job.id_trabajo, code: sanitize(error) });
    }
    return true;
  };

  const recoverPrepared = async (record) => {
    const remote = await readRemoteStatus(record);
    if (remote === null || remote === undefined) return false;
    if (isResolvedForJournal(remote)) {
      await removeJournal(record.job_id, 'print_journal_admin_resolved', { state: remote.estado });
      return false;
    }
    if (!['imprimiendo', 'confirmacion_pendiente'].includes(String(remote.estado))) {
      log('error', 'print_prepared_state_pending', { job_id: record.job_id, state: remote.estado });
      return false;
    }
    if (!record.job || Number(record.job.id_sucursal) !== config.branchId) {
      log('error', 'print_prepared_journal_invalid', { job_id: record.job_id });
      return false;
    }

    if (remote.estado === 'imprimiendo' && !remote.lease_active) {
      await removeJournal(record.job_id, 'print_prepared_lease_expired');
      return false;
    }

    let prepared;
    try {
      prepared = await qz.prepare(record.job);
    } catch (error) {
      if (remote.estado === 'imprimiendo' && remote.lease_active) {
        const failed = await api.fail(record.job_id, sanitize(error)).then(() => true, () => false);
        if (failed) await removeJournal(record.job_id, 'print_prepare_recovery_failed');
      } else {
        log('error', 'print_prepare_recovery_pending', { job_id: record.job_id, code: sanitize(error) });
      }
      return false;
    }

    if (remote.estado === 'imprimiendo') {
      try {
        await api.confirmationPending(record.job_id);
      } catch (error) {
        log('error', 'print_barrier_pending', { job_id: record.job_id, code: sanitize(error) });
        return false;
      }
    }
    return dispatchPrepared(record.job, prepared);
  };

  const reconcileOnce = async () => {
    const records = stateStore.list();
    const priority = { printed_unconfirmed: 0, prepared: 1, dispatch_started: 2 };
    records.sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));
    let didDispatch = false;

    for (const record of records) {
      if (record.status === 'printed_unconfirmed') {
        await completePrintedRecord(record);
        continue;
      }
      if (record.status === 'prepared') {
        didDispatch = await recoverPrepared(record);
        if (didDispatch) break;
        continue;
      }
      if (record.status === 'dispatch_started') {
        const remote = await readRemoteStatus(record);
        if (isResolvedForJournal(remote)) {
          await removeJournal(record.job_id, 'print_journal_admin_resolved', { state: remote.estado });
        } else if (remote) {
          logUncertainOnce(record);
        }
      }
    }
    return { didDispatch };
  };

  // total_processing envuelve exactamente el cuerpo original de processJob: nunca cambia
  // que se ejecuta ni el orden, solo agrega la medicion de principio a fin (Fase 2). Con
  // metricas apagadas, timeStage llama processJob sin ningun costo ni cambio de comportamiento.
  const processJob = (job) => timeStage(job.id_trabajo, 'total_processing', async () => {
    if (Number(job.id_sucursal) !== config.branchId) throw new Error('BRANCH_SCOPE_MISMATCH');
    await timeStage(job.id_trabajo, 'api_printing', () => api.printing(job.id_trabajo));
    const renewTimer = setInterval(() => void api.renew(job.id_trabajo).catch(() => undefined), Math.max(10_000, config.leaseSeconds * 500));
    let prepared;
    try {
      // qz.prepare mide sus propias sub-etapas internamente (qz_connect, printers_find,
      // printer_resolution, document_download, document_validation; ver qzClient.js).
      prepared = await qz.prepare(job);
      await timeStage(job.id_trabajo, 'journal_mark_prepared', () => stateStore.markPrepared(job));
    } catch (error) {
      await api.fail(job.id_trabajo, sanitize(error)).catch(() => undefined);
      log('error', 'print_prepare_failed', { job_id: job.id_trabajo, code: sanitize(error) });
      clearInterval(renewTimer);
      return;
    }

    try {
      await timeStage(job.id_trabajo, 'confirmation_pending', () => api.confirmationPending(job.id_trabajo));
    } catch (error) {
      // La respuesta puede perderse despues de que el backend cruzo la barrera.
      log('error', 'print_barrier_pending', { job_id: job.id_trabajo, code: sanitize(error) });
      clearInterval(renewTimer);
      return;
    }
    clearInterval(renewTimer);
    await dispatchPrepared(job, prepared);
  });

  // Punto unico de reclamo/procesamiento: polling, WebSocket ("job_available") y
  // reconexion WebSocket convergen aqui. claimInProgress evita que dos disparadores
  // dentro del mismo agente reclamen/procesen en paralelo; la RPC SKIP LOCKED sigue
  // siendo la autoridad que evita colisiones entre agentes distintos.
  //
  // Drenaje secuencial: si al reclamar aparece un trabajo, se reclama el siguiente de
  // inmediato -- sin esperar el proximo poll/señal -- hasta que el backend devuelva la
  // cola vacia o se alcance MAX_DRAIN_ITERATIONS. Una señal que llega mientras esta
  // vuelta ya esta en curso jamas se pierde: queda marcada en claimPending y fuerza una
  // vuelta extra de verificacion antes de salir, en vez de descartarse.
  //
  // Fase 6: claim_deferred es esperado cuando polling y WebSocket coinciden y no indica
  // ningun error; en vez de un log por cada señal diferida, se cuenta y se resume una
  // sola vez al final de la vuelta de drenaje activa (claim_deferred_summary).
  const claimAndProcess = async (trigger) => {
    if (claimInProgress) {
      claimPending = true;
      deferredSignalCount += 1;
      return [];
    }

    claimInProgress = true;
    deferredSignalCount = 0;
    const processedJobs = [];
    const seenJobIds = new Set();
    let iteration = 0;
    try {
      for (; iteration < MAX_DRAIN_ITERATIONS; iteration += 1) {
        claimPending = false;

        const reconciliation = await reconcileOnce();
        if (reconciliation.didDispatch) continue;

        const result = await api.claim();
        const jobs = Array.isArray(result.jobs) ? result.jobs.slice(0, 1) : [];
        const freshJobs = jobs.filter((job) => !seenJobIds.has(Number(job.id_trabajo)));
        if (freshJobs.length < jobs.length) {
          // La RPC nunca deberia repetir un trabajo ya reclamado en esta misma vuelta de
          // drenaje; si ocurre, se ignora en vez de reprocesar para no imprimir dos veces.
          log('warn', 'claim_duplicate_job_ignored', { trigger, job_id: Number(jobs[0]?.id_trabajo) });
        }

        if (freshJobs.length === 0) {
          if (claimPending) continue;
          break;
        }

        for (const job of freshJobs) {
          seenJobIds.add(Number(job.id_trabajo));
          await processJob(job);
          processedJobs.push(job);
        }
      }
      if (iteration >= MAX_DRAIN_ITERATIONS) {
        log('warn', 'claim_drain_limit_reached', { trigger, drained: processedJobs.length });
      }
    } finally {
      claimInProgress = false;
      if (deferredSignalCount > 0) {
        log('info', 'claim_deferred_summary', { trigger, deferred_count: deferredSignalCount });
      }
    }
    return processedJobs;
  };

  const pollOnce = () => claimAndProcess('polling');

  return {
    heartbeatOnce: () => api.heartbeat('1.0.0'),
    reconcileOnce,
    pollOnce,
    claimAndProcess,
    run: async () => {
      let nextHeartbeat = 0;
      while (!stopped) {
        try {
          if (Date.now() >= nextHeartbeat) {
            await api.heartbeat('1.0.0');
            nextHeartbeat = Date.now() + config.heartbeatIntervalMs;
          }
          await claimAndProcess('polling');
          failures = 0;
          await delayImpl(config.pollIntervalMs);
        } catch (error) {
          failures += 1;
          log('error', 'poll_failed', { code: sanitize(error), attempt: failures });
          await delayImpl(Math.min(config.pollIntervalMs * (2 ** Math.min(failures, 4)), 30000));
        }
      }
    },
    stop: () => { stopped = true; }
  };
};
