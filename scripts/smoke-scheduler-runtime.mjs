import assert from 'node:assert/strict';
import { getRuntimeConfig, validateRuntimeConfig } from '../config/runtime-config.js';

const config = getRuntimeConfig({
  ...process.env,
  PROCESS_ROLE: 'scheduler',
  DB_POOL_MAX: '2',
  EMAIL_SCHEDULER_ENABLED: 'true',
  EMAIL_SCHEDULER_INTERVAL_MS: '15000',
  SMTP_HOST: 'smtp.test.local',
  SMTP_USER: 'user',
  SMTP_PASS: 'pass',
  SMTP_FROM_EMAIL: 'no-reply@example.com'
});

validateRuntimeConfig(config);
assert.equal(config.processRole, 'scheduler');
assert.equal(config.dbPoolMax, 2);
assert.equal(config.emailSchedulerIntervalMs, 15000);
assert.equal(config.smtpConfigured, true);

console.log('[smoke:scheduler] runtime config ok');
