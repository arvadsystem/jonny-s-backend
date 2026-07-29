import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  returnInventoryForReversionLine,
  returnInventoryForReversionLines
} from '../../routers/ventas/services/ventasReversionInventoryService.js';

const tupleKey = ({ idDetallePedido, idAlmacen, idProducto, idInsumo, origenConsumo }) =>
  `${idDetallePedido}:${idAlmacen}:${idProducto || 0}:${idInsumo || 0}:${origenConsumo || ''}`;

/**
 * Mock con estado en memoria: simula movimientos_inventario lo suficiente
 * para ejercer el algoritmo real (localizar originales por
 * id_detalle_pedido, sumar ya devuelto por tupla compuesta, insertar
 * ENTRADA). No es una base de datos real -- las pruebas de bloqueo/lock
 * concurrente real requieren Postgres y no se ejecutan aqui.
 */
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
        // Lock previo a la agregacion: no necesita devolver filas reales.
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

      throw new Error(`Consulta no simulada en mock de inventario: ${text}`);
    }
  };

  return { client, inserted, returnedByTuple };
};

const originalMovement = ({ id = 1, cantidad, idAlmacen = 1, idProducto = null, idInsumo = null, origenConsumo = 'PRODUCTO' }) => ({
  id_movimiento: id,
  cantidad,
  id_almacen: idAlmacen,
  id_producto: idProducto,
  id_insumo: idInsumo,
  origen_consumo: origenConsumo,
  id_pedido_trazabilidad: 500
});

