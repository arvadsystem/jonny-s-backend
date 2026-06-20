import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifySalsaPublicationInventory,
  normalizeSalsaSucursalPublicationPayload
} from '../routers/admin_salsas/services/salsaSucursalPublicationService.js';
import { buildVentaComplementCatalogCacheKey } from '../routers/ventas/services/complementosCatalogService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

const [migration, adminRouter, inventoryService, complementService, publicQueries, publicService, snapshotService] = await Promise.all([
  read('sql/2026-06-20_salsas_publicacion_sucursal.sql'),
  read('routers/admin_salsas.js'),
  read('routers/ventas/services/salsasInventoryService.js'),
  read('routers/ventas/services/complementosCatalogService.js'),
  read('routers/public_menu/publicMenuQueries.js'),
  read('routers/public_menu/publicMenuService.js'),
  read('services/salsasPedidoSnapshotService.js')
]);

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.salsa_sucursales/i);
assert.match(migration, /UNIQUE \(id_salsa, id_sucursal\)/i);
assert.match(migration, /LOWER\(BTRIM\(nombre\)\)/i);
assert.match(migration, /ON CONFLICT \(id_salsa, id_sucursal\) DO NOTHING/i);
assert.doesNotMatch(migration, /UPDATE\s+public\.insumos_almacenes/i);
assert.doesNotMatch(migration, /INSERT\s+INTO\s+public\.movimientos_inventario/i);

assert.match(adminRouter, /router\.get\('\/:id_salsa\/sucursales'/);
assert.match(adminRouter, /router\.put\('\/:id_salsa\/sucursales'/);
assert.match(adminRouter, /publicacion_estado/);
assert.match(adminRouter, /LOWER\(BTRIM\(nombre\)\) = LOWER\(BTRIM\(\$1\)\)/);

assert.match(inventoryService, /SALSA_NO_PUBLICADA_SUCURSAL/);
assert.match(inventoryService, /INNER JOIN public\.salsa_sucursales ss/);
assert.match(publicQueries, /ss\.id_sucursal = \$2/);
assert.match(publicQueries, /ss\.publicada IS TRUE/);
assert.match(publicService, /attachSalsaInventorySnapshotsToPublicLines/);
assert.match(snapshotService, /config\?\.salsas_por_unidad/);

const branch1Key = buildVentaComplementCatalogCacheKey({ recipeIds: [1], comboIds: [2], idSucursal: 1 });
const branch6Key = buildVentaComplementCatalogCacheKey({ recipeIds: [1], comboIds: [2], idSucursal: 6 });
assert.notEqual(branch1Key, branch6Key, 'El cache de Caja debe estar aislado por sucursal.');
assert.match(complementService, /ss\.id_sucursal = \$3/);

assert.deepEqual(normalizeSalsaSucursalPublicationPayload({
  sucursales: [{ id_sucursal: 1, publicada: true }]
}), { ok: true, sucursales: [{ id_sucursal: 1, publicada: true }] });
assert.equal(normalizeSalsaSucursalPublicationPayload({
  sucursales: [{ id_sucursal: 1, publicada: true }, { id_sucursal: 1, publicada: false }]
}).ok, false);

assert.deepEqual(classifySalsaPublicationInventory({
  salsaActiva: true,
  inventory: { disponible: true }
}), { puede_publicarse: true, codigo_bloqueo: null, motivo_bloqueo: null });
const blocked = classifySalsaPublicationInventory({
  salsaActiva: true,
  inventory: { disponible: false, codigo_no_disponible: 'SALSA_INSUMO_MAPEO_REQUIERE_REVISION' }
});
assert.equal(blocked.codigo_bloqueo, 'SALSA_INSUMO_INVALIDO');
assert.match(blocked.motivo_bloqueo, /mapeo maestro validado/i);

console.log('QA salsas publicacion por sucursal: OK');
process.exit(0);
