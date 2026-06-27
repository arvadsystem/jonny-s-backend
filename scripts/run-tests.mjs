import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec'], {
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    NODE_ENV: 'test'
  }
});

process.exit(result.status ?? 1);