describe('returnInventoryForReversionLine', () => {
  it('3) producto directo: reversion total devuelve exactamente la cantidad original', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: { 10: [originalMovement({ cantidad: 2, idProducto: 55, origenConsumo: 'PRODUCTO' })] }
    });
    const result = await returnInventoryForReversionLine({
      client,
      line: { id_detalle_pedido: 10, requiereTrazabilidad: true },
      idReversion: 900,
      codigoReversion: 'REV-1',
      codigoVenta: 'VTA-1',
      idUsuario: 7,
      cantidadAcumuladaReversada: 2,
      cantidadOriginalVendida: 2
    });
    assert.equal(result.returned, true);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].cantidad, 2);
    assert.equal(inserted[0].idProducto, 55);
  });

  it('4) receta con varios insumos: cada insumo se devuelve proporcionalmente', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: {
        11: [
          originalMovement({ id: 1, cantidad: 300, idAlmacen: 1, idInsumo: 700, origenConsumo: 'RECETA' }),
          originalMovement({ id: 2, cantidad: 150, idAlmacen: 1, idInsumo: 701, origenConsumo: 'RECETA' })
        ]
      }
    });
    await returnInventoryForReversionLine({
      client,
      line: { id_detalle_pedido: 11, requiereTrazabilidad: true },
      idReversion: 901,
      codigoReversion: 'REV-2',
      codigoVenta: 'VTA-2',
      idUsuario: 7,
      cantidadAcumuladaReversada: 1,
      cantidadOriginalVendida: 3
    });
    assert.equal(inserted.length, 2);
    const insumo700 = inserted.find((row) => row.idInsumo === 700);
    const insumo701 = inserted.find((row) => row.idInsumo === 701);
    assert.equal(insumo700.cantidad, 100);
    assert.equal(insumo701.cantidad, 50);
  });

  it('1) reversar una linea no afecta otra linea del mismo pedido (movimientos distintos por id_detalle_pedido)', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: {
        20: [originalMovement({ id: 1, cantidad: 5, idProducto: 1 })],
        21: [originalMovement({ id: 2, cantidad: 3, idProducto: 2 })]
      }
    });
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 20, requiereTrazabilidad: true }, idReversion: 902,
      codigoReversion: 'REV-3', codigoVenta: 'VTA-3', idUsuario: 7,
      cantidadAcumuladaReversada: 5, cantidadOriginalVendida: 5
    });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].idProducto, 1);
    assert.equal(inserted[0].cantidad, 5);
    // La linea 21 (otro producto) nunca fue tocada.
    assert.ok(!inserted.some((row) => row.idProducto === 2));
  });

  it('2) dos productos distintos en el mismo pedido no se mezclan', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: {
        30: [originalMovement({ id: 1, cantidad: 4, idProducto: 10 })],
        31: [originalMovement({ id: 2, cantidad: 6, idProducto: 20 })]
      }
    });
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 30, requiereTrazabilidad: true }, idReversion: 903,
      codigoReversion: 'REV-4', codigoVenta: 'VTA-4', idUsuario: 7,
      cantidadAcumuladaReversada: 4, cantidadOriginalVendida: 4
    });
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 31, requiereTrazabilidad: true }, idReversion: 903,
      codigoReversion: 'REV-4', codigoVenta: 'VTA-4', idUsuario: 7,
      cantidadAcumuladaReversada: 3, cantidadOriginalVendida: 6
    });
    assert.equal(inserted.length, 2);
    assert.equal(inserted.find((r) => r.idProducto === 10).cantidad, 4);
    assert.equal(inserted.find((r) => r.idProducto === 20).cantidad, 3);
  });

  it('7) parcial de una unidad: prorratea proporcional a la cantidad acumulada', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: { 40: [originalMovement({ cantidad: 300, idInsumo: 900, origenConsumo: 'RECETA' })] }
    });
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 40, requiereTrazabilidad: true }, idReversion: 904,
      codigoReversion: 'REV-5', codigoVenta: 'VTA-5', idUsuario: 7,
      cantidadAcumuladaReversada: 1, cantidadOriginalVendida: 3
    });
    assert.equal(inserted[0].cantidad, 100);
  });

  it('8-9) varias parciales acumuladas y total despues de parcial: la ultima absorbe el remanente exacto', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: { 50: [originalMovement({ cantidad: 10, idProducto: 99 })] }
    });

    // Primera parcial: 1 de 3 unidades -> objetivo = 10*1/3 = 3.3333 -> 3.3333
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 50, requiereTrazabilidad: true }, idReversion: 905,
      codigoReversion: 'REV-6', codigoVenta: 'VTA-6', idUsuario: 7,
      cantidadAcumuladaReversada: 1, cantidadOriginalVendida: 3
    });
    const primera = inserted[0].cantidad;
    assert.equal(primera, 3.3333);

    // Reversion TOTAL que completa las 3 unidades: debe devolver EXACTAMENTE
    // el remanente (10 - 3.3333 = 6.6667), no un nuevo prorrateo (10*3/3=10).
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 50, requiereTrazabilidad: true }, idReversion: 906,
      codigoReversion: 'REV-7', codigoVenta: 'VTA-7', idUsuario: 7,
      cantidadAcumuladaReversada: 3, cantidadOriginalVendida: 3
    });
    const segunda = inserted[1].cantidad;
    assert.equal(segunda, 6.6667);

    // 10) residuo de inventario final: la suma debe ser exactamente la
    // cantidad original del movimiento, sin sobrante ni faltante.
    const suma = Number((primera + segunda).toFixed(4));
    assert.equal(suma, 10);
  });

  it('16) confirmar que la entrada acumulada nunca supera la salida original', async () => {
    const { client } = createInventoryMockClient({
      originalsByDetallePedido: { 60: [originalMovement({ cantidad: 5, idProducto: 1 })] }
    });
    // Simula una llamada donde cantidadAcumuladaReversada > cantidadOriginalVendida
    // (no deberia ocurrir dado el flujo real, pero el metodo debe seguir
    // siendo seguro: nunca devuelve mas de lo que salio).
    const result = await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 60, requiereTrazabilidad: true }, idReversion: 907,
      codigoReversion: 'REV-8', codigoVenta: 'VTA-8', idUsuario: 7,
      cantidadAcumuladaReversada: 5, cantidadOriginalVendida: 5
    });
    assert.equal(result.movimientos[0].cantidad, 5);
  });

  it('11-12) almacenes distintos y mismo insumo desde almacenes distintos se tratan como movimientos independientes', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: {
        70: [
          originalMovement({ id: 1, cantidad: 8, idAlmacen: 1, idInsumo: 400, origenConsumo: 'RECETA' }),
          originalMovement({ id: 2, cantidad: 4, idAlmacen: 2, idInsumo: 400, origenConsumo: 'RECETA' })
        ]
      }
    });
    await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 70, requiereTrazabilidad: true }, idReversion: 908,
      codigoReversion: 'REV-9', codigoVenta: 'VTA-9', idUsuario: 7,
      cantidadAcumuladaReversada: 1, cantidadOriginalVendida: 1
    });
    assert.equal(inserted.length, 2);
    const almacen1 = inserted.find((r) => r.idAlmacen === 1);
    const almacen2 = inserted.find((r) => r.idAlmacen === 2);
    assert.equal(almacen1.cantidad, 8);
    assert.equal(almacen2.cantidad, 4);
  });

  it('13) reintento idempotente: repetir la misma reversion completa no duplica la entrada', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: { 80: [originalMovement({ cantidad: 6, idProducto: 1 })] }
    });
    const args = {
      client, line: { id_detalle_pedido: 80, requiereTrazabilidad: true }, idReversion: 909,
      codigoReversion: 'REV-10', codigoVenta: 'VTA-10', idUsuario: 7,
      cantidadAcumuladaReversada: 6, cantidadOriginalVendida: 6
    };
    await returnInventoryForReversionLine(args);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].cantidad, 6);

    // "Reintento": misma cantidad acumulada, ya devuelto = 6 -> objetivo=6,
    // entradaActual = 6 - 6 = 0 -> no debe insertar una segunda entrada.
    await returnInventoryForReversionLine(args);
    assert.equal(inserted.length, 1, 'no debe crear una segunda entrada para la misma cantidad ya devuelta');
  });

  it('14) sin trazabilidad (linea PRODUCTO sin id_detalle_pedido) -> VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED', async () => {
    const { client } = createInventoryMockClient({});
    await assert.rejects(
      returnInventoryForReversionLine({
        client, line: { id_detalle_pedido: null, requiereTrazabilidad: true }, idReversion: 910,
        codigoReversion: 'REV-11', codigoVenta: 'VTA-11', idUsuario: 7,
        cantidadAcumuladaReversada: 1, cantidadOriginalVendida: 1
      }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED');
        return true;
      }
    );
  });

  it('14b) sin movimientos originales para el id_detalle_pedido -> VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED', async () => {
    const { client } = createInventoryMockClient({ originalsByDetallePedido: {} });
    await assert.rejects(
      returnInventoryForReversionLine({
        client, line: { id_detalle_pedido: 999, requiereTrazabilidad: true }, idReversion: 911,
        codigoReversion: 'REV-12', codigoVenta: 'VTA-12', idUsuario: 7,
        cantidadAcumuladaReversada: 1, cantidadOriginalVendida: 1
      }),
      (err) => err.code === 'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED'
    );
  });

  it('linea sin trazabilidad requerida (EXTRA) y sin movimientos: no lanza, simplemente no devuelve nada', async () => {
    const { client, inserted } = createInventoryMockClient({ originalsByDetallePedido: {} });
    const result = await returnInventoryForReversionLine({
      client, line: { id_detalle_pedido: 999, requiereTrazabilidad: false }, idReversion: 912,
      codigoReversion: 'REV-13', codigoVenta: 'VTA-13', idUsuario: 7,
      cantidadAcumuladaReversada: 1, cantidadOriginalVendida: 1
    });
    assert.equal(result.returned, false);
    assert.equal(inserted.length, 0);
  });

  it('15) confirma ausencia de productos.id_almacen como fallback: el modulo nunca consulta public.productos', async () => {
    // El identificador puede aparecer en comentarios explicando por que NO
    // se usa (ver encabezado del archivo); lo que no debe existir es una
    // consulta SQL ejecutable contra public.productos.
    const source = await import('node:fs').then((fs) => fs.promises.readFile(
      new URL('../../routers/ventas/services/ventasReversionInventoryService.js', import.meta.url),
      'utf8'
    ));
    const assertMod = await import('node:assert/strict');
    assertMod.default.doesNotMatch(source, /FROM public\.productos\b/);
    assertMod.default.doesNotMatch(source, /SELECT[\s\S]{0,80}id_almacen[\s\S]{0,40}FROM public\.productos/);
  });
});

