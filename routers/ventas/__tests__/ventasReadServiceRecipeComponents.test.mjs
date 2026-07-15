import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchRecetaMap,
  fetchVentaCatalogMaps
} from '../services/ventasReadService.js';

const createQueryCaptureClient = (responses = []) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return responses.shift() || { rows: [] };
    }
  };
};

const assertRecipeComponentsSql = (sql) => {
  assert.match(sql, /ORDER BY\s+dr\.id_detalle\b/);
  assert.doesNotMatch(sql, /id_detalle_receta/);
  assert.match(sql, /public\.detalle_recetas\s+dr/);
  assert.match(sql, /'id_insumo',\s*dr\.id_insumo/);
  assert.match(sql, /'cantidad',\s*dr\.cant/);
};

describe('ventasReadService recipe components SQL', () => {
  it('fetchRecetaMap ordena componentes por id_detalle real', async () => {
    const client = createQueryCaptureClient([{ rows: [] }]);

    await fetchRecetaMap(client, [1]);

    assert.equal(client.queries.length, 1);
    assertRecipeComponentsSql(client.queries[0].sql);
    assert.deepEqual(client.queries[0].params, [[1]]);
  });

  it('fetchVentaCatalogMaps ordena componentes por id_detalle real', async () => {
    const client = createQueryCaptureClient([{ rows: [{ recetas: [] }] }]);

    await fetchVentaCatalogMaps(client, {
      productoIds: [],
      recetaIds: [1],
      lockProductos: false,
      idSucursal: 1
    });

    assert.equal(client.queries.length, 1);
    assertRecipeComponentsSql(client.queries[0].sql);
    assert.deepEqual(client.queries[0].params, [[1], 1]);
  });
});
