import assert from 'node:assert/strict';
import { buildInventoryState } from '../routers/admin_salsas/services/salsaInventoryAdminStateService.js';
import { classifySalsaMapping } from '../routers/ventas/services/salsasInventoryPolicyService.js';

const makeSalsa = (id, overrides = {}) => ({
  id_salsa: id,
  nombre: `Salsa ${String(id).padStart(2, '0')}`,
  estado: true,
  nivel_picante: id % 6,
  orden: id,
  id_insumo: 100 + id,
  cantidad_porcion: 2,
  id_unidad_consumo: 7,
  insumo_nombre: `Insumo salsa ${id}`,
  insumo_estado: true,
  id_unidad_base: 7,
  unidad_consumo_simbolo: 'oz',
  mapping_count: 0,
  conversiones_aplicables: 0,
  ...overrides
});

const attach = (rows) => rows.map((row) => ({ ...row, ...buildInventoryState(row) }));

const listContract = (rows, {
  page = 1,
  limit = 10,
  search = '',
  onlyInactive = false,
  includeInactive = false,
  sortDir = 'asc'
} = {}) => {
  const term = String(search || '').trim().toLowerCase();
  let scoped = rows.filter((row) => {
    const active = row.estado !== false;
    if (onlyInactive) return !active;
    if (!includeInactive) return active;
    return true;
  });
  if (term) {
    scoped = scoped.filter((row) => (
      String(row.nombre || '').toLowerCase().includes(term)
      || String(row.id_salsa).includes(term)
      || String(row.insumo_nombre || '').toLowerCase().includes(term)
    ));
  }
  scoped = [...scoped].sort((left, right) => (
    sortDir === 'desc'
      ? Number(right.orden) - Number(left.orden)
      : Number(left.orden) - Number(right.orden)
  ));
  const withState = attach(scoped);
  const activeRows = withState.filter((row) => row.estado !== false);
  const listas = activeRows.filter((row) => row.inventario_estado === 'LISTA').length;
  const pendientes = activeRows.filter((row) => row.inventario_estado === 'PENDIENTE' || !row.inventario_estado).length;
  return {
    items: withState.slice((page - 1) * limit, page * limit),
    pagination: {
      page,
      limit,
      total: withState.length,
      totalPages: Math.max(1, Math.ceil(withState.length / limit))
    },
    summary: {
      activas: activeRows.length,
      listas,
      pendientes,
      errores: Math.max(0, activeRows.length - listas - pendientes)
    },
    next_order: Math.max(1, ...rows.map((row) => Number(row.orden || 0))) + 1
  };
};

const rows11 = Array.from({ length: 11 }, (_, index) => makeSalsa(index + 1));
assert.equal(listContract(rows11, { page: 1 }).items.length, 10, 'listado 11 registros pagina 1 debe devolver 10');
assert.equal(listContract(rows11, { page: 2 }).items.length, 1, 'listado 11 registros pagina 2 debe devolver 1');
assert.equal(listContract(rows11, { search: 'Salsa 11' }).items.length, 1, 'busqueda debe filtrar por nombre');

const mixedRows = rows11.map((row, index) => index < 3 ? { ...row, estado: false } : row);
assert.equal(listContract(mixedRows).pagination.total, 8, 'activos debe excluir inactivos por defecto');
assert.equal(listContract(mixedRows, { onlyInactive: true, includeInactive: true }).pagination.total, 3, 'inactivos debe incluir solo inactivos');
assert.equal(listContract(mixedRows, { includeInactive: true }).pagination.total, 11, 'todos debe incluir activos e inactivos');

const recipeCatalog = attach(rows11);
const pageOneIds = new Set(listContract(rows11, { page: 1 }).items.map((row) => row.id_salsa));
assert.equal(recipeCatalog.length, 11, 'catalogo de receta debe conservar 11 registros aunque tabla este en pagina 1');
assert.equal(pageOneIds.has(11), false, 'salsa 11 debe estar fuera de pagina 1');
assert.ok(recipeCatalog.find((row) => row.id_salsa === 11), 'asignacion fuera de pagina actual debe existir en catalogo de receta');

const rows25 = Array.from({ length: 25 }, (_, index) => makeSalsa(index + 1));
assert.equal(listContract(rows25).next_order, 26, 'proximo orden debe calcularse con mas de 10 salsas');
assert.deepEqual(listContract(rows25).summary, {
  activas: 25,
  listas: 25,
  pendientes: 0,
  errores: 0
}, 'summary debe ser global del alcance');

const legacyValidado = buildInventoryState(makeSalsa(30, {
  id_insumo: 130,
  id_insumo_maestro: 230,
  mapping_count: 1,
  estado_mapeo_maestro: 'VALIDADO',
  id_unidad_base: 7,
  id_unidad_base_maestro: 9,
  insumo_maestro_nombre: 'Salsa maestra',
  insumo_maestro_estado: true,
  conversiones_aplicables: 1
}));
assert.equal(legacyValidado.inventario_estado, 'LISTA', 'legacy VALIDADO con unidad base maestra distinta debe quedar LISTA si hay conversion');
assert.equal(legacyValidado.id_insumo_resuelto, 230, 'legacy VALIDADO debe resolver al maestro');

const requiereRevision = classifySalsaMapping({
  configuredId: 130,
  mappingCount: 1,
  mappingStatus: 'REQUIERE_REVISION',
  masterId: 230,
  masterCatalogEnabled: true
});
assert.equal(requiereRevision.ok, false, 'mapeo REQUIERE_REVISION bloquea aunque exista asignacion directa');
assert.equal(requiereRevision.code, 'SALSA_INSUMO_MAPEO_REQUIERE_REVISION');

const adminBlocked = buildInventoryState(makeSalsa(31, {
  id_insumo: 131,
  id_insumo_maestro: 231,
  mapping_count: 1,
  estado_mapeo_maestro: 'REQUIERE_REVISION',
  insumo_maestro_nombre: 'Salsa maestra',
  insumo_maestro_estado: true,
  id_unidad_base_maestro: 7
}));
assert.equal(adminBlocked.puede_asignarse_receta, false, 'estado administrativo debe ser coherente con resolucion estructural transaccional');

console.log('OK admin salsas router contract QA');
