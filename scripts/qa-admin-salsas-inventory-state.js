import assert from 'node:assert/strict';
import { buildInventoryState } from '../routers/admin_salsas/services/salsaInventoryAdminStateService.js';

const baseSalsa = {
  id_salsa: 10,
  nombre: 'Buffalo',
  estado: true,
  id_insumo: 33,
  cantidad_porcion: 2,
  id_unidad_consumo: 7,
  insumo_nombre: 'Salsa buffalo',
  insumo_estado: true,
  id_unidad_base: 7,
  id_insumo_maestro: 44,
  insumo_maestro_nombre: 'Salsa buffalo maestro',
  insumo_maestro_estado: true,
  id_unidad_base_maestro: 7,
  unidad_consumo_simbolo: 'oz',
  conversiones_aplicables: 0
};

const assertBlocked = (label, row) => {
  const state = buildInventoryState(row);
  assert.notEqual(state.inventario_estado, 'LISTA', `${label}: no debe quedar LISTA`);
  assert.equal(state.inventario_configurado, false, `${label}: no debe quedar configurada`);
  assert.equal(state.puede_asignarse_receta, false, `${label}: no debe poder asignarse a receta`);
};

{
  const state = buildInventoryState({
    ...baseSalsa,
    mapping_count: 1,
    estado_mapeo_maestro: 'VALIDADO'
  });
  assert.equal(state.inventario_estado, 'LISTA', 'mapeo VALIDADO debe quedar LISTA');
  assert.equal(state.inventario_configurado, true, 'mapeo VALIDADO debe quedar configurado');
  assert.equal(state.puede_asignarse_receta, true, 'mapeo VALIDADO debe poder asignarse');
  assert.equal(state.id_insumo_resuelto, 44, 'mapeo VALIDADO debe resolver al insumo maestro');
}

{
  const state = buildInventoryState({
    ...baseSalsa,
    id_unidad_consumo: 7,
    id_unidad_base_maestro: 9,
    mapping_count: 1,
    estado_mapeo_maestro: 'VALIDADO',
    conversiones_aplicables: 1
  });
  assert.equal(state.inventario_estado, 'LISTA', 'legacy VALIDADO debe validar conversion contra unidad base maestra');
  assert.equal(state.id_insumo_resuelto, 44, 'legacy VALIDADO con unidad distinta debe resolver al maestro');
}

assertBlocked('mapeo REQUIERE_REVISION', {
  ...baseSalsa,
  mapping_count: 1,
  estado_mapeo_maestro: 'REQUIERE_REVISION'
});

assertBlocked('mapeo PENDIENTE', {
  ...baseSalsa,
  mapping_count: 1,
  estado_mapeo_maestro: 'PENDIENTE'
});

assertBlocked('mapeo AMBIGUO', {
  ...baseSalsa,
  mapping_count: 1,
  estado_mapeo_maestro: 'AMBIGUO'
});

assertBlocked('mas de un mapeo', {
  ...baseSalsa,
  mapping_count: 2,
  estado_mapeo_maestro: 'VALIDADO'
});

assertBlocked('cambio posterior de VALIDADO a REQUIERE_REVISION', {
  ...baseSalsa,
  mapping_count: 1,
  estado_mapeo_maestro: 'REQUIERE_REVISION'
});

console.log('OK admin salsas inventory state mapping rules');
