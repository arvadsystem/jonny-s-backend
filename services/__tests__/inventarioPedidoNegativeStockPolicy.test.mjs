import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { validarYDescontarPedido } from '../inventarioPedidoService.js';

const previousCatalogoMaestroFlag = process.env.CATALOGO_MAESTRO_READS_ENABLED;

before(() => {
  process.env.CATALOGO_MAESTRO_READS_ENABLED = 'false';
});

after(() => {
  if (previousCatalogoMaestroFlag === undefined) {
    delete process.env.CATALOGO_MAESTRO_READS_ENABLED;
  } else {
    process.env.CATALOGO_MAESTRO_READS_ENABLED = previousCatalogoMaestroFlag;
  }
});

const productPayload = ({ quantity = 1, idPedido = 7001 } = {}) => ({
  id_sucursal: 1,
  id_pedido: idPedido,
  items: [{
    tipo_item: 'PRODUCTO',
    id_producto: 101,
    id_detalle_pedido: 5001,
    cantidad: quantity
  }]
});

const recipePayload = ({ quantity = 1, idPedido = 8001 } = {}) => ({
  id_sucursal: 1,
  id_pedido: idPedido,
  items: [{
    tipo_item: 'RECETA',
    id_receta: 201,
    id_detalle_pedido: 6001,
    cantidad: quantity
  }]
});

const buildInventoryClient = ({
  productExists = true,
  productStock = 10,
  productWarehouseId = 11,
  warehouses = [{ id_almacen: 11, id_sucursal: 1, estado: true }],
  recipeExists = true,
  recipeComponents = [{ id_receta: 201, id_insumo: 301, insumo_factor: 2 }],
  insumoExists = true,
  insumoStock = 10
} = {}) => {
  const queries = [];
  const movementInserts = [];

  return {
    queries,
    movementInserts,
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });

      if (text.includes('FROM public.sucursales')) {
        return { rowCount: 1, rows: [{ id_sucursal: 1, nombre_sucursal: 'Sucursal QA', estado: true }] };
      }
      if (text.includes('FROM public.movimientos_inventario') && text.includes('LIMIT 1')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('information_schema.columns')) {
        const exists = params[0] === 'detalle_recetas' && params[1] === 'cant';
        return { rowCount: exists ? 1 : 0, rows: exists ? [{ exists: 1 }] : [] };
      }
      if (text.includes('FROM public.recetas')) {
        return {
          rowCount: recipeExists ? 1 : 0,
          rows: recipeExists ? [{ id_receta: 201, nombre_receta: 'Receta E2E', estado: true }] : []
        };
      }
      if (text.includes('FROM public.detalle_recetas')) {
        return { rowCount: recipeComponents.length, rows: recipeComponents };
      }
      if (text.includes('FROM public.productos p') && text.includes('LEFT JOIN public.almacenes')) {
        return {
          rowCount: productExists ? 1 : 0,
          rows: productExists ? [{
            id_producto: 101,
            id_producto_maestro: 101,
            nombre_producto: 'Producto directo',
            estado: true,
            cantidad: productStock,
            stock_minimo: 0,
            id_almacen: productWarehouseId,
            id_sucursal: 1
          }] : []
        };
      }
      if (text.includes('FROM public.insumos i') && !text.includes('INNER JOIN')) {
        return {
          rowCount: insumoExists ? 1 : 0,
          rows: insumoExists ? [{
            id_insumo: 301,
            nombre_insumo: 'Insumo receta',
            estado: true,
            cantidad: insumoStock,
            stock_minimo: 0,
            id_almacen: 11
          }] : []
        };
      }
      if (text.includes('FROM public.almacenes a')) {
        const requestedIds = new Set((params[0] || []).map(Number));
        const rows = warehouses.filter((row) => requestedIds.has(Number(row.id_almacen)));
        return { rowCount: rows.length, rows };
      }
      if (text.includes('INSERT INTO public.movimientos_inventario')) {
        movementInserts.push({ sql: text, params });
        return { rowCount: Math.max(Math.floor(params.length / 10), 1), rows: [] };
      }

      throw new Error(`Consulta inesperada en stub de inventario: ${text}`);
    }
  };
};

