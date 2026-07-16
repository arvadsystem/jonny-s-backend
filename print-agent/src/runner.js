const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sanitize = (error) => String(error?.code || error?.message || 'PRINT_FAILED').replace(/[\r\n\t]+/g, ' ').slice(0, 500);

export const createRunner = ({ config, api, qz, stateStore, log = () => {}, delayImpl = delay }) => {
  let stopped = false;
  let failures = 0;

  const reconcileOnce = async () => {
    const records = stateStore.list();
    for (const record of records) {
      if (record.status !== 'printed_unconfirmed') {
        log('error', 'print_outcome_uncertain', { job_id: record.job_id });
        continue;
      }
      try {
        await api.complete(record.job_id);
        await stateStore.remove(record.job_id);
        log('info', 'print_confirmation_reconciled', { job_id: record.job_id });
      } catch (error) {
        log('error', 'print_confirmation_pending', { job_id: record.job_id, code: sanitize(error) });
      }
    }
    return stateStore.list();
  };

  const processJob = async (job) => {
    if (Number(job.id_sucursal) !== config.branchId) throw new Error('BRANCH_SCOPE_MISMATCH');
    await api.printing(job.id_trabajo);
    const renewTimer = setInterval(() => void api.renew(job.id_trabajo).catch(() => undefined), Math.max(10_000, config.leaseSeconds * 500));
    let prepared;
    try {
      prepared = await qz.prepare(job);
      await api.confirmationPending(job.id_trabajo);
    } catch (error) {
      await api.fail(job.id_trabajo, sanitize(error)).catch(() => undefined);
      log('error', 'print_prepare_failed', { job_id: job.id_trabajo, code: sanitize(error) });
      return;
    } finally {
      clearInterval(renewTimer);
    }

    await stateStore.markDispatchStarted(job);
    try {
      await qz.dispatch(prepared);
    } catch (error) {
      // Una vez invocado qz.print, un rechazo no permite saber si hubo salida fisica.
      // Se conserva el journal y confirmacion_pendiente para conciliacion manual, sin reencolar.
      log('error', 'print_outcome_uncertain', { job_id: job.id_trabajo, code: sanitize(error) });
      return;
    }

    await stateStore.markPrintedUnconfirmed(job);
    try {
      await api.complete(job.id_trabajo);
      await stateStore.remove(job.id_trabajo);
      log('info', 'print_complete', { job_id: job.id_trabajo });
    } catch (error) {
      // Nunca reportar fail ni volver a qz.print despues de una respuesta QZ exitosa.
      log('error', 'print_confirmation_pending', { job_id: job.id_trabajo, code: sanitize(error) });
    }
  };

  const pollOnce = async () => {
    const pendingConfirmations = await reconcileOnce();
    if (pendingConfirmations.length > 0) return [];
    const result = await api.claim();
    const jobs = Array.isArray(result.jobs) ? result.jobs.slice(0, 1) : [];
    for (const job of jobs) await processJob(job);
    return jobs;
  };

  return {
    heartbeatOnce: () => api.heartbeat('1.0.0'),
    reconcileOnce,
    pollOnce,
    run: async () => {
      let nextHeartbeat = 0;
      while (!stopped) {
        try {
          if (Date.now() >= nextHeartbeat) {
            await api.heartbeat('1.0.0');
            nextHeartbeat = Date.now() + config.heartbeatIntervalMs;
          }
          await pollOnce();
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
