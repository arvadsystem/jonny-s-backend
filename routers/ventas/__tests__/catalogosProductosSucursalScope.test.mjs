import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const readCatalogosHandlersSource = async () => {
  const source = await readFile(new URL('../handlers/catalogosHandlers.js', import.meta.url), 'utf8');
  const handlerStart = source.indexOf('export const listProductosCatalogoHandler');
  const handlerEnd = source.indexOf('export const listClientesCatalogoHandler', handlerStart);
  const validationStart = source.indexOf('const validateVentasCatalogSucursal');
  const validationEnd = source.indexOf('const buildDescuentoObjetivoLabel', validationStart);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'debe localizar el handler de productos');
  assert.ok(validationStart >= 0 && validationEnd > validationStart, 'debe localizar la validacion de sucursal');

  return {
    handler: source.slice(handlerStart, handlerEnd),
    validation: source.slice(validationStart, validationEnd)
  };
};

describe('catalogo de productos por sucursal', () => {
  it('usa la asignacion activa de productos_almacenes como fuente de stock local', async () => {
    const { handler } = await readCatalogosHandlersSource();

    assert.match(handler, /INNER JOIN public\.productos_almacenes pa/);
    assert.match(handler, /pa\.id_producto = p\.id_producto/);
    assert.match(handler, /COALESCE\(pa\.estado, true\) = true/);
    assert.match(handler, /COALESCE\(pa\.cantidad, 0\)::numeric AS cantidad/);
    assert.match(handler, /pa\.id_almacen/);
    assert.match(handler, /COALESCE\(pa\.stock_minimo, 0\)::numeric AS stock_minimo/);
    assert.doesNotMatch(handler, /\bp\.id_almacen\b/);
    assert.doesNotMatch(handler, /\bp\.cantidad\b/);
  });

  it('resuelve almacenes y sucursales activas sin ocultar productos agotados', async () => {
    const { handler } = await readCatalogosHandlersSource();

    assert.match(handler, /INNER JOIN public\.almacenes al[\s\S]*al\.id_almacen = pa\.id_almacen/);
    assert.match(handler, /COALESCE\(al\.estado, true\) = true/);
    assert.match(handler, /INNER JOIN public\.sucursales suc[\s\S]*suc\.id_sucursal = al\.id_sucursal/);
    assert.match(handler, /COALESCE\(suc\.estado, true\) = true/);
    assert.match(handler, /ORDER BY p\.nombre_producto ASC, p\.id_producto ASC/);
    assert.doesNotMatch(handler, /pa\.cantidad\s*>\s*0/);
  });

  it('mantiene validacion y SQL parametrizado para el alcance por sucursal', async () => {
    const { handler, validation } = await readCatalogosHandlersSource();

    assert.match(validation, /allowedSucursalIds\.includes\(idSucursal\)/);
    assert.match(validation, /status:\s*403/);
    assert.ok(
      handler.indexOf('validateVentasCatalogSucursal') < handler.indexOf('const query ='),
      'debe validar la sucursal antes de consultar el catalogo'
    );
    assert.match(handler, /params\.push\(idSucursal\)/);
    assert.match(handler, /whereClause = 'AND al\.id_sucursal = \$1'/);
    assert.match(handler, /params\.push\(allowedSucursalIds\)/);
    assert.match(handler, /whereClause = 'AND al\.id_sucursal = ANY\(\$1::int\[\]\)'/);
  });
});