const buildAmbiguousMasterProductClient = () => {
  const queries = [];
  const movementInserts = [];
  return {
    queries,
    movementInserts,
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      if (text.includes('FROM public.sucursales')) {
        return { rowCount: 1, rows: [{ id_sucursal: 1, nombre_sucursal: 'Sucursal QA', estado: true }] };
      }
      if (text.includes('FROM public.movimientos_inventario') && text.includes('LIMIT 1')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('COUNT(DISTINCT pm.id_producto_maestro)')) {
        return { rowCount: 1, rows: [{ input_id: 101, total_maestros: 0, id_producto_maestro: null }] };
      }
      if (text.includes('SELECT DISTINCT pm.id_producto_maestro')) {
        return { rowCount: 1, rows: [{ id_producto_maestro: 101 }] };
      }
      if (text.includes('FROM public.productos p') && !text.includes('JOIN')) {
        return { rowCount: 1, rows: [{ id_producto: 101, nombre_producto: 'Producto maestro', estado: true }] };
      }
      if (text.includes('FROM public.productos_almacenes pa') && text.includes('COUNT(*)')) {
        return { rowCount: 1, rows: [{ id_producto_maestro: 101, total_asignaciones: 2 }] };
      }
      throw new Error(`Consulta inesperada en stub ambiguo: ${text}`);
    }
  };
};

const runProductCase = async ({ stock, quantity, allowNegativeStock = true, idPedido }) => {
  const client = buildInventoryClient({ productStock: stock });
  const result = await validarYDescontarPedido(
    productPayload({ quantity, idPedido }),
    {
      dbClient: client,
      allowNegativeStock,
      allowIncompleteConfiguration: false,
      shortageMode: 'FALTANTE_COCINA'
    }
  );
  return { client, result };
};

