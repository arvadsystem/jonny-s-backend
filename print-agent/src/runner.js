const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sanitize = (error) => String(error?.code || error?.message || 'PRINT_FAILED').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
const RESOLVED_STATES = new Set(['pendiente', 'impreso', 'fallido', 'cancelado']);
const isResolvedForJournal = (remote) => Boolean(
  remote && (RESOLVED_STATES.has(String(remote.estado)) || remote.assigned_to_agent === false)
);

export const createRunner = ({ config, api, qz, stateStore, log = () => {}, delayImpl = delay }) => {
  let stopped = false;
  let failures = 0;
  let claimInProgress = false;
  const uncertainLogged = new Set();

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
    await stateStore.markDispatchStarted(job);
    try {
      await qz.dispatch(prepared);
    } catch (error) {
      // Desde la invocacion de qz.print, cualquier rechazo tiene resultado fisico ambiguo.
      logUncertainOnce({ job_id: job.id_trabajo }, error);
      return true;
    }

    await stateStore.markPrintedUnconfirmed(job);
    try {
      await api.complete(job.id_trabajo);
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

  const processJob = async (job) => {
    if (Number(job.id_sucursal) !== config.branchId) throw new Error('BRANCH_SCOPE_MISMATCH');
    await api.printing(job.id_trabajo);
    const renewTimer = setInterval(() => void api.renew(job.id_trabajo).catch(() => undefined), Math.max(10_000, config.leaseSeconds * 500));
    let prepared;
    try {
      prepared = await qz.prepare(job);
      await stateStore.markPrepared(job);
    } catch (error) {
      await api.fail(job.id_trabajo, sanitize(error)).catch(() => undefined);
      log('error', 'print_prepare_failed', { job_id: job.id_trabajo, code: sanitize(error) });
      clearInterval(renewTimer);
      return;
    }

    try {
      await api.confirmationPending(job.id_trabajo);
    } catch (error) {
      // La respuesta puede perderse despues de que el backend cruzo la barrera.
      log('error', 'print_barrier_pending', { job_id: job.id_trabajo, code: sanitize(error) });
      clearInterval(renewTimer);
      return;
    }
    clearInterval(renewTimer);
    await dispatchPrepared(job, prepared);
  };

  // Punto unico de reclamo/procesamiento: polling, WebSocket ("job_available") y
  // reconexion WebSocket convergen aqui. claimInProgress evita que dos disparadores
  // dentro del mismo agente reclamen/procesen en paralelo; la RPC SKIP LOCKED sigue
  // siendo la autoridad que evita colisiones entre agentes distintos.
  const claimAndProcess = async (trigger) => {
    if (claimInProgress) {
      log('info', 'claim_skipped_in_progress', { trigger });
      return [];
    }
    claimInProgress = true;
    try {
      const reconciliation = await reconcileOnce();
      if (reconciliation.didDispatch) return [];
      const result = await api.claim();
      const jobs = Array.isArray(result.jobs) ? result.jobs.slice(0, 1) : [];
      for (const job of jobs) await processJob(job);
      return jobs;
    } finally {
      claimInProgress = false;
    }
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
