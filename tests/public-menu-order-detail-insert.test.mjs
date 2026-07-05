import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('detalle de pedido publico mantiene una expresion por columna', async () => {
  const source = await readFile(
    path.join(repositoryRoot, 'routers/public_menu/publicMenuQueries.js'),
    'utf8'
  );
  const start = source.indexOf('export const insertPublicPedidoDetalleQuery');
  const section = source.slice(start);
  const baseValuesBlock = section.match(/const values = \[([\s\S]*?)\];/)?.[1] || '';
  const basePlaceholders = [...baseValuesBlock.matchAll(/'\$(\d+)'/g)].map((match) => Number(match[1]));

  assert.deepEqual(basePlaceholders, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.match(section, /columns\.push\('configuracion_menu'\)/);
  assert.match(section, /values\.push\(`\$\$\{params\.length\}::jsonb`\)/);
});
