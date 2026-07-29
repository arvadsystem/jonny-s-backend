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
    // buildRequestedLines solo valida forma/consolidacion; la pertenencia
    // a la factura se valida en resolveReversionLines (ver suite abajo).
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

const buildLine = ({ id, cantidadVendida, subTotal, totalDetalle, idProducto = 10 }) => ({
  id_detalle_factura: id,
  id_producto: idProducto,
  id_receta: null,
  id_detalle_pedido: null,
  origen_snapshot: null,
  cantidad_vendida: cantidadVendida,
  precio_unitario: totalDetalle / cantidadVendida,
  sub_total: subTotal,
  total_detalle: totalDetalle,
  descuento_linea: 0,
  isv_porcentaje: 0,
  tipo_item: 'PRODUCTO',
  devuelve_inventario: true
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
    // Ejemplo del ticket: factura 2 hamburguesas (id 1) + 1 refresco (id 2);
    // reversion parcial anterior de 1 hamburguesa; una reversion TOTAL
    // nueva debe reversar unicamente 1 hamburguesa restante + 1 refresco.
    const facturaLines = [
      buildLine({ id: 1, cantidadVendida: 2, subTotal: 100, totalDetalle: 100 }),
      buildLine({ id: 2, cantidadVendida: 1, subTotal: 30, totalDetalle: 30 })
    ];
    const reversedQtyMap = new Map([[1, 1]]);
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
      () => resolveReversionLines({ tipoReversion: 'PARCIAL', requestedLines, facturaLines, reversedQtyMap: new Map([[1, 2]]) }),
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
      () => resolveReversionLines({ tipoReversion: 'TOTAL', requestedLines: new Map(), facturaLines, reversedQtyMap: new Map([[1, 2]]) }),
      (err) => err.code === 'VENTAS_REVERSION_TOTALMENTE_APLICADA'
    );
  });

  it('33) solo cuenta reversiones APLICADAS (el mapa de entrada ya representa solo APLICADA por contrato)', () => {
    // resolveAlreadyReversedQty filtra por estado=APLICADA antes de
    // construir el mapa; aqui se confirma que resolveReversionLines confia
    // en ese mapa sin reinterpretar estados.
    const facturaLines = [buildLine({ id: 1, cantidadVendida: 5, subTotal: 500, totalDetalle: 500 })];
    const lines = resolveReversionLines({
      tipoReversion: 'TOTAL',
      requestedLines: new Map(),
      facturaLines,
      reversedQtyMap: new Map([[1, 2]])
    });
    assert.equal(lines[0].cantidad_revertida, 3);
  });

  it('35) descuento proporcional al prorratear', () => {
    const line = buildLine({ id: 1, cantidadVendida: 4, subTotal: 400, totalDetalle: 360 });
    line.descuento_linea = 40;
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

  it('39) residuo de centavos: la suma de detalles debe cuadrar con el total prorrateado linea por linea', () => {
    const line = buildLine({ id: 1, cantidadVendida: 3, subTotal: 10, totalDetalle: 10 });
    const lines = resolveReversionLines({
      tipoReversion: 'PARCIAL',
      requestedLines: new Map([[1, 1]]),
      facturaLines: [line],
      reversedQtyMap: new Map()
    });
    // ratio = 1/3 -> 10 * 0.3333 = 3.33 redondeado a 2 decimales
    assert.equal(lines[0].total_revertido, 3.33);
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
    const reversedQtyMapBefore = new Map([[1, 1]]);
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
      reversedQtyMapBefore: new Map([[1, 2]]),
      reversionLines: [{ id_detalle_factura: 1, cantidad_revertida: 3 }]
    });
    assert.equal(afterSecond.cantidad_restante_final, 0);
    assert.equal(afterSecond.factura_totalmente_reversada, true);
  });
});