describe('politica transaccional de deficit de inventario por pedido', () => {
  it('permite stock positivo suficiente sin warning', async () => {
    const { client, result } = await runProductCase({ stock: 10, quantity: 5, idPedido: 7101 });

    assert.equal(result.ok, true);
    assert.equal(result.warning, null);
    assert.equal(client.movementInserts.length, 1);
    assert.equal(client.movementInserts[0].params[0], 5);
  });

  for (const scenario of [
    { label: 'stock positivo insuficiente', stock: 5, quantity: 7, projected: -2, idPedido: 7102 },
    { label: 'stock cero', stock: 0, quantity: 1, projected: -1, idPedido: 7103 },
    { label: 'stock negativo', stock: -3, quantity: 2, projected: -5, idPedido: 7104 }
  ]) {
    it(`permite ${scenario.label}, registra consumo y conserva warning`, async () => {
      const { client, result } = await runProductCase(scenario);
      const movement = client.movementInserts[0];

      assert.equal(result.ok, true);
      assert.equal(result.warning?.code, 'STOCK_INSUFICIENTE_PERMITIDO');
      assert.equal(result.warning?.faltantes?.[0]?.motivo, 'STOCK_INSUFICIENTE');
      assert.equal(movement.params[0], scenario.quantity);
      assert.equal(scenario.stock - movement.params[0], scenario.projected);
      assert.match(movement.params[9], /req:|disp:|def:/);
    });
  }

  it('permite receta cuyo consumo de insumo deja balance negativo', async () => {
    const client = buildInventoryClient({ insumoStock: 1 });
    const result = await validarYDescontarPedido(recipePayload({ quantity: 2 }), {
      dbClient: client,
      allowNegativeStock: true,
      allowIncompleteConfiguration: false,
      shortageMode: 'FALTANTE_COCINA'
    });
    const movement = client.movementInserts[0];

    assert.equal(result.ok, true);
    assert.equal(result.warning?.code, 'STOCK_INSUFICIENTE_PERMITIDO');
    assert.equal(movement.params[0], 4);
    assert.equal(1 - movement.params[0], -3);
    assert.equal(movement.params[5], 'RECETA');
  });

  it('mantiene el default generico seguro y bloquea deficit sin opt-in explicito', async () => {
    const { client, result } = await runProductCase({
      stock: 0,
      quantity: 1,
      allowNegativeStock: false,
      idPedido: 7105
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'STOCK_O_CONFIG_INSUFICIENTE');
    assert.equal(client.movementInserts.length, 0);
  });

  it('bloquea producto sin asignacion de almacen aunque el deficit este permitido', async () => {
    const client = buildInventoryClient({ productStock: 0, productWarehouseId: null });
    const result = await validarYDescontarPedido(productPayload({ idPedido: 7106 }), {
      dbClient: client,
      allowNegativeStock: true,
      allowIncompleteConfiguration: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONFIGURACION_INVENTARIO_INVALIDA');
    assert.equal(result.faltantes[0].motivo, 'PRODUCTO_SIN_ALMACEN');
    assert.equal(client.movementInserts.length, 0);
  });

  it('bloquea producto inexistente aunque el deficit este permitido', async () => {
    const client = buildInventoryClient({ productExists: false });
    const result = await validarYDescontarPedido(productPayload({ idPedido: 7108 }), {
      dbClient: client,
      allowNegativeStock: true,
      allowIncompleteConfiguration: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONFIGURACION_INVENTARIO_INVALIDA');
    assert.equal(result.faltantes[0].motivo, 'PRODUCTO_NO_ENCONTRADO');
    assert.equal(client.movementInserts.length, 0);
  });

  it('bloquea almacen inexistente aunque el deficit este permitido', async () => {
    const client = buildInventoryClient({ productStock: 0, warehouses: [] });
    const result = await validarYDescontarPedido(productPayload({ idPedido: 7107 }), {
      dbClient: client,
      allowNegativeStock: true,
      allowIncompleteConfiguration: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONFIGURACION_INVENTARIO_INVALIDA');
    assert.equal(result.faltantes[0].motivo, 'ALMACEN_NO_ENCONTRADO');
    assert.equal(client.movementInserts.length, 0);
  });

  it('bloquea receta sin componentes aunque el deficit este permitido', async () => {
    const client = buildInventoryClient({ recipeComponents: [] });
    const result = await validarYDescontarPedido(recipePayload({ idPedido: 8102 }), {
      dbClient: client,
      allowNegativeStock: true,
      allowIncompleteConfiguration: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONFIGURACION_INVENTARIO_INVALIDA');
    assert.equal(result.faltantes[0].motivo, 'RECETA_SIN_COMPONENTES');
    assert.equal(client.movementInserts.length, 0);
  });

  it('bloquea insumo inexistente de receta aunque el deficit este permitido', async () => {
    const client = buildInventoryClient({ insumoExists: false });
    const result = await validarYDescontarPedido(recipePayload({ idPedido: 8103 }), {
      dbClient: client,
      allowNegativeStock: true,
      allowIncompleteConfiguration: false
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CONFIGURACION_INVENTARIO_INVALIDA');
    assert.equal(result.faltantes[0].motivo, 'INSUMO_NO_ENCONTRADO');
    assert.equal(client.movementInserts.length, 0);
  });

  it('bloquea asignacion maestra ambigua aunque el deficit este permitido', async () => {
    process.env.CATALOGO_MAESTRO_READS_ENABLED = 'true';
    const client = buildAmbiguousMasterProductClient();
    try {
      const result = await validarYDescontarPedido(productPayload({ idPedido: 7109 }), {
        dbClient: client,
        allowNegativeStock: true,
        allowIncompleteConfiguration: false
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'CONFIGURACION_INVENTARIO_INVALIDA');
      assert.equal(result.faltantes[0].motivo, 'PRODUCTO_MAESTRO_ASIGNACION_AMBIGUA');
      assert.equal(client.movementInserts.length, 0);
    } finally {
      process.env.CATALOGO_MAESTRO_READS_ENABLED = 'false';
    }
  });

  it('rechaza payload invalido antes de consultar o registrar movimientos', async () => {
    const client = buildInventoryClient();

    await assert.rejects(
      () => validarYDescontarPedido({ id_sucursal: 1, id_pedido: 1, items: [] }, {
        dbClient: client,
        allowNegativeStock: true,
        allowIncompleteConfiguration: false
      }),
      (error) => error?.code === 'VALIDATION_ERROR' && error?.httpStatus === 400
    );
    assert.equal(client.queries.length, 0);
  });
});
