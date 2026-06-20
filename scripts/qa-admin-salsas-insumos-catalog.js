import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAdminSalsasInsumosCatalog } from '../routers/admin_salsas/services/adminSalsasInsumosCatalogService.js';

const routerSource = readFileSync(new URL('../routers/admin_salsas.js', import.meta.url), 'utf8');
const routeStart = routerSource.indexOf("router.get('/catalogos/insumos'");
const routeEnd = routerSource.indexOf("router.get('/recetas/:id_receta/config'", routeStart);
const routeSource = routerSource.slice(routeStart, routeEnd);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'la QA debe localizar el handler del catalogo de insumos');
assert.match(routeSource, /queryCatalogoMaestroView/, 'el handler debe usar queryCatalogoMaestroView');
assert.match(routeSource, /public\.vw_insumos_maestros_almacen/, 'el handler debe consultar la vista maestra');
assert.doesNotMatch(
  routeSource,
  /FROM\s+public\.insumos\s+i\b/i,
  'el handler no debe volver a enumerar directamente public.insumos'
);

const makeRow = ({
  id,
  nombre,
  idAlmacen,
  legacyIds,
  statuses,
  categoria = 'SALSAS Y ADEREZOS'
}) => ({
  id_insumo: id,
  id_insumo_maestro: id,
  nombre,
  id_almacen: idAlmacen,
  id_unidad_medida: 7,
  unidad_nombre: 'Onza',
  unidad_simbolo: 'oz',
  unidad_etiqueta: 'oz',
  id_categoria_insumo: 4,
  categoria_nombre: categoria,
  estado: true,
  mapping_count: legacyIds.length,
  ids_insumo_legacy: legacyIds,
  estados_mapeo_maestro: statuses,
  conversiones_disponibles: []
});

const catalog = buildAdminSalsasInsumosCatalog([
  makeRow({
    id: 191,
    nombre: 'SALSA CAJUN',
    idAlmacen: 1,
    legacyIds: [30, 191],
    statuses: ['REQUIERE_REVISION', 'VALIDADO']
  }),
  makeRow({
    id: 191,
    nombre: 'SALSA CAJUN',
    idAlmacen: 2,
    legacyIds: [30, 191],
    statuses: ['REQUIERE_REVISION', 'VALIDADO']
  }),
  makeRow({
    id: 205,
    nombre: 'SALSA CHIPOTLE',
    idAlmacen: 1,
    legacyIds: [205],
    statuses: ['VALIDADO']
  }),
  makeRow({
    id: 205,
    nombre: 'SALSA CHIPOTLE',
    idAlmacen: 2,
    legacyIds: [205],
    statuses: ['VALIDADO']
  }),
  makeRow({
    id: 33,
    nombre: 'SALSA BBQ',
    idAlmacen: 1,
    legacyIds: [33],
    statuses: ['VALIDADO']
  }),
  makeRow({
    id: 190,
    nombre: 'salsa bbq',
    idAlmacen: 1,
    legacyIds: [190],
    statuses: ['VALIDADO']
  })
]);

const cajunRows = catalog.filter((item) => item.nombre === 'SALSA CAJUN');
assert.equal(cajunRows.length, 1, '#30 y #191 SALSA CAJUN deben producir una sola opcion visual');
assert.equal(cajunRows[0].id_insumo, 191, 'la opcion SALSA CAJUN debe usar el ID maestro');
assert.equal(cajunRows[0].seleccionable, false, 'SALSA CAJUN debe seguir bloqueada con REQUIERE_REVISION');
assert.match(
  cajunRows[0].motivo_bloqueo,
  /maestro #191.*legacy #30.*REQUIERE_REVISION/i,
  'el bloqueo debe identificar maestro, legacy y estado pendiente'
);
assert.deepEqual(cajunRows[0].metadata.ids_insumo_legacy, [30], 'el ID legacy debe existir solo como metadata');
assert.equal('ids_insumo_legacy' in cajunRows[0], false, 'los IDs legacy no deben exponerse al nivel visual');

const chipotleRows = catalog.filter((item) => item.id_insumo === 205);
assert.equal(chipotleRows.length, 1, 'un maestro VALIDADO debe aparecer una sola vez');
assert.equal(chipotleRows[0].seleccionable, true, 'un maestro VALIDADO sin conflicto debe ser seleccionable');
assert.equal(chipotleRows[0].indicador_maestro_legacy, 'MAESTRO', 'un automapeo debe marcarse como MAESTRO');
assert.deepEqual(chipotleRows[0].metadata.ids_insumo_legacy, [], 'el automapeo no debe publicarse como ID legacy');

const duplicateNameRows = catalog.filter((item) => [33, 190].includes(item.id_insumo));
assert.equal(duplicateNameRows.length, 2, 'los dos maestros con el mismo nombre deben conservar trazabilidad');
assert.ok(duplicateNameRows.every((item) => item.seleccionable === false), 'los maestros homonimos no deben ser opciones normales');
assert.ok(
  duplicateNameRows.every((item) => item.estado_configuracion === 'CONFLICTO_DATOS'),
  'los maestros homonimos deben reportarse como conflicto de datos'
);
assert.ok(
  duplicateNameRows.every((item) => /#33, #190/.test(item.motivo_bloqueo)),
  'el conflicto debe identificar los maestros involucrados'
);

console.log('OK admin salsas insumos catalog contract QA');
