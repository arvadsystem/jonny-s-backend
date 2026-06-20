import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifySalsaPublicationInventory,
  listSalsaSucursalPublicationState,
  normalizeSalsaSucursalPublicationPayload
} from '../routers/admin_salsas/services/salsaSucursalPublicationService.js';
import { buildVentaComplementCatalogCacheKey } from '../routers/ventas/services/complementosCatalogService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

const [migration, adminRouter, publicationService, inventoryService, complementService, publicQueries, publicService, snapshotService] = await Promise.all([
  read('sql/2026-06-20_salsas_publicacion_sucursal.sql'),
  read('routers/admin_salsas.js'),
  read('routers/admin_salsas/services/salsaSucursalPublicationService.js'),
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
assert.match(migration, /ALTER TABLE public\.salsa_sucursales ENABLE ROW LEVEL SECURITY/i);
assert.doesNotMatch(migration, /CREATE\s+POLICY/i, 'RLS no debe ganar politicas sin auditar el rol PostgreSQL del backend.');
assert.doesNotMatch(migration, /UPDATE\s+public\.insumos_almacenes/i);
assert.doesNotMatch(migration, /INSERT\s+INTO\s+public\.movimientos_inventario/i);
assert.doesNotMatch(migration, /su\.nombre\b/, 'La consulta final debe usar sucursales.nombre_sucursal.');

assert.match(publicationService, /su\.nombre_sucursal/);
assert.match(publicationService, /ORDER BY su\.nombre_sucursal, su\.id_sucursal/);
assert.doesNotMatch(publicationService, /su\.nombre\b/, 'Publicacion de salsas no debe consultar la columna inexistente sucursales.nombre.');
assert.match(publicationService, /nombre_sucursal:\s*branch\.nombre_sucursal/, 'El contrato GET/PUT debe devolver nombre_sucursal.');
assert.match(publicationService, /ON CONFLICT \(id_salsa, id_sucursal\)/i, 'Guardar dos veces debe resolver por UPSERT sin duplicados.');
assert.doesNotMatch(publicationService, /UPDATE\s+public\.insumos_almacenes/i);
assert.doesNotMatch(publicationService, /INSERT\s+INTO\s+public\.movimientos_inventario/i);

assert.match(adminRouter, /router\.get\('\/:id_salsa\/sucursales'/);
assert.match(adminRouter, /router\.put\('\/:id_salsa\/sucursales'/);
assert.match(adminRouter, /publicacion_estado/);
assert.match(adminRouter, /LOWER\(BTRIM\(nombre\)\) = LOWER\(BTRIM\(\$1\)\)/);
assert.match(adminRouter, /invalidateVentasComplementCatalogCache\('publicar salsa por sucursal'\)/);

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
assert.deepEqual(normalizeSalsaSucursalPublicationPayload({
  sucursales: [{ id_sucursal: 1, publicada: false }]
}), { ok: true, sucursales: [{ id_sucursal: 1, publicada: false }] });

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
assert.equal(classifySalsaPublicationInventory({
  salsaActiva: true,
  inventory: { disponible: false, codigo_no_disponible: 'SALSA_INSUMO_NO_CONFIGURADO' }
}).codigo_bloqueo, 'SALSA_INVENTARIO_NO_CONFIGURADO');
assert.equal(classifySalsaPublicationInventory({
  salsaActiva: true,
  inventory: { disponible: false, codigo_no_disponible: 'SALSA_INSUMO_SIN_ASIGNACION_SUCURSAL' }
}).codigo_bloqueo, 'SALSA_SIN_ASIGNACION_INVENTARIO_SUCURSAL');
assert.equal(classifySalsaPublicationInventory({
  salsaActiva: true,
  inventory: { disponible: false, codigo_no_disponible: 'SALSA_STOCK_INSUFICIENTE' }
}).codigo_bloqueo, 'SALSA_SIN_STOCK');

const queryRunner = {
  query: async (sql) => {
    if (/FROM public\.salsas s/i.test(sql)) {
      return {
        rows: [{
          id_salsa: 10,
          nombre: 'Bufalo',
          estado: true,
          id_insumo: null,
          cantidad_porcion: 2,
          id_unidad_consumo: 1
        }]
      };
    }
    if (/FROM public\.sucursales su/i.test(sql)) {
      assert.match(sql, /su\.nombre_sucursal/);
      assert.doesNotMatch(sql, /su\.nombre\b/);
      return {
        rows: [
          { id_sucursal: 1, nombre_sucursal: "Jonny's El Carmen", publicada: true, estado_publicacion: true },
          { id_sucursal: 6, nombre_sucursal: "Jonny's 21 Agosto", publicada: true, estado_publicacion: true }
        ]
      };
    }
    throw new Error(`Consulta inesperada en QA: ${sql}`);
  }
};
const publicationState = await listSalsaSucursalPublicationState(queryRunner, 10);
assert.deepEqual(
  publicationState.sucursales.map(({ id_sucursal, nombre_sucursal, publicada, estado }) => ({
    id_sucursal,
    nombre_sucursal,
    publicada,
    estado
  })),
  [
    { id_sucursal: 1, nombre_sucursal: "Jonny's El Carmen", publicada: true, estado: true },
    { id_sucursal: 6, nombre_sucursal: "Jonny's 21 Agosto", publicada: true, estado: true }
  ],
  'El contrato debe devolver nombre_sucursal y el estado publicado por sucursal.'
);

console.log('QA salsas publicacion por sucursal: OK');
process.exit(0);
