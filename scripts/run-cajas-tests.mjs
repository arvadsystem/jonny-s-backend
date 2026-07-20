import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const testDirectories = [
  'routers/__tests__',
  'services/__tests__',
  'sql/__tests__'
];

const collectTests = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(entryPath);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [entryPath] : [];
  });

const targets = testDirectories.flatMap(collectTests).sort();

const result = spawnSync(process.execPath, ['--test', ...targets], {
  stdio: 'inherit',
  shell: false
});

process.exit(result.status ?? 1);
