import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  buildComplementLineConfig,
  normalizeVentaItems
} from '../services/ventasPayloadService.js';

describe('ventas bulk recipe quantity payload', () => {
  it('acepta receta con cantidad 99 y extras por orden', () => {
    const result = normalizeVentaItems([
      {
        id_receta: 12,
        cantidad: 99,
        complementos: [{ id_complemento: 5 }],
        extras: [{ id_extra: 8, cantidad: 1 }],
        observacion: 'Bien cocidas'
      }
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.data[0].kind, 'RECETA');
    assert.equal(result.data[0].cantidad, 99);
    assert.deepEqual(result.data[0].extras, [{ id_extra: 8, cantidad: 1 }]);
  });

  it('rechaza 0, negativos, decimales y cantidad mayor a 999', () => {
    for (const cantidad of [0, -1, 1.5, '2.5', 1000]) {
      const result = normalizeVentaItems([{ id_receta: 12, cantidad }]);
      assert.equal(result.ok, false);
    }
  });

  it('incluye cantidad por orden y total en configuracion_menu', () => {
    const config = buildComplementLineConfig({
      complementos_metadata: { requiere_complementos: true, minimo_complementos: 1, maximo_complementos: 1 },
      complementos_detalle: [{ id_complemento: 5, id_salsa: 5, nombre: 'Barbecue' }],
      extras_detalle: [{
        id_extra: 8,
        codigo: 'QUESO',
        nombre: 'Queso',
        cantidad: 99,
        cantidad_por_orden: 1,
        cantidad_total: 99,
        precio_unitario: 10,
        subtotal: 990
      }]
    });

    assert.equal(config.extras[0].cantidad, 99);
    assert.equal(config.extras[0].cantidad_por_orden, 1);
    assert.equal(config.extras[0].cantidad_total, 99);
    assert.equal(config.extras[0].subtotal, 990);
  });

  it('mantiene la multiplicacion de extras y salsas en codigo transaccional', async () => {
    const ventasSource = await readFile(new URL('../../ventas.js', import.meta.url), 'utf8');
    const salsasSource = await readFile(new URL('../services/salsasInventoryService.js', import.meta.url), 'utf8');

    assert.match(ventasSource, /const cantidadPorOrden = Number\(entry\.cantidad \|\| 0\);/);
    assert.match(ventasSource, /const cantidad = cantidadPorOrden \* cantidadLinea;/);
    assert.match(salsasSource, /cantidad_base_total: Number\(resolved\.cantidad_consumo_base \|\| 0\) \* porcionesPorOrden \* cantidadLinea/);
  });
});
