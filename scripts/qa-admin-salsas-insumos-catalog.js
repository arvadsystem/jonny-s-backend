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
assert.match(routeSource, /ci\.codigo_categoria\s*=\s*'INS-002'/, 'el SQL debe filtrar la categoria canonica INS-002');
assert.match(routeSource, /ci\.nombre_categoria\)\)\s*=\s*'SALSAS Y ADEREZOS'/, 'el SQL debe confirmar el nombre de la categoria canonica');
assert.match(routeSource, /ci\.estado\s+IS\s+TRUE/, 'el SQL debe exigir categoria activa');
assert.match(routeSource, /v\.estado_global\s+IS\s+TRUE/, 'el SQL debe exigir maestro activo');
assert.match(routeSource, /v\.estado_local\s+IS\s+TRUE/, 'el SQL debe exigir estado local activo');
assert.doesNotMatch(routeSource, /insumos_mapeo_maestro|id_insumo_legacy/, 'el catalogo no debe consultar ni exponer IDs legacy');
assert.match(routeSource, /otros_disponibles:\s*\[\]/, 'el contrato debe conservar otros_disponibles vacio');
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
  codigo_categoria: 'INS-002',
  categoria_nombre: categoria,
  estado: true,
  mapping_count: legacyIds.length,
  ids_insumo_legacy: legacyIds,
  estados_mapeo_maestro: statuses,
  conversiones_disponibles: []
});

const catalog = buildAdminSalsasInsumosCatalog([
  makeRow({
    id: 30,
    nombre: 'SALSA CAJUN',
    idAlmacen: 1,
    legacyIds: [30, 191],
    statuses: ['VALIDADO']
  }),
  makeRow({
    id: 30,
    nombre: 'SALSA CAJUN',
    idAlmacen: 2,
    legacyIds: [30, 191],
    statuses: ['VALIDADO']
  }),
  makeRow({
    id: 31,
    nombre: 'SALSA CHIPOTLE',
    idAlmacen: 1,
    legacyIds: [],
    statuses: ['VALIDADO']
  }),
  makeRow({
    id: 31,
    nombre: 'SALSA CHIPOTLE',
    idAlmacen: 2,
    legacyIds: [],
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
assert.equal(cajunRows[0].id_insumo, 30, 'la opcion SALSA CAJUN debe publicar el maestro #30');
assert.equal(cajunRows[0].seleccionable, true, 'SALSA CAJUN VALIDADA debe quedar seleccionable');
assert.equal(cajunRows[0].estado_mapeo_maestro, 'VALIDADO');
assert.equal('ids_insumo_legacy' in cajunRows[0], false, 'los IDs legacy no deben exponerse al nivel visual');
assert.equal('ids_insumo_legacy' in cajunRows[0].metadata, false, 'los IDs legacy tampoco deben exponerse como metadata');

const blockedCajun = buildAdminSalsasInsumosCatalog([
  makeRow({
    id: 30,
    nombre: 'SALSA CAJUN',
    idAlmacen: 1,
    legacyIds: [30, 191],
    statuses: ['REQUIERE_REVISION', 'VALIDADO']
  })
])[0];
assert.equal(blockedCajun.seleccionable, false, 'un mapeo REQUIERE_REVISION debe mantener bloqueado el maestro');
assert.match(blockedCajun.motivo_bloqueo, /maestro #30.*legacy #191.*revision manual/i);

const saneadas = buildAdminSalsasInsumosCatalog([
  [22, 189, 'SALSA BARBACOA'],
  [30, 191, 'SALSA CAJUN'],
  [24, 193, 'SALSA HONEY HOT'],
  [20, 195, 'SALSA MIEL MOSTAZA'],
  [23, 125, 'SALSA SWEET CHILI']
].flatMap(([masterId, legacyId, nombre]) => [1, 2].map((idAlmacen) => makeRow({
  id: masterId,
  nombre,
  idAlmacen,
  legacyIds: [masterId, legacyId],
  statuses: ['VALIDADO']
}))));
assert.equal(saneadas.length, 5, 'las cinco salsas saneadas deben producir cinco opciones sin duplicados por almacen');
assert.ok(saneadas.every((item) => item.seleccionable), 'las cinco salsas saneadas deben quedar seleccionables');
assert.deepEqual(saneadas.map((item) => item.id_insumo).sort((a, b) => a - b), [20, 22, 23, 24, 30]);

const chipotleRows = catalog.filter((item) => item.id_insumo === 31);
assert.equal(chipotleRows.length, 1, 'un maestro VALIDADO debe aparecer una sola vez');
assert.equal(chipotleRows[0].seleccionable, true, 'un maestro VALIDADO sin conflicto debe ser seleccionable');
assert.equal(chipotleRows[0].indicador_maestro_legacy, 'MAESTRO', 'un automapeo debe marcarse como MAESTRO');
assert.equal(chipotleRows[0].codigo_categoria, 'INS-002');

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
