const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sanitize = (error) => String(error?.code || error?.message || 'PRINT_FAILED').replace(/[\r\n\t]+/g, ' ').slice(0, 500);

export const createRunner = ({ config, api, qz, log = () => {}, delayImpl = delay }) => {
  let stopped = false;
  let failures = 0;
  const processJob = async (job) => {
    if (Number(job.id_sucursal) !== config.branchId) throw new Error('BRANCH_SCOPE_MISMATCH');
    await api.printing(job.id_trabajo);
    const renewTimer = setInterval(() => void api.renew(job.id_trabajo).catch(() => undefined), Math.max(10_000, config.leaseSeconds * 500));
    try {
      await qz.print(job);
      await api.complete(job.id_trabajo);
      log('info', 'print_complete', { job_id: job.id_trabajo });
    } catch (error) {
      await api.fail(job.id_trabajo, sanitize(error)).catch(() => undefined);
      log('error', 'print_failed', { job_id: job.id_trabajo, code: sanitize(error) });
    } finally { clearInterval(renewTimer); }
  };
  return {
    heartbeatOnce: () => api.heartbeat('1.0.0'),
    pollOnce: async () => {
      const result = await api.claim();
      for (const job of result.jobs || []) await processJob(job);
      return result.jobs || [];
    },
    run: async () => {
      let nextHeartbeat = 0;
      while (!stopped) {
        try {
          if (Date.now() >= nextHeartbeat) { await api.heartbeat('1.0.0'); nextHeartbeat = Date.now() + config.heartbeatIntervalMs; }
          await (async () => {
            const result = await api.claim();
            for (const job of result.jobs || []) await processJob(job);
          })();
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
