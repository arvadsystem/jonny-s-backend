import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { normalizeVentaItems } from '../services/ventasPayloadService.js';
import { fetchVentaCatalogMaps } from '../services/ventasReadService.js';

const PRODUCT_ID = 101;
const BRANCH_ID = 7;
const WAREHOUSE_ID = 13;

const loadHydrateVentaLines = async () => {
  const source = await readFile(new URL('../../ventas.js', import.meta.url), 'utf8');
  const signature = 'const hydrateVentaLines = ';
  const start = source.indexOf(signature);
  const endMatch = /\r?\n};\r?\n\r?\nconst normalizePedidoCatalogCode/.exec(source.slice(start));
  const end = endMatch ? start + endMatch.index : -1;
  assert.notEqual(start, -1, 'No se encontro hydrateVentaLines en routers/ventas.js.');
  assert.notEqual(end, -1, 'No se encontro el cierre de hydrateVentaLines.');
  const functionEnd = end + (endMatch?.[0].indexOf('};') ?? 0) + 1;
  const expression = source.slice(start + signature.length, functionEnd);
  const dependencyNames = [
    'fetchVentaCatalogMaps',
    'itemHasRequestedExtras',
    'resolvePedidoPendienteAllowedExtrasSchema',
    'buildVentaComplementContext',
    'buildGlobalExtrasMap',
    'buildStandaloneExtraCatalogMap',
    'aggregateProductoQuantities',
    'parseBooleanish',
    'roundMoney',
    'resolveLineComplementos',
    'resolveLineExtras',
    'validateAggregatedExtrasInventory',
    'parseOptionalPositiveInt',
    'VENTA_MONTO_COBRO_INVALIDO_CODE',
    'VENTA_MONTO_COBRO_INVALIDO_MESSAGE'
  ];
  const dependencyValues = [
    fetchVentaCatalogMaps,
    (item) => Array.isArray(item?.extras) && item.extras.length > 0,
    async () => ({ hasMenuExtras: false }),
    async () => ({ saucesByRecipe: new Map(), rulesByRecipe: new Map(), fallbackSauces: [] }),
    async () => new Map(),
    async () => new Map(),
    (items) => new Map(items.filter((item) => item.kind === 'PRODUCTO').map((item) => [item.id_producto, item.cantidad])),
    (value) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true',
    (value) => Math.round(Number(value) * 100) / 100,
    () => ({
      ok: true,
      metadata: {
        requiere_complementos: false,
        minimo_complementos: 0,
        maximo_complementos: 0,
        complementos_disponibles: []
      },
      selected: []
    }),
    () => ({ ok: true, subtotal: 0, selected: [] }),
    () => ({ ok: true }),
    (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
    'VENTA_MONTO_COBRO_INVALIDO',
    'El monto de cobro es invalido.'
  ];

  return {
    source,
    hydrateVentaLines: Function(...dependencyNames, `return (${expression});`)(...dependencyValues)
  };
};

const { source: ventasSource, hydrateVentaLines } = await loadHydrateVentaLines();

const normalizeProductLine = (cantidad) => {
  const result = normalizeVentaItems([{ id_producto: PRODUCT_ID, cantidad }]);
  assert.equal(result.ok, true);
  return result.data;
};

