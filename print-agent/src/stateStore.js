import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_STATE = Object.freeze({ version: 1, jobs: [] });

export const createPrintStateStore = ({ filePath }) => {
  let state = { ...EMPTY_STATE, jobs: [] };

  const persist = async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, filePath);
  };

  const upsert = async (job, status) => {
    const jobId = Number(job?.id_trabajo || job?.job_id || 0);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('PRINT_STATE_JOB_INVALID');
    const entry = {
      job_id: jobId,
      branch_id: Number(job?.id_sucursal || job?.branch_id || 0),
      status,
      ...(status === 'prepared' ? { job: JSON.parse(JSON.stringify(job)) } : {}),
      updated_at: new Date().toISOString()
    };
    state.jobs = [...state.jobs.filter((item) => item.job_id !== jobId), entry];
    await persist();
    return entry;
  };

  return {
    init: async () => {
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) throw new Error('PRINT_STATE_INVALID');
        state = { version: 1, jobs: parsed.jobs };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist();
      }
    },
    markPrepared: (job) => upsert(job, 'prepared'),
    markDispatchStarted: (job) => upsert(job, 'dispatch_started'),
    markPrintedUnconfirmed: (job) => upsert(job, 'printed_unconfirmed'),
    list: () => state.jobs.map((item) => ({ ...item })),
    remove: async (jobId) => {
      state.jobs = state.jobs.filter((item) => item.job_id !== Number(jobId));
      await persist();
    }
  };
};
