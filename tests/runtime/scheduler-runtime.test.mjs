import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  configureEmailCampaignSchedulerForTests,
  resetEmailCampaignSchedulerForTests,
  schedulerTick,
  startEmailCampaignScheduler,
  stopEmailCampaignScheduler
} from '../../jobs/emailCampaignScheduler.js';

const originalEnv = { ...process.env };

const repoRoot = resolve('.');
const schedulerPath = resolve('scheduler.js');

const waitFor = async (predicate) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('timeout waiting for scheduler runtime test condition');
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
};

const setSchedulerEnv = () => {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'test',
    PROCESS_ROLE: 'scheduler',
    EMAIL_SCHEDULER_ENABLED: 'true',
    EMAIL_SCHEDULER_INTERVAL_MS: '15000',
    SMTP_HOST: 'smtp.test.local',
    SMTP_USER: 'user',
    SMTP_PASS: 'pass',
    SMTP_FROM_EMAIL: 'no-reply@example.com',
    SCHEDULER_RUNTIME_AUTOSTART_DISABLED: 'true'
  };
};

const createTimerHarness = () => {
  const intervals = [];
  const cleared = [];
  return {
    intervals,
    cleared,
    setInterval(callback, ms) {
      const timer = { callback, ms };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    }
  };
};

beforeEach(() => {
  setSchedulerEnv();
  resetEmailCampaignSchedulerForTests();
});

afterEach(() => {
  resetEmailCampaignSchedulerForTests();
  process.env = { ...originalEnv };
});

describe('scheduler runtime shutdown', () => {
  it('cierra el pool unicamente despues de finalizar el tick activo', async () => {
    const { createSchedulerRuntime } = await import(`../../scheduler.js?case=${Date.now()}-pool-after-tick`);
    const timers = createTimerHarness();
    const events = [];
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
        events.push('tick-started');
        await new Promise((resolveTick) => {
          releaseTick = resolveTick;
        });
        events.push('tick-finished');
      }
    });

    const running = schedulerTick();
    await waitFor(() => typeof releaseTick === 'function');

    const runtime = createSchedulerRuntime({
      runtimeConfig: { gracefulShutdownTimeoutMs: 1000 },
      stopScheduler: stopEmailCampaignScheduler,
      closeDatabasePool: async () => {
        events.push('pool-closed');
      },
      runtimeProcess: {
        exit(code) {
          events.push(`exit-${code}`);
        }
      }
    });

    const stopping = runtime.shutdown('SIGTERM');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    assert.deepEqual(events, ['tick-started']);

    releaseTick();
    await running;
    await stopping;

    assert.deepEqual(events, ['tick-started', 'tick-finished', 'pool-closed', 'exit-0']);
  });

  it('sale con error y no cierra pool si shutdown supera timeout con tick activo', async () => {
    const { createSchedulerRuntime } = await import(`../../scheduler.js?case=${Date.now()}-timeout`);
    const events = [];

    const runtime = createSchedulerRuntime({
      runtimeConfig: { gracefulShutdownTimeoutMs: 5 },
      stopScheduler: async () => ({ stopped: false, reason: 'ACTIVE_TICK_TIMEOUT', running: true }),
      closeDatabasePool: async () => {
        events.push('pool-closed');
      },
      runtimeProcess: {
        exit(code) {
          events.push(`exit-${code}`);
        }
      }
    });

    await runtime.shutdown('SIGTERM');

    assert.deepEqual(events, ['exit-1']);
  });

  it('carga scheduler.js real sin Express ni servidor HTTP', () => {
    const script = `
      process.env.NODE_ENV = 'test';
      process.env.PROCESS_ROLE = 'scheduler';
      process.env.EMAIL_SCHEDULER_ENABLED = 'true';
      process.env.SCHEDULER_RUNTIME_AUTOSTART_DISABLED = 'true';
      process.env.SMTP_HOST = 'smtp.test.local';
      process.env.SMTP_USER = 'user';
      process.env.SMTP_PASS = 'pass';
      process.env.SMTP_FROM_EMAIL = 'no-reply@example.com';
      const before = process._getActiveHandles().filter((handle) => handle.constructor?.name === 'Server').length;
      const mod = await import(${JSON.stringify(pathToFileURL(schedulerPath).href)});
      const after = process._getActiveHandles().filter((handle) => handle.constructor?.name === 'Server').length;
      if (typeof mod.createSchedulerRuntime !== 'function') throw new Error('missing scheduler runtime export');
      if (after !== before) throw new Error('scheduler import opened an HTTP server');
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: { ...process.env, SCHEDULER_RUNTIME_AUTOSTART_DISABLED: 'true' },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  });
});
