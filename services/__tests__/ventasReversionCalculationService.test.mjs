import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRequestedLines,
  resolveReversionLines,
  computeAccumulatedResult,
  validatePartialReversionApplicability
} from '../../routers/ventas/services/ventasReversionCalculationService.js';

describe('buildRequestedLines — validacion estricta del payload (seccion 12)', () => {
  it('18) una linea valida', () => {
    const map = buildRequestedLines([{ id_detalle_factura: 1001, cantidad: 1 }]);
    assert.equal(map.get(1001), 1);
  });

  it('19) varias lineas validas', () => {
    const map = buildRequestedLines([
      { id_detalle_factura: 1001, cantidad: 1 },
      { id_detalle_factura: 1002, cantidad: 2 }
    ]);
    assert.equal(map.size, 2);
  });

  it('21) duplicados de la misma linea se consolidan sumando', () => {
    const map = buildRequestedLines([
      { id_detalle_factura: 1001, cantidad: 1 },
      { id_detalle_factura: 1001, cantidad: 2 }
    ]);
    assert.equal(map.get(1001), 3);
  });

  it('lineas debe ser un arreglo', () => {
    assert.throws(() => buildRequestedLines({ id_detalle_factura: 1 }), (err) => err.code === 'VENTAS_REVERSION_LINEAS_FORMATO_INVALIDO');
    assert.throws(() => buildRequestedLines('no-array'), (err) => err.code === 'VENTAS_REVERSION_LINEAS_FORMATO_INVALIDO');
    assert.throws(() => buildRequestedLines(null), (err) => err.code === 'VENTAS_REVERSION_LINEAS_FORMATO_INVALIDO');
  });

  it('lineas no vacio', () => {
    assert.throws(() => buildRequestedLines([]), (err) => err.code === 'VENTAS_REVERSION_LINEAS_REQUERIDAS');
  });

  it('maximo razonable de lineas', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ id_detalle_factura: i + 1, cantidad: 1 }));
    assert.throws(() => buildRequestedLines(many), (err) => err.code === 'VENTAS_REVERSION_LINEAS_EXCEDE_MAXIMO');
  });

  it('22) cada linea debe ser un objeto (no arreglo, no primitivo)', () => {
    assert.throws(() => buildRequestedLines([[1001, 1]]), (err) => err.code === 'VENTAS_REVERSION_LINEA_INVALIDA');
    assert.throws(() => buildRequestedLines(['1001']), (err) => err.code === 'VENTAS_REVERSION_LINEA_INVALIDA');
    assert.throws(() => buildRequestedLines([null]), (err) => err.code === 'VENTAS_REVERSION_LINEA_INVALIDA');
  });

  it('26) id_detalle_factura debe ser entero positivo seguro (no arreglo/objeto)', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: [1001], cantidad: 1 }]), (err) => err.code === 'VENTAS_REVERSION_LINEA_INVALIDA');
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: { a: 1 }, cantidad: 1 }]), (err) => err.code === 'VENTAS_REVERSION_LINEA_INVALIDA');
    assert.throws(() => buildRequestedLines([{ cantidad: 1 }]), (err) => err.code === 'VENTAS_REVERSION_LINEA_INVALIDA');
  });

  it('23) cantidad cero -> invalida', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: 0 }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
  });

  it('24) cantidad negativa -> invalida', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: -1 }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
  });

  it('25) cantidad decimal -> invalida', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: 1.5 }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
  });

  it('cantidad NaN/Infinity -> invalida', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: NaN }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: Infinity }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
  });

  it('cantidad como texto parcialmente numerico -> invalida', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: '5abc' }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
  });

  it('cantidad como arreglo -> invalida (no se coacciona [5] a 5)', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: [5] }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
  });

  it('cantidad como objeto -> invalida', () => {
    assert.throws(() => buildRequestedLines([{ id_detalle_factura: 1, cantidad: { valor: 5 } }]), (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA');
  });

  it('27) linea con id_detalle_factura de otra factura no se valida aqui (responsabilidad de resolveReversionLines)', () => {
    const map = buildRequestedLines([{ id_detalle_factura: 999999, cantidad: 1 }]);
    assert.equal(map.get(999999), 1);
  });

  it('overflow: la suma consolidada debe seguir siendo un entero seguro', () => {
    assert.throws(
      () => buildRequestedLines([
        { id_detalle_factura: 1, cantidad: Number.MAX_SAFE_INTEGER },
        { id_detalle_factura: 1, cantidad: Number.MAX_SAFE_INTEGER }
      ]),
      (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_OVERFLOW'
    );
  });
});

const buildLine = ({ id, cantidadVendida, subTotal, totalDetalle, idProducto = 10, descuentoLinea = 0, isvPorcentaje = 0 }) => ({
  id_detalle_factura: id,
  id_producto: idProducto,
  id_receta: null,
  id_detalle_pedido: null,
  origen_snapshot: null,
  cantidad_vendida: cantidadVendida,
  precio_unitario: totalDetalle / cantidadVendida,
  sub_total: subTotal,
  total_detalle: totalDetalle,
  descuento_linea: descuentoLinea,
  isv_porcentaje: isvPorcentaje,
  tipo_item: 'PRODUCTO',
  devuelve_inventario: true
});

// Construye una entrada del mapa de "ya reversado" (cantidad + montos por
// tipo), tal como lo produce resolveAlreadyReversedQty a partir de las
// reversiones APLICADAS previas.
const reversed = (cantidad, { subtotal = 0, descuento = 0, isv15 = 0, isv18 = 0, total = subtotal } = {}) => ({
  cantidad,
  subtotal,
  descuento,
  isv_15: isv15,
  isv_18: isv18,
  total
});

describe('resolveReversionLines', () => {
  it('28) reversion TOTAL sobre factura sin reversion previa', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 2, subTotal: 200, totalDetalle: 200 })];
    const lines = resolveReversionLines({
      tipoReversion: 'TOTAL',
      requestedLines: new Map(),
      facturaLines,
      reversedQtyMap: new Map()
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].cantidad_revertida, 2);
    assert.equal(lines[0].total_revertido, 200);
  });

  it('14) TOTAL despues de una PARCIAL previa: solo reversa el saldo restante', () => {
    const facturaLines = [
      buildLine({ id: 1, cantidadVendida: 2, subTotal: 100, totalDetalle: 100 }),
      buildLine({ id: 2, cantidadVendida: 1, subTotal: 30, totalDetalle: 30 })
    ];
    const reversedQtyMap = new Map([[1, reversed(1, { subtotal: 50, total: 50 })]]);
    const lines = resolveReversionLines({
      tipoReversion: 'TOTAL',
      requestedLines: new Map(),
      facturaLines,
      reversedQtyMap
    });
    const hamburguesa = lines.find((l) => l.id_detalle_factura === 1);
    const refresco = lines.find((l) => l.id_detalle_factura === 2);
    assert.equal(hamburguesa.cantidad_revertida, 1);
    assert.equal(hamburguesa.total_revertido, 50);
    assert.equal(refresco.cantidad_revertida, 1);
    assert.equal(refresco.total_revertido, 30);
  });

  it('20) PARCIAL con una cantidad menor a la original no afecta otras lineas', () => {
    const facturaLines = [
      buildLine({ id: 1, cantidadVendida: 5, subTotal: 500, totalDetalle: 500 }),
      buildLine({ id: 2, cantidadVendida: 3, subTotal: 90, totalDetalle: 90 })
    ];
    const requestedLines = new Map([[1, 2]]);
    const lines = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines,
      facturaLines,
      reversedQtyMap: new Map()
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id_detalle_factura, 1);
    assert.equal(lines[0].cantidad_revertida, 2);
    assert.equal(lines[0].total_revertido, 200);
  });

  it('22) PARCIAL con cantidad superior a la disponible -> VENTAS_REVERSION_CANTIDAD_EXCEDE_DISPONIBLE', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 2, subTotal: 100, totalDetalle: 100 })];
    const requestedLines = new Map([[1, 5]]);
    assert.throws(
      () => resolveReversionLines({ tipoReversion: 'PARCIAL', requestedLines, facturaLines, reversedQtyMap: new Map() }),
      (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_EXCEDE_DISPONIBLE'
    );
  });

  it('linea ya agotada (saldo 0) -> VENTAS_REVERSION_CANTIDAD_EXCEDE_DISPONIBLE (mismo codigo unificado)', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 2, subTotal: 100, totalDetalle: 100 })];
    const requestedLines = new Map([[1, 1]]);
    assert.throws(
      () => resolveReversionLines({ tipoReversion: 'PARCIAL', requestedLines, facturaLines, reversedQtyMap: new Map([[1, reversed(2, { subtotal: 100, total: 100 })]]) }),
      (err) => err.code === 'VENTAS_REVERSION_CANTIDAD_EXCEDE_DISPONIBLE'
    );
  });

  it('27) linea que no pertenece a la factura -> VENTAS_REVERSION_LINEA_NO_PERTENECE', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 2, subTotal: 100, totalDetalle: 100 })];
    const requestedLines = new Map([[9999, 1]]);
    assert.throws(
      () => resolveReversionLines({ tipoReversion: 'PARCIAL', requestedLines, facturaLines, reversedQtyMap: new Map() }),
      (err) => err.code === 'VENTAS_REVERSION_LINEA_NO_PERTENECE'
    );
  });

  it('30) factura ya completamente reversada -> VENTAS_REVERSION_TOTALMENTE_APLICADA', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 2, subTotal: 100, totalDetalle: 100 })];
    assert.throws(
      () => resolveReversionLines({ tipoReversion: 'TOTAL', requestedLines: new Map(), facturaLines, reversedQtyMap: new Map([[1, reversed(2, { subtotal: 100, total: 100 })]]) }),
      (err) => err.code === 'VENTAS_REVERSION_TOTALMENTE_APLICADA'
    );
  });

  it('33) solo cuenta reversiones APLICADAS (el mapa de entrada ya representa solo APLICADA por contrato)', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 5, subTotal: 500, totalDetalle: 500 })];
    const lines = resolveReversionLines({
      tipoReversion: 'TOTAL',
      requestedLines: new Map(),
      facturaLines,
      reversedQtyMap: new Map([[1, reversed(2, { subtotal: 200, total: 200 })]])
    });
    assert.equal(lines[0].cantidad_revertida, 3);
  });

  it('35) descuento proporcional al prorratear (linea que NO completa)', () => {
    const line = buildLine({ id: 1, cantidadVendida: 4, subTotal: 400, totalDetalle: 360, descuentoLinea: 40 });
    const lines = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line],
      reversedQtyMap: new Map()
    });
    assert.equal(lines[0].descuento_revertido, 10);
    assert.equal(lines[0].subtotal_revertido, 100);
    assert.equal(lines[0].total_revertido, 90);
  });

  it('1) L10.00 dividido entre 3 unidades: primera parcial prorratea 3.33', () => {
    const line = buildLine({ id: 1, cantidadVendida: 3, subTotal: 10, totalDetalle: 10 });
    const lines = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line],
      reversedQtyMap: new Map()
    });
    assert.equal(lines[0].total_revertido, 3.33);
  });

  it('2-3) tres reversiones de 1 unidad sobre L10.00/3: la ultima absorbe el residuo (3.33+3.33+3.34=10.00)', () => {
    const line = () => buildLine({ id: 1, cantidadVendida: 3, subTotal: 10, totalDetalle: 10 });

    // Reversion 1 de 3: no completa la linea (quedan 2 de 3 pendientes).
    const op1 = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line()],
      reversedQtyMap: new Map()
    })[0];
    assert.equal(op1.total_revertido, 3.33);

    // Reversion 2 de 3: tampoco completa (queda 1 de 3 pendiente).
    const op2 = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line()],
      reversedQtyMap: new Map([[1, reversed(1, { subtotal: op1.subtotal_revertido, total: op1.total_revertido })]])
    })[0];
    assert.equal(op2.total_revertido, 3.33);

    // Reversion 3 de 3: COMPLETA la linea -> debe absorber el residuo
    // exacto (10.00 - 3.33 - 3.33 = 3.34), no un prorrateo nuevo.
    const acumuladoPrevio = reversed(2, {
      subtotal: op1.subtotal_revertido + op2.subtotal_revertido,
      total: op1.total_revertido + op2.total_revertido
    });
    const op3 = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line()],
      reversedQtyMap: new Map([[1, acumuladoPrevio]])
    })[0];
    assert.equal(op3.total_revertido, 3.34);

    const sumaTotal = Number((op1.total_revertido + op2.total_revertido + op3.total_revertido).toFixed(2));
    assert.equal(sumaTotal, 10.00);
  });

  it('4) descuento con residuo: la reversion que completa la linea absorbe el residuo de descuento', () => {
    // Descuento total L10.00 sobre 3 unidades -> 3.33/3.33/3.34.
    const line = () => buildLine({ id: 1, cantidadVendida: 3, subTotal: 30, totalDetalle: 20, descuentoLinea: 10 });
    const op1 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 1]]), facturaLines: [line()], reversedQtyMap: new Map()
    })[0];
    const op2 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 1]]), facturaLines: [line()],
      reversedQtyMap: new Map([[1, reversed(1, { subtotal: op1.subtotal_revertido, descuento: op1.descuento_revertido, total: op1.total_revertido })]])
    })[0];
    const op3 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 1]]), facturaLines: [line()],
      reversedQtyMap: new Map([[1, reversed(2, {
        subtotal: op1.subtotal_revertido + op2.subtotal_revertido,
        descuento: op1.descuento_revertido + op2.descuento_revertido,
        total: op1.total_revertido + op2.total_revertido
      })]])
    })[0];
    const sumaDescuento = Number((op1.descuento_revertido + op2.descuento_revertido + op3.descuento_revertido).toFixed(2));
    assert.equal(sumaDescuento, 10.00);
    // La ultima operacion (completa la linea) no debe ser un prorrateo
    // nuevo (10/3=3.33) sino el residuo exacto restante.
    assert.notEqual(op3.descuento_revertido, 3.33);
  });

  it('5) ISV con residuo (fixture con isv_porcentaje=15): la reversion que completa absorbe el residuo de ISV 15', () => {
    // sub_total elegido para que el ISV 15 original sea exactamente
    // L10.00 sobre 3 unidades -- el mismo patron de residuo que el caso
    // monetario (3.33/3.33/3.34), para verificar que el ISV tambien usa
    // "residuo restante" en la operacion que completa la linea, no un
    // reprorrateo ciego que daria 3.33 en las tres operaciones.
    const line = () => buildLine({ id: 1, cantidadVendida: 3, subTotal: 66.6667, totalDetalle: 76.6667, isvPorcentaje: 15 });
    const op1 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 1]]), facturaLines: [line()], reversedQtyMap: new Map()
    })[0];
    const op2 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 1]]), facturaLines: [line()],
      reversedQtyMap: new Map([[1, reversed(1, { subtotal: op1.subtotal_revertido, isv15: op1.isv_15_revertido, total: op1.total_revertido })]])
    })[0];
    const op3 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 1]]), facturaLines: [line()],
      reversedQtyMap: new Map([[1, reversed(2, {
        subtotal: op1.subtotal_revertido + op2.subtotal_revertido,
        isv15: op1.isv_15_revertido + op2.isv_15_revertido,
        total: op1.total_revertido + op2.total_revertido
      })]])
    })[0];
    assert.equal(op1.isv_15_revertido, 3.33);
    assert.equal(op2.isv_15_revertido, 3.33);
    assert.equal(op3.isv_15_revertido, 3.34, 'la operacion que completa la linea debe absorber el residuo (3.34), no reprorratear (3.33)');
    const sumaIsv15 = Number((op1.isv_15_revertido + op2.isv_15_revertido + op3.isv_15_revertido).toFixed(2));
    assert.equal(sumaIsv15, 10.00);
  });

  it('6) total despues de parciales: la suma final coincide exactamente con el total original de la linea', () => {
    const original = buildLine({ id: 1, cantidadVendida: 3, subTotal: 10, totalDetalle: 10 });
    const op1 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 1]]), facturaLines: [original], reversedQtyMap: new Map()
    })[0];
    const op2 = resolveReversionLines({
      tipoReversion: 'PARCIAL', requestedLines: new Map([[1, 2]]), facturaLines: [original],
      reversedQtyMap: new Map([[1, reversed(1, { subtotal: op1.subtotal_revertido, total: op1.total_revertido })]])
    })[0];
    const suma = Number((op1.total_revertido + op2.total_revertido).toFixed(2));
    assert.equal(suma, original.total_detalle);
    assert.equal(op2.cantidad_revertida, 2);
  });

  it('7) cabecera REV = suma exacta de los detalles (monto_reversado se construye sumando total_revertido)', () => {
    const facturaLines = [
      buildLine({ id: 1, cantidadVendida: 3, subTotal: 10, totalDetalle: 10 }),
      buildLine({ id: 2, cantidadVendida: 2, subTotal: 20, totalDetalle: 20 })
    ];
    const lines = resolveReversionLines({
      tipoReversion: 'TOTAL',
      requestedLines: new Map(),
      facturaLines,
      reversedQtyMap: new Map()
    });
    const montoReversado = Number(lines.reduce((acc, l) => acc + Number(l.total_revertido || 0), 0).toFixed(2));
    assert.equal(montoReversado, 30);
  });

  it('39) residuo de centavos: primera parcial de una serie prorratea normalmente', () => {
    const line = buildLine({ id: 1, cantidadVendida: 3, subTotal: 10, totalDetalle: 10 });
    const lines = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line],
      reversedQtyMap: new Map()
    });
    assert.equal(lines[0].total_revertido, 3.33);
  });

  it('nunca supera el valor original: el residuo restante nunca es negativo', () => {
    const line = buildLine({ id: 1, cantidadVendida: 3, subTotal: 10, totalDetalle: 10 });
    const op3 = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line],
      // Simula que las dos operaciones previas ya devolvieron 6.67 (3.33+3.34)
      reversedQtyMap: new Map([[1, reversed(2, { subtotal: 6.67, total: 6.67 })]])
    })[0];
    assert.ok(op3.total_revertido >= 0);
    assert.equal(op3.total_revertido, 3.33);
  });
});

