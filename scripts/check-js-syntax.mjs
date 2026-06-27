import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'uploads']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

const files = [];

const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath);
      continue;
    }
    const dotIndex = entry.lastIndexOf('.');
    const extension = dotIndex >= 0 ? entry.slice(dotIndex) : '';
    if (EXTENSIONS.has(extension)) files.push(fullPath);
  }
};

walk(ROOT);

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
