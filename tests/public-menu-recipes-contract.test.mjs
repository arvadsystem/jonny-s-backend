import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('publicacion y catalogo publico conservan PRODUCTO y RECETA como tipos canonicos', async () => {
  const [publicationSource, querySource] = await Promise.all([
    readSource('routers/admin_menu_publicacion.js'),
    readSource('routers/public_menu/publicMenuQueries.js')
  ]);

  assert.match(publicationSource, /PRODUCTO:\s*'PRODUCTO'/);
  assert.match(publicationSource, /RECETA:\s*'RECETA'/);
  assert.match(querySource, /PRODUCTO:\s*'PRODUCTO'/);
  assert.match(querySource, /RECETA:\s*'RECETA'/);

  for (const source of [publicationSource, querySource]) {
    assert.doesNotMatch(source, /\bCOMBO\b|id_combo|detalle_combo|menu_combo_almacenes/i);
  }
});

test('publicaciones obtiene recetas activas y productos sin crear una fuente paralela', async () => {
  const source = await readSource('routers/admin_menu_publicacion.js');

  assert.match(source, /FROM recetas r/);
  assert.match(source, /FROM productos p/);
  assert.match(source, /COALESCE\(r\.estado, true\) = true/);
  assert.match(source, /r\.id_tipo_departamento = ANY\(\$2::int\[\]\)/);
  assert.match(source, /FROM public\.menu_publicacion_reglas/);
  assert.match(source, /FROM detalle_menu dm/);
});

test('catalogo publico aplica receta, sucursal, visibilidad, precio y orden desde detalle_menu', async () => {
  const source = await readSource('routers/public_menu/publicMenuQueries.js');

  assert.match(source, /dm\.id_receta/);
  assert.match(source, /dm\.precio_publico/);
  assert.match(source, /COALESCE\(dm\.visible, true\)/);
  assert.match(source, /pa_branch\.id_sucursal/);
  assert.match(source, /menu_receta_almacenes/);
  assert.match(source, /ORDER BY COALESCE\(dm\.orden, 2147483647\), dm\.id_detalle_menu/);
});

test('servicio publico conserva los campos minimos requeridos por el Landing', async () => {
  const source = await readSource('routers/public_menu/publicMenuService.js');

  for (const field of [
    'id_detalle_menu',
    'tipo_item',
    'id_receta',
    'nombre',
    'descripcion',
    'imagen_url',
    'precio',
    'disponibilidad',
    'visible',
    'orden'
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }
});

test('catalogo publico reutiliza y libera un unico cliente del pool por resolucion', async () => {
  const source = await readSource('routers/public_menu/publicMenuService.js');
  const catalogBuilder = source.slice(
    source.indexOf('const buildPublicCatalog'),
    source.indexOf('export const getPublicCatalogService')
  );

  assert.match(catalogBuilder, /const client = await pool\.connect\(\)/);
  assert.match(catalogBuilder, /fetchActiveMenuByBranchQuery\(idSucursal, client\)/);
  assert.match(catalogBuilder, /fetchCatalogRowsByMenuQuery\([\s\S]*?client\s*\)/);
  assert.match(catalogBuilder, /buildCatalogSauceConfigByDetail\(rows, idSucursal, client\)/);
  assert.match(catalogBuilder, /buildCatalogExtrasByRecipe\(rows, Number\(idSucursal\), client\)/);
  assert.match(catalogBuilder, /fetchRecipeAvailabilityQuery\([\s\S]*?client\s*\)/);
  assert.match(catalogBuilder, /finally\s*{\s*client\.release\(\);\s*}/);
});