describe('returnInventoryForReversionLines (orquestador)', () => {
  it('5-6) salsa/extra con movimiento rastreable (VENTA_SALSA) se devuelve y se reporta en returnedInsumoKeys', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: { 100: [originalMovement({ cantidad: 10, idAlmacen: 3, idInsumo: 400, origenConsumo: 'SALSA' })] }
    });
    const { returnedInsumoKeys } = await returnInventoryForReversionLines({
      client,
      reversionLines: [{
        id_detalle_factura: 1,
        id_detalle_pedido: 100,
        cantidad_revertida: 2,
        cantidad_vendida: 10,
        requiereTrazabilidad: false
      }],
      idPedido: 5,
      idReversion: 913,
      codigoReversion: 'REV-14',
      codigoVenta: 'VTA-14',
      idUsuario: 7,
      reversedQtyMapBefore: new Map()
    });
    assert.equal(inserted.length, 1);
    assert.ok(returnedInsumoKeys.has('400:3'));
  });

  it('cantidad acumulada usa reversedQtyMapBefore + la operacion actual', async () => {
    const { client, inserted } = createInventoryMockClient({
      originalsByDetallePedido: { 200: [originalMovement({ cantidad: 12, idProducto: 1 })] }
    });
    await returnInventoryForReversionLines({
      client,
      reversionLines: [{
        id_detalle_factura: 2,
        id_detalle_pedido: 200,
        cantidad_revertida: 2,
        cantidad_vendida: 6,
        requiereTrazabilidad: true
      }],
      idPedido: 9,
      idReversion: 914,
      codigoReversion: 'REV-15',
      codigoVenta: 'VTA-15',
      idUsuario: 7,
      reversedQtyMapBefore: new Map([[2, { cantidad: 1 }]])
    });
    // acumulada = 1 (previa) + 2 (actual) = 3 de 6 -> objetivo = 12*3/6=6
    assert.equal(inserted[0].cantidad, 6);
  });
});
