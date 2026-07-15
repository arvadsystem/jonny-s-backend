import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveExtrasInventory } from '../services/extrasInventoryService.js';

const buildQueryRunner = ({ hasBranchAssignment = true, stock = 0 } = {}) => ({
  queries: [],
  async query(sql) {
    this.queries.push(sql);
    if (sql.includes('FROM public.menu_extra_almacenes')) {
      return { rows: hasBranchAssignment ? [{ id_extra: 7 }] : [] };
    }
    if (sql.includes('FROM public.insumos i')) {
      return {
        rows: [{
          id_insumo: 77,
          id_unidad_medida: 1,
          estado: true,
          cantidad: stock,
          stock_minimo: 0,
          id_almacen: 6,
          id_sucursal: 6,
          almacen_estado: true
        }]
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const baconExtra = {
  id_extra: 7,
  codigo: 'BACON',
  nombre: 'Bacon',
  precio: 15,
  estado: true,
  id_insumo: 77,
  cant: 2,
  id_unidad_medida: 1
};

describe('resolveExtrasInventory negative stock policy', () => {
  it('keeps an active branch-assigned extra available when stock is zero', async () => {
    const queryRunner = buildQueryRunner({ stock: 0 });

    const [resolved] = await resolveExtrasInventory({
      queryRunner,
      extras: [baconExtra],
      idSucursal: 6,
      masterCatalogEnabled: false
    });

    assert.equal(resolved.id_extra, 7);
    assert.equal(resolved.inventario_configurado, true);
    assert.equal(resolved.disponible, true);
    assert.equal(resolved.stock_disponible, 0);
    assert.equal(resolved.codigo_no_disponible, null);
  });

  it('still blocks extras without an active branch assignment', async () => {
    const queryRunner = buildQueryRunner({ hasBranchAssignment: false, stock: 100 });

    const [resolved] = await resolveExtrasInventory({
      queryRunner,
      extras: [baconExtra],
      idSucursal: 6,
      masterCatalogEnabled: false
    });

    assert.equal(resolved.disponible, false);
    assert.equal(resolved.codigo_no_disponible, 'EXTRA_INSUMO_SIN_ASIGNACION_SUCURSAL');
  });
});
