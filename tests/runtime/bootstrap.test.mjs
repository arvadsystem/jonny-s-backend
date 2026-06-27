import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const repoRoot = resolve('.');
const bootstrapPath = join(repoRoot, 'bootstrap.js');

const runBootstrap = (env) => spawnSync(process.execPath, [bootstrapPath], {
  cwd: repoRoot,
  env: { ...process.env, ...env },
  encoding: 'utf8'
});

describe('bootstrap runtime entrypoint', () => {
  it('PROCESS_ROLE=web importa server dinamico', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jonny-bootstrap-web-'));
    const marker = join(dir, 'server-marker.txt');
    const modulePath = join(dir, 'server.mjs');
    writeFileSync(modulePath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'web');`);

    const result = runBootstrap({
      PROCESS_ROLE: 'web',
      RUNTIME_BOOTSTRAP_WEB_MODULE: pathToFileURL(modulePath).href,
      DB_POOL_MAX: '5'
    });

    assert.equal(result.status, 0, result.stderr);
  });

  it('PROCESS_ROLE=scheduler importa scheduler dinamico sin cargar Express', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jonny-bootstrap-scheduler-'));
    const modulePath = join(dir, 'scheduler.mjs');
    writeFileSync(modulePath, 'globalThis.__scheduler_loaded = true;');

    const result = runBootstrap({
      PROCESS_ROLE: 'scheduler',
      RUNTIME_BOOTSTRAP_SCHEDULER_MODULE: pathToFileURL(modulePath).href,
      EMAIL_SCHEDULER_ENABLED: 'true',
      EMAIL_SCHEDULER_INTERVAL_MS: '15000',
      DB_POOL_MAX: '2',
      SMTP_HOST: 'smtp.test.local',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      SMTP_FROM_EMAIL: 'no-reply@example.com'
    });

    assert.equal(result.status, 0, result.stderr);
  });

  it('PROCESS_ROLE invalido falla', () => {
    const result = runBootstrap({ PROCESS_ROLE: 'otro' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /PROCESS_ROLE_INVALID/);
  });
});
