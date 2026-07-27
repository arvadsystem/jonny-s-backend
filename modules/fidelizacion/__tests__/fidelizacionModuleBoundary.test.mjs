import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const collectSourceFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
};

describe('modules/fidelizacion nunca depende del pool financiero compartido', () => {
  it('ningun archivo fuente del modulo importa config/db-connection.js', async () => {
    const files = await collectSourceFiles(MODULE_ROOT);
    assert.ok(files.length > 0, 'debe encontrar al menos un archivo fuente');

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        /from ['"].*config\/db-connection\.js['"]/,
        `${path.relative(MODULE_ROOT, file)} no debe importar el pool financiero compartido`
      );
    }
  });

  it('fidelizacionRepository.js solo usa el pool dedicado (fidelizacionPool), nunca el principal', async () => {
    const source = await readFile(path.join(MODULE_ROOT, 'infrastructure/fidelizacionRepository.js'), 'utf8');
    assert.match(source, /from ['"]\.\/fidelizacionPool\.js['"]/);
    assert.doesNotMatch(source, /import\s+pool\s+from/);
  });
});
