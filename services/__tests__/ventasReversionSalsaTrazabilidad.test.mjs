// Fase 3 (correccion final): pruebas de la eliminacion del respaldo
// ambiguo de salsas/complementos en la reversion de venta
// (buildSalsaInventorySnapshotsForReturn/filterConsumedSalsaSnapshots/
// restoreSalsasInventoryFromSnapshots, eliminados de
// services/ventasReversionService.js) y su reemplazo por exigencia
// estricta de trazabilidad por movimiento original (id_detalle_pedido),
// igual que PRODUCTO/RECETA, para cualquier linea con evidencia de
// consumo de salsa/complemento (hasSalsaInventoryConsumptionEvidence).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  returnInventoryForReversionLine,
  returnInventoryForReversionLines
} from '../../routers/ventas/services/ventasReversionInventoryService.js';
import { consumeSalsasInventoryFromSnapshots } from '../../routers/ventas/services/salsasInventoryService.js';

const tupleKey = ({ idDetallePedido, idAlmacen, idProducto, idInsumo, origenConsumo }) =>
  `${idDetallePedido}:${idAlmacen}:${idProducto || 0}:${idInsumo || 0}:${origenConsumo || ''}`;

const createInventoryMockClient = ({ originalsByDetallePedido = {} } = {}) => {
  const inserted = [];
  const returnedByTuple = new Map();

  const client = {
    async query(sql, params = []) {
      const text = String(sql);

      if (/FROM public\.movimientos_inventario[\s\S]*tipo = 'SALIDA'/.test(text)) {
        const idDetallePedido = params[0];
        const rows = originalsByDetallePedido[idDetallePedido] || [];
        return { rowCount: rows.length, rows };
      }
      if (/SELECT id_movimiento[\s\S]*tipo = 'ENTRADA'/.test(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (/COALESCE\(SUM\(cantidad\), 0\)/.test(text)) {
        const [, idDetallePedido, idAlmacen, idProducto, idInsumo, origenConsumo] = params;
        const key = tupleKey({ idDetallePedido, idAlmacen, idProducto, idInsumo, origenConsumo });
        return { rows: [{ total: returnedByTuple.get(key) || 0 }] };
      }
      if (/INSERT INTO public\.movimientos_inventario/.test(text)) {
        const [cantidad, idAlmacen, idProducto, idInsumo, idDetallePedido, origenConsumo] = params;
        inserted.push({ cantidad, idAlmacen, idProducto, idInsumo, idDetallePedido, origenConsumo });
        const key = tupleKey({ idDetallePedido, idAlmacen, idProducto, idInsumo, origenConsumo });
        returnedByTuple.set(key, (returnedByTuple.get(key) || 0) + Number(cantidad));
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Consulta no simulada: ${text}`);
    }
  };
  return { client, inserted };
};

const originalMovement = ({ id = 1, cantidad, idAlmacen = 3, idInsumo, origenConsumo = 'SALSA' }) => ({
  id_movimiento: id,
  cantidad,
  id_almacen: idAlmacen,
  id_producto: null,
  id_insumo: idInsumo,
  origen_consumo: origenConsumo,
  id_pedido_trazabilidad: 700
});

describe('1-2-3) salsas/complementos: lineas con el mismo insumo/almacen (o la misma salsa) se resuelven de forma independiente por id_detalle_pedido', () => {
  it('dos lineas usan el mismo insumo (misma salsa) y el mismo almacen: reversar una no afecta la otra', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: {
        // Dos lineas de pedido distintas consumieron la MISMA salsa (mismo
        // id_insumo=400) desde el MISMO almacen (3) -- exactamente el
        // escenario que el viejo respaldo ambiguo (agrupado por
        // insumo+almacen) podia confundir.
        501: [originalMovement({ id: 1, cantidad: 10, idInsumo: 400 })],
        502: [originalMovement({ id: 2, cantidad: 6, idInsumo: 400 })]
      }
    });

    await returnInventoryForReversionLines({
      client,
      reversionLines: [{
        id_detalle_factura: 1,
        id_detalle_pedido: 501,
        cantidad_revertida: 2,
        cantidad_vendida: 2,
        requiereTrazabilidad: true
      }],
      idPedido: 9,
      idReversion: 1001,
      codigoReversion: 'REV-S1',
      codigoVenta: 'VTA-S1',
      idUsuario: 7,
      reversedQtyMapBefore: new Map()
    });

    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].idDetallePedido, 501);
    assert.equal(inserted[0].cantidad, 10);
    // La linea 502 (misma salsa, mismo almacen, OTRO detalle_pedido) nunca
    // fue tocada por reversar la linea 501.
    assert.ok(!inserted.some((row) => row.idDetallePedido === 502));
  });
});

describe('4-5) salsa/extra sin trazabilidad exacta bloquea con VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED', () => {
  it('4) salsa con evidencia de consumo pero sin id_detalle_pedido resoluble -> bloquea', async () => {
    const { client } = createInventoryMockClient({});
    await assert.rejects(
      returnInventoryForReversionLine({
        client,
        line: { id_detalle_pedido: null, requiereTrazabilidad: true },
        idReversion: 1002,
        codigoReversion: 'REV-S2',
        codigoVenta: 'VTA-S2',
        idUsuario: 7,
        cantidadAcumuladaReversada: 1,
        cantidadOriginalVendida: 1
      }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED');
        return true;
      }
    );
  });

  it('5) linea EXTRA con evidencia de consumo (requiereTrazabilidad=true) y sin movimiento original -> bloquea, nunca omite en silencio', async () => {
    const { client, inserted } = createInventoryMockClient({ originalsByDetallePedido: {} });
    await assert.rejects(
      returnInventoryForReversionLine({
        client,
        line: { id_detalle_pedido: 777, requiereTrazabilidad: true },
        idReversion: 1003,
        codigoReversion: 'REV-S3',
        codigoVenta: 'VTA-S3',
        idUsuario: 7,
        cantidadAcumuladaReversada: 1,
        cantidadOriginalVendida: 1
      }),
      (err) => err.code === 'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED'
    );
    assert.equal(inserted.length, 0, 'no debe insertar nada de forma parcial antes de abortar');
  });
});

describe('6) nueva SALIDA de salsa guarda id_detalle_pedido (consumeSalsasInventoryFromSnapshots)', () => {
  const createConsumeMockClient = () => {
    const inserted = [];
    const client = {
      async query(sql, params = []) {
        const text = String(sql);
        if (/FROM public\.insumos_almacenes/.test(text)) {
          return { rowCount: 1, rows: [{ cantidad: 1000 }] };
        }
        if (/INSERT INTO public\.movimientos_inventario/.test(text)) {
          const [cantidad, idAlmacen, idInsumo, idDetallePedido, origenConsumo, idPedidoTrazabilidad, refOrigen, idRef] = params;
          inserted.push({ cantidad, idAlmacen, idInsumo, idDetallePedido, origenConsumo, idPedidoTrazabilidad, refOrigen, idRef });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Consulta no simulada: ${text}`);
      }
    };
    return { client, inserted };
  };

  it('guarda id_detalle_pedido y origen_consumo=SALSA cuando el snapshot lo trae', async () => {
    const { client, inserted } = createConsumeMockClient();
    await consumeSalsasInventoryFromSnapshots({
      client,
      lines: [{
        salsas_inventario_snapshot: [{
          id_insumo: 400,
          id_almacen: 3,
          id_detalle_pedido: 501,
          cantidad_base_total: 10,
          nombre: 'Barbecue'
        }]
      }],
      idReferencia: 55,
      idPedidoTrazabilidad: 9,
      refOrigen: 'VENTA_SALSA'
    });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].idDetallePedido, 501);
    assert.equal(inserted[0].origenConsumo, 'SALSA');
    assert.equal(inserted[0].idPedidoTrazabilidad, 9);
  });

  it('nunca mezcla el consumo de dos lineas distintas en una sola SALIDA aunque compartan insumo+almacen', async () => {
    const { client, inserted } = createConsumeMockClient();
    await consumeSalsasInventoryFromSnapshots({
      client,
      lines: [
        { salsas_inventario_snapshot: [{ id_insumo: 400, id_almacen: 3, id_detalle_pedido: 501, cantidad_base_total: 10, nombre: 'Barbecue' }] },
        { salsas_inventario_snapshot: [{ id_insumo: 400, id_almacen: 3, id_detalle_pedido: 502, cantidad_base_total: 6, nombre: 'Barbecue' }] }
      ],
      idReferencia: 55,
      refOrigen: 'VENTA_SALSA'
    });
    assert.equal(inserted.length, 2, 'dos lineas distintas deben producir dos filas SALIDA separadas, no una fusionada');
    assert.equal(inserted.find((r) => r.idDetallePedido === 501).cantidad, 10);
    assert.equal(inserted.find((r) => r.idDetallePedido === 502).cantidad, 6);
  });
});

