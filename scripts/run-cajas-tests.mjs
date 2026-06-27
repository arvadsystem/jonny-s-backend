import { spawnSync } from 'node:child_process';

const targets = [
  'routers/__tests__',
  'services/__tests__',
  'sql/__tests__'
];

const result = spawnSync(process.execPath, ['--test', ...targets], {
  stdio: 'inherit',
  shell: false
});

process.exit(result.status ?? 1);