describe('validatePartialReversionApplicability', () => {
  it('no bloquea TOTAL', () => {
    assert.doesNotThrow(() => validatePartialReversionApplicability({
      tipoReversion: 'TOTAL',
      facturaLines: [buildLine({ id: 1, cantidadVendida: 1, subTotal: 10, totalDetalle: 10 })],
      reversedQtyMap: new Map()
    }));
  });

  it('bloquea PARCIAL cuando solo queda 1 unidad pendiente en total', () => {
    assert.throws(
      () => validatePartialReversionApplicability({
        tipoReversion: 'PARCIAL',
        facturaLines: [buildLine({ id: 1, cantidadVendida: 1, subTotal: 10, totalDetalle: 10 })],
        reversedQtyMap: new Map()
      }),
      (err) => err.code === 'VENTAS_REVERSION_PARCIAL_NO_APLICA'
    );
  });
});

describe('computeAccumulatedResult (seccion 16)', () => {
  it('16) ejemplo del ticket: parcial que completa la factura -> resultado TOTAL', () => {
    const facturaLines = [
      buildLine({ id: 1, cantidadVendida: 2, subTotal: 100, totalDetalle: 100 }),
      buildLine({ id: 2, cantidadVendida: 1, subTotal: 30, totalDetalle: 30 })
    ];
    const reversedQtyMapBefore = new Map([[1, reversed(1, { subtotal: 50, total: 50 })]]);
    const reversionLines = [
      { id_detalle_factura: 1, cantidad_revertida: 1 },
      { id_detalle_factura: 2, cantidad_revertida: 1 }
    ];
    const result = computeAccumulatedResult({ facturaLines, reversedQtyMapBefore, reversionLines });
    assert.equal(result.cantidad_original_total, 3);
    assert.equal(result.cantidad_reversada_anterior, 1);
    assert.equal(result.cantidad_reversada_actual, 2);
    assert.equal(result.cantidad_restante_final, 0);
    assert.equal(result.resultado_acumulado, 'TOTAL');
    assert.equal(result.factura_totalmente_reversada, true);
  });

  it('quedan cantidades -> resultado PARCIAL', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 5, subTotal: 500, totalDetalle: 500 })];
    const result = computeAccumulatedResult({
      facturaLines,
      reversedQtyMapBefore: new Map(),
      reversionLines: [{ id_detalle_factura: 1, cantidad_revertida: 2 }]
    });
    assert.equal(result.cantidad_restante_final, 3);
    assert.equal(result.resultado_acumulado, 'PARCIAL');
    assert.equal(result.factura_totalmente_reversada, false);
  });

  it('31) varias parciales acumuladas no exceden la cantidad original', () => {
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 5, subTotal: 500, totalDetalle: 500 })];
    const afterFirst = computeAccumulatedResult({
      facturaLines,
      reversedQtyMapBefore: new Map(),
      reversionLines: [{ id_detalle_factura: 1, cantidad_revertida: 2 }]
    });
    assert.equal(afterFirst.cantidad_restante_final, 3);
    const afterSecond = computeAccumulatedResult({
      facturaLines,
      reversedQtyMapBefore: new Map([[1, reversed(2, { subtotal: 200, total: 200 })]]),
      reversionLines: [{ id_detalle_factura: 1, cantidad_revertida: 3 }]
    });
    assert.equal(afterSecond.cantidad_restante_final, 0);
    assert.equal(afterSecond.factura_totalmente_reversada, true);
  });
});