const makeCatalogClient = ({
  stock = 3,
  exists = true,
  active = true,
  assignmentCount = 1
} = {}) => ({
  async query(sql) {
    const statement = String(sql);

    if (statement.includes('COUNT(DISTINCT pm.id_producto_maestro)')) {
      return {
        rows: [{ input_id: PRODUCT_ID, total_maestros: 0, id_producto_maestro: null }]
      };
    }
    if (statement.includes('SELECT DISTINCT pm.id_producto_maestro')) {
      return { rows: exists ? [{ id_producto_maestro: PRODUCT_ID }] : [] };
    }
    if (statement.includes('COUNT(*)::int AS total_asignaciones')) {
      return {
        rows: assignmentCount > 0
          ? [{ id_producto_maestro: PRODUCT_ID, total_asignaciones: assignmentCount }]
          : []
      };
    }
    if (statement.includes('FOR UPDATE OF pa')) {
      return {
        rows: assignmentCount === 1
          ? [{
              id_producto_maestro: PRODUCT_ID,
              id_producto_legacy_local: PRODUCT_ID,
              nombre_producto: 'COCA 2 LT',
              precio: 75,
              cantidad: stock,
              stock_minimo: 0,
              id_almacen: WAREHOUSE_ID,
              id_sucursal: BRANCH_ID,
              estado: true
            }]
          : []
      };
    }
    if (statement.includes('FROM public.productos p') && statement.includes('ORDER BY p.id_producto')) {
      return {
        rows: exists
          ? [{ id_producto: PRODUCT_ID, nombre_producto: 'COCA 2 LT', precio: 75, estado: active }]
          : []
      };
    }

    throw new Error(`Consulta inesperada en hydrateVentaLines: ${statement}`);
  }
});

const hydrateProduct = ({ cantidad, options, ...catalog } = {}) =>
  hydrateVentaLines(
    makeCatalogClient(catalog),
    normalizeProductLine(cantidad),
    null,
    { idSucursal: BRANCH_ID, ...options }
  );

describe('hydrateVentaLines: venta pagada permite deficit antes del servicio central', () => {
  for (const scenario of [
    { stock: 3, cantidad: 10 },
    { stock: 0, cantidad: 1 },
    { stock: -5, cantidad: 1 }
  ]) {
    it(`no bloquea stock ${scenario.stock} al vender ${scenario.cantidad}`, async () => {
      const result = await hydrateProduct(scenario);

      assert.equal(result.ok, true);
      assert.equal(result.data.lines[0].cantidad, scenario.cantidad);
      assert.equal(result.data.lines[0].id_almacen, WAREHOUSE_ID);
    });
  }

  it('sigue rechazando un producto inexistente', async () => {
    const result = await hydrateProduct({ cantidad: 1, exists: false });

    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Producto no encontrado/);
  });

  it('sigue rechazando un producto inactivo', async () => {
    const result = await hydrateProduct({ cantidad: 1, active: false });

    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Producto no encontrado/);
  });

  it('sigue rechazando una asignacion de almacen inexistente o ambigua', async () => {
    for (const assignmentCount of [0, 2]) {
      const result = await hydrateProduct({ cantidad: 1, assignmentCount });

      assert.equal(result.ok, false);
      assert.match(result.body.message, /Producto no encontrado/);
    }
  });

  it('pedido pendiente conserva la desactivacion explicita del bloqueo fisico', async () => {
    const result = await hydrateProduct({
      stock: 0,
      cantidad: 1,
      options: { validateProductStock: false }
    });

    assert.equal(result.ok, true);
  });

  it('POST /ventas y pedido pendiente desactivan el bloqueo y el default queda opt-in', async () => {
    const hydrateCalls = [...ventasSource.matchAll(/hydrateVentaLines\(client, normalizedItemsResult\.data, perf, \{([\s\S]*?)\n  \}\);/g)];

    assert.equal(hydrateCalls.length, 2);
    for (const call of hydrateCalls) {
      assert.match(call[1], /validateProductStock:\s*false/);
    }
    assert.match(ventasSource, /const validateProductStock = options\?\.validateProductStock === true;/);

    const postVentasStart = ventasSource.indexOf("router.post('/ventas', checkPermission(['VENTAS_CREAR'])");
    const postVentasEnd = ventasSource.indexOf('export default router;', postVentasStart);
    const postVentasHandler = ventasSource.slice(postVentasStart, postVentasEnd);
    assert.doesNotMatch(postVentasHandler, /availableQty\s*<\s*requestedQty/);
    assert.doesNotMatch(postVentasHandler, /Stock insuficiente para/);
  });
});
