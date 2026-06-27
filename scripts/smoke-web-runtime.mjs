import assert from 'node:assert/strict';
import { getRuntimeConfig, validateRuntimeConfig } from '../config/runtime-config.js';

const config = getRuntimeConfig({
  ...process.env,
  PROCESS_ROLE: 'web',
  PORT: '3001',
  DB_POOL_MAX: '5',
  EMAIL_SCHEDULER_ENABLED: 'false'
});

validateRuntimeConfig(config);
assert.equal(config.processRole, 'web');
assert.equal(config.port, 3001);
assert.equal(config.dbPoolMax, 5);

console.log('[smoke:web] runtime config ok');