describe('7) parciales acumuladas de salsa/complemento no exceden la SALIDA original', () => {
  it('dos parciales sucesivas de una linea con salsa: la suma nunca excede el movimiento original', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: { 600: [originalMovement({ cantidad: 9, idInsumo: 400 })] }
    });

    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 600, requiereTrazabilidad: true }, idReversion: 1004,
      codigoReversion: 'REV-S4', codigoVenta: 'VTA-S4', idUsuario: 7,
      cantidadAcumuladaReversada: 1, cantidadOriginalVendida: 3
    });
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 600, requiereTrazabilidad: true }, idReversion: 1005,
      codigoReversion: 'REV-S5', codigoVenta: 'VTA-S5', idUsuario: 7,
      cantidadAcumuladaReversada: 3, cantidadOriginalVendida: 3
    });

    const suma = inserted.reduce((sum, row) => sum + Number(row.cantidad), 0);
    assert.equal(Number(suma.toFixed(4)), 9);
  });
});

describe('8) no existe llamada a restoreSalsasInventoryFromSnapshots (ni al respaldo por snapshot) desde la reversion', () => {
  it('services/ventasReversionService.js no importa ni llama restoreSalsasInventoryFromSnapshots/buildSalsaInventorySnapshotsForReturn/filterConsumedSalsaSnapshots', () => {
    // Los nombres pueden aparecer en comentarios explicando por que se
    // eliminaron (ver encabezado del archivo); lo que no debe existir es
    // una llamada real (invocacion), una declaracion (export const/function)
    // o un import de esos identificadores.
    const source = readFileSync(resolve('services/ventasReversionService.js'), 'utf8');
    assert.doesNotMatch(source, /restoreSalsasInventoryFromSnapshots\(/);
    assert.doesNotMatch(source, /import\s*\{[^}]*restoreSalsasInventoryFromSnapshots/);
    assert.doesNotMatch(source, /(export\s+)?(const|function)\s+buildSalsaInventorySnapshotsForReturn\b/);
    assert.doesNotMatch(source, /buildSalsaInventorySnapshotsForReturn\(/);
    assert.doesNotMatch(source, /(const|function)\s+filterConsumedSalsaSnapshots\b/);
    assert.doesNotMatch(source, /filterConsumedSalsaSnapshots\(/);
  });
});

describe('9) falla de inventario (salsa/extra sin trazabilidad) hace rollback completo de REV, Caja y puntos', () => {
  it('la devolucion de inventario por linea se ejecuta DESPUES de insertar REV/Caja/puntos pero ANTES del COMMIT, dentro del mismo try/catch con ROLLBACK', () => {
    const source = readFileSync(resolve('services/ventasReversionService.js'), 'utf8');

    const beginIdx = source.indexOf(`await client.query('BEGIN')`);
    const revInsertIdx = source.indexOf('INSERT INTO public.facturas_reversiones (');
    const cajaInsertIdx = source.indexOf('INSERT INTO public.cajas_movimientos (');
    const loyaltyCallIdx = source.indexOf('applyLoyaltyReversalForFactura({');
    const inventoryCallIdx = source.indexOf('returnInventoryForReversionLines({');
    // Hay un COMMIT anterior (linea temprana del reply idempotente, antes
    // de tocar Caja/inventario/puntos): se busca el COMMIT final de la
    // transaccion real, que ocurre DESPUES de la devolucion de inventario.
    const commitIdx = source.indexOf(`await client.query('COMMIT')`, inventoryCallIdx);
    const catchIdx = source.indexOf('} catch (error) {');
    const rollbackIdx = source.indexOf(`await client.query('ROLLBACK')`);

    assert.ok(beginIdx > -1 && revInsertIdx > beginIdx);
    assert.ok(cajaInsertIdx > revInsertIdx);
    assert.ok(loyaltyCallIdx > cajaInsertIdx);
    assert.ok(inventoryCallIdx > loyaltyCallIdx, 'la devolucion de inventario debe ejecutarse despues de Caja/puntos, todavia dentro de la transaccion');
    assert.ok(commitIdx > inventoryCallIdx, 'el COMMIT debe ocurrir despues de que la devolucion de inventario haya sido intentada (si falla, nunca se llega al COMMIT)');
    assert.ok(catchIdx > commitIdx);
    assert.ok(rollbackIdx > catchIdx, 'el catch debe hacer ROLLBACK, revirtiendo REV/Caja/puntos si la devolucion de inventario lanzo un error');
  });
});
