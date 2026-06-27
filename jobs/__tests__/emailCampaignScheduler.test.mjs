import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  configureEmailCampaignSchedulerForTests,
  getEmailCampaignSchedulerState,
  resetEmailCampaignSchedulerForTests,
  schedulerTick,
  startEmailCampaignScheduler,
  stopEmailCampaignScheduler
} from '../emailCampaignScheduler.js';

const originalEnv = { ...process.env };

const setSchedulerEnv = () => {
  process.env.PROCESS_ROLE = 'scheduler';
  process.env.EMAIL_SCHEDULER_ENABLED = 'true';
  process.env.EMAIL_SCHEDULER_INTERVAL_MS = '15000';
};

const createTimerHarness = () => {
  const intervals = [];
  const cleared = [];
  let unrefCalls = 0;
  return {
    intervals,
    cleared,
    get unrefCalls() {
      return unrefCalls;
    },
    setInterval(callback, ms) {
      const timer = {
        callback,
        ms,
        unref() {
          unrefCalls += 1;
        }
      };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    }
  };
};

const waitFor = async (predicate) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('timeout waiting for scheduler test condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

beforeEach(() => {
  process.env = { ...originalEnv };
  setSchedulerEnv();
  resetEmailCampaignSchedulerForTests();
});

afterEach(() => {
  resetEmailCampaignSchedulerForTests();
  process.env = { ...originalEnv };
});

describe('email campaign scheduler runtime', () => {
  it('inicia, ejecuta primer tick, crea intervalo y no llama unref', async () => {
    const timers = createTimerHarness();
    let ticks = 0;
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {
        ticks += 1;
      },
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    const result = await startEmailCampaignScheduler();

    assert.deepEqual(result, { started: true, reason: 'STARTED', interval_ms: 15000 });
    assert.equal(ticks, 1);
    assert.equal(timers.intervals.length, 2);
    assert.equal(timers.intervals[0].ms, 15000);
    assert.equal(timers.unrefCalls, 0);
    assert.equal(getEmailCampaignSchedulerState().started, true);
  });

  it('no crea segundo intervalo si ya estaba iniciado', async () => {
    const timers = createTimerHarness();
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {},
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    await startEmailCampaignScheduler();
    const second = await startEmailCampaignScheduler();

    assert.equal(second.reason, 'ALREADY_STARTED');
    assert.equal(timers.intervals.length, 2);
  });

  it('devuelve DISABLED cuando EMAIL_SCHEDULER_ENABLED esta apagado', async () => {
    configureEmailCampaignSchedulerForTests({
      isEmailSchedulerEnabled: () => false,
      isSmtpConfigured: () => true
    });

    const result = await startEmailCampaignScheduler();
    assert.deepEqual(result, { started: false, reason: 'DISABLED' });
  });

  it('devuelve SMTP_NOT_CONFIGURED cuando falta SMTP', async () => {
    configureEmailCampaignSchedulerForTests({
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => false
    });

    const result = await startEmailCampaignScheduler();
    assert.deepEqual(result, { started: false, reason: 'SMTP_NOT_CONFIGURED' });
  });

  it('no solapa ticks si uno sigue ejecutandose', async () => {
    const timers = createTimerHarness();
    let releaseTick;
    let startedTicks = 0;
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {
        startedTicks += 1;
        await new Promise((resolve) => {
          releaseTick = resolve;
        });
      },
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    configureEmailCampaignSchedulerForTests({
      processScheduledCampaigns: async () => {}
    });
    await startEmailCampaignScheduler();
    configureEmailCampaignSchedulerForTests({
      processScheduledCampaigns: async () => {
        startedTicks += 1;
        await new Promise((resolve) => {
          releaseTick = resolve;
        });
      }
    });

    const firstTick = schedulerTick();
    const secondTick = await schedulerTick();
    releaseTick();
    await firstTick;

    assert.equal(secondTick.skipped, true);
    assert.equal(secondTick.reason, 'ALREADY_RUNNING');
    assert.equal(startedTicks, 1);
  });

  it('un error de tick no detiene el intervalo', async () => {
    const timers = createTimerHarness();
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {
        const error = new Error('boom');
        error.code = 'BOOM';
        throw error;
      },
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    const result = await startEmailCampaignScheduler();

    assert.equal(result.started, true);
    assert.equal(getEmailCampaignSchedulerState().failed_ticks, 1);
    assert.equal(timers.intervals.length, 2);
  });

  it('shutdown limpia intervalo y espera tick activo', async () => {
    const timers = createTimerHarness();
    let releaseTick;
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {
        await new Promise((resolve) => {
          releaseTick = resolve;
        });
      },
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    configureEmailCampaignSchedulerForTests({
      processScheduledCampaigns: async () => {}
    });
    await startEmailCampaignScheduler();
    configureEmailCampaignSchedulerForTests({
      processScheduledCampaigns: async () => {
        await new Promise((resolve) => {
          releaseTick = resolve;
        });
      }
    });

    const running = schedulerTick();
    await waitFor(() => typeof releaseTick === 'function');
    const stopping = stopEmailCampaignScheduler({ timeoutMs: 1000 });
    releaseTick();
    await running;
    const stopped = await stopping;

    assert.equal(stopped.stopped, true);
    assert.equal(stopped.reason, 'STOPPED');
    assert.equal(getEmailCampaignSchedulerState().running, false);
    assert.equal(getEmailCampaignSchedulerState().started, false);
  });

  it('shutdown durante el primer tick finaliza antes del timeout sin crear timers', async () => {
    const timers = createTimerHarness();
    let releaseTick;
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {
        await new Promise((resolve) => {
          releaseTick = resolve;
        });
      },
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    const starting = startEmailCampaignScheduler();
    await waitFor(() => typeof releaseTick === 'function');

    const stopping = stopEmailCampaignScheduler({ timeoutMs: 1000 });
    releaseTick();

    const [started, stopped] = await Promise.all([starting, stopping]);

    assert.deepEqual(started, { started: false, reason: 'STOPPING', interval_ms: 15000 });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.reason, 'STOPPED');
    assert.equal(timers.intervals.length, 0);
    assert.equal(timers.cleared.length, 0);
    assert.equal(getEmailCampaignSchedulerState().running, false);
    assert.equal(getEmailCampaignSchedulerState().started, false);
  });

  it('timeout durante el primer tick no marca inicio ni programa timers al completarse despues', async () => {
    const timers = createTimerHarness();
    let releaseTick;
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {
        await new Promise((resolve) => {
          releaseTick = resolve;
        });
      },
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    const starting = startEmailCampaignScheduler();
    await waitFor(() => typeof releaseTick === 'function');

    const stopped = await stopEmailCampaignScheduler({ timeoutMs: 5 });

    assert.equal(stopped.stopped, false);
    assert.equal(stopped.reason, 'ACTIVE_TICK_TIMEOUT');
    assert.equal(stopped.running, true);
    assert.equal(getEmailCampaignSchedulerState().running, true);
    assert.equal(getEmailCampaignSchedulerState().started, false);

    releaseTick();
    const started = await starting;

    assert.deepEqual(started, { started: false, reason: 'STOPPING', interval_ms: 15000 });
    assert.equal(timers.intervals.length, 0);
    assert.equal(getEmailCampaignSchedulerState().running, false);
    assert.equal(getEmailCampaignSchedulerState().started, false);
  });

  it('mantiene estado activo si shutdown supera timeout', async () => {
    const timers = createTimerHarness();
    let releaseTick;
    configureEmailCampaignSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      processScheduledCampaigns: async () => {},
      isEmailSchedulerEnabled: () => true,
      isSmtpConfigured: () => true,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    await startEmailCampaignScheduler();
    configureEmailCampaignSchedulerForTests({
      processScheduledCampaigns: async () => {
        await new Promise((resolve) => {
          releaseTick = resolve;
        });
      }
    });

    const running = schedulerTick();
    await waitFor(() => typeof releaseTick === 'function');
    const stopped = await stopEmailCampaignScheduler({ timeoutMs: 5 });

    assert.equal(stopped.stopped, false);
    assert.equal(stopped.reason, 'ACTIVE_TICK_TIMEOUT');
    assert.equal(stopped.running, true);
    assert.equal(getEmailCampaignSchedulerState().running, true);
    assert.equal(getEmailCampaignSchedulerState().started, true);

    releaseTick();
    await running;

    assert.equal(getEmailCampaignSchedulerState().running, false);
    assert.equal(getEmailCampaignSchedulerState().started, false);
  });
});
