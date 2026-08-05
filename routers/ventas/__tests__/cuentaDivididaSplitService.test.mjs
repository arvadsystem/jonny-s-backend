// HOTFIX (saldo dividido oculto, ronda 2): pruebas ejecutables (no regex)
// sobre las funciones puras extraidas realmente usadas por
// routers/ventas.js (listarPedidosPendientesPago y
// POST /ventas/pedidos/:id/registrar-pago). Ver
// routers/ventas/services/cuentaDivididaSplitService.js.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS,
  AUTO_BACKUP_DIVISION_LABEL_PREFIX,
  isDivisionEstadoAnulada,
  isDivisionEstadoActiva,
  isRedistributableBackupDivision,
  resolveAssignedDetalleIds,
  filterAvailableLines,
  resolveNextOrdenSequence,
  buildBackupDivisionsPlan,
  selectNewDivisionToCharge,
  resolveBackupDivisionAdjustments,
  resolveUnrepresentedLeftoverItems,
  resolveDuplicateActiveDetalleIds,
  summarizeActiveDivisions
} from '../services/cuentaDivididaSplitService.js';

const persona1Pagada = {
  id_cuenta_division: 501,
  orden: 1,
  etiqueta: 'Persona 1',
  estado: 'PAGADA',
  id_factura: 2277,
  monto_pagado: 170,
  items: [{ id_detalle_pedido: 3833 }]
};

const lineaFactory = (id, totalLinea) => ({
  id_detalle_pedido: id,
  base_sub_total: totalLinea,
  sub_total: totalLinea,
  subtotal_extras: 0,
  descuento: 0,
  total_linea: totalLinea
});

describe('1) Asignacion de ordenes con divisiones existentes (resolveNextOrdenSequence)', () => {
  it('con Persona 1 en orden=1, dos divisiones nuevas reciben orden=2 y orden=3 (nunca orden=1 otra vez)', () => {
    const ordenes = resolveNextOrdenSequence({ existingDivisions: [persona1Pagada], count: 2 });
    assert.deepEqual(ordenes, [2, 3]);
  });

  it('sin divisiones existentes, la secuencia arranca en 1', () => {
    assert.deepEqual(resolveNextOrdenSequence({ existingDivisions: [], count: 3 }), [1, 2, 3]);
  });

  it('count=0 devuelve arreglo vacio', () => {
    assert.deepEqual(resolveNextOrdenSequence({ existingDivisions: [persona1Pagada], count: 0 }), []);
  });

  it('ignora ordenes no numericos/negativos al calcular el maximo', () => {
    const ordenes = resolveNextOrdenSequence({
      existingDivisions: [{ orden: 'no-numero' }, { orden: -5 }, { orden: 4 }],
      count: 1
    });
    assert.deepEqual(ordenes, [5]);
  });
});

describe('2-3) Identificacion de lineas activamente asignadas (resolveAssignedDetalleIds) — excluye ANULADA', () => {
  it('una division PAGADA reserva sus lineas', () => {
    const ids = resolveAssignedDetalleIds([persona1Pagada]);
    assert.ok(ids.has(3833));
  });

  it('una division PENDIENTE (no respaldo automatico) reserva sus lineas', () => {
    const division = { estado: 'PENDIENTE', etiqueta: 'Persona 2', id_factura: null, monto_pagado: 0, items: [{ id_detalle_pedido: 3834 }] };
    const ids = resolveAssignedDetalleIds([division]);
    assert.ok(ids.has(3834));
  });

  it('3) una division ANULADA NUNCA reserva sus lineas', () => {
    const anulada = { estado: 'ANULADA', etiqueta: 'Persona X', id_factura: null, monto_pagado: 0, items: [{ id_detalle_pedido: 9999 }] };
    const ids = resolveAssignedDetalleIds([anulada]);
    assert.ok(!ids.has(9999));
  });

  it('isDivisionEstadoAnulada / isDivisionEstadoActiva son consistentes entre si', () => {
    const anulada = { estado: 'anulada' };
    assert.equal(isDivisionEstadoAnulada(anulada), true);
    assert.equal(isDivisionEstadoActiva(anulada), false);
    assert.equal(isDivisionEstadoActiva({ estado: 'PENDIENTE' }), true);
  });
});

describe('4) Construccion de divisiones de respaldo (buildBackupDivisionsPlan) — una division POR LINEA', () => {
  it('7) una linea sobrante -> UNA division de respaldo con esa linea', () => {
    const leftoverItems = [{ line_index: 0, cart_key: null, line: lineaFactory(3834, 170) }];
    const plan = buildBackupDivisionsPlan({ leftoverItems, startingOrden: 2 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].orden, 2);
    assert.equal(plan[0].total, 170);
    assert.equal(plan[0].items.length, 1);
    assert.ok(plan[0].etiqueta.startsWith(AUTO_BACKUP_DIVISION_LABEL_PREFIX));
  });

  it('8) varias lineas sobrantes -> UNA division INDEPENDIENTE por cada linea (nunca una sola agrupada)', () => {
    const leftoverItems = [
      { line_index: 0, cart_key: null, line: lineaFactory(3834, 170) },
      { line_index: 1, cart_key: null, line: lineaFactory(3835, 170) }
    ];
    const plan = buildBackupDivisionsPlan({ leftoverItems, startingOrden: 2 });
    assert.equal(plan.length, 2, 'debe crear una division por linea, no una sola agregada');
    assert.deepEqual(plan.map((d) => d.orden), [2, 3]);
    assert.equal(plan[0].items.length, 1);
    assert.equal(plan[1].items.length, 1);
    assert.notEqual(plan[0].items[0].line.id_detalle_pedido, plan[1].items[0].line.id_detalle_pedido);
  });

  it('9) sin lineas sobrantes -> arreglo vacio, no crea nada', () => {
    assert.deepEqual(buildBackupDivisionsPlan({ leftoverItems: [], startingOrden: 5 }), []);
  });

  it('el total de cada division de respaldo se calcula desde total_linea real, nunca inventado', () => {
    const leftoverItems = [{ line_index: 0, cart_key: null, line: lineaFactory(3834, 123.45) }];
    const plan = buildBackupDivisionsPlan({ leftoverItems, startingOrden: 1 });
    assert.equal(plan[0].total, 123.45);
  });
});

describe('10-11) isRedistributableBackupDivision', () => {
  it('10) una division automatica PENDIENTE, sin factura, sin pago -> redistribuible', () => {
    const backup = { estado: 'PENDIENTE', etiqueta: `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} 1`, id_factura: null, monto_pagado: 0 };
    assert.equal(isRedistributableBackupDivision(backup), true);
  });

  it('11) una division PAGADA no puede redistribuirse aunque tenga la etiqueta de respaldo', () => {
    const pagada = { estado: 'PAGADA', etiqueta: `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} 1`, id_factura: 999, monto_pagado: 170 };
    assert.equal(isRedistributableBackupDivision(pagada), false);
  });

  it('11) una division con factura no puede redistribuirse aunque este PENDIENTE (nunca deberia ocurrir, pero se valida explicitamente)', () => {
    const conFactura = { estado: 'PENDIENTE', etiqueta: `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} 1`, id_factura: 999, monto_pagado: 0 };
    assert.equal(isRedistributableBackupDivision(conFactura), false);
  });

  it('11) una division con monto_pagado parcial no puede redistribuirse', () => {
    const parcial = { estado: 'PENDIENTE', etiqueta: `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} 1`, id_factura: null, monto_pagado: 50 };
    assert.equal(isRedistributableBackupDivision(parcial), false);
  });

  it('una division PENDIENTE creada por el usuario (etiqueta "Persona 2") NUNCA es redistribuible por el backend, aunque cumpla lo demas', () => {
    const personaReal = { estado: 'PENDIENTE', etiqueta: 'Persona 2', id_factura: null, monto_pagado: 0 };
    assert.equal(isRedistributableBackupDivision(personaReal), false);
  });

  it('sus lineas SI quedan disponibles para un nuevo split cuando es redistribuible (resolveAssignedDetalleIds/filterAvailableLines)', () => {
    const backup = { estado: 'PENDIENTE', etiqueta: `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} 1`, id_factura: null, monto_pagado: 0, items: [{ id_detalle_pedido: 3834 }] };
    const ids = resolveAssignedDetalleIds([backup]);
    assert.ok(!ids.has(3834), 'un respaldo automatico redistribuible no reserva la linea de forma definitiva');
  });
});

describe('5) Seleccion de la nueva division que se cobrara (selectNewDivisionToCharge)', () => {
  it('resuelve por POSICION (1-based), no por el valor de orden', () => {
    const persistedDivisions = [
      { id_cuenta_division: 601, orden: 2, etiqueta: 'Persona 2' },
      { id_cuenta_division: 602, orden: 3, etiqueta: 'Persona 3' }
    ];
    assert.equal(selectNewDivisionToCharge({ persistedDivisions, position: 1 }).id_cuenta_division, 601);
    assert.equal(selectNewDivisionToCharge({ persistedDivisions, position: 2 }).id_cuenta_division, 602);
  });

  it('posicion invalida (0, negativa, fuera de rango, no numerica) -> null', () => {
    const persistedDivisions = [{ id_cuenta_division: 601, orden: 2 }];
    assert.equal(selectNewDivisionToCharge({ persistedDivisions, position: 0 }), null);
    assert.equal(selectNewDivisionToCharge({ persistedDivisions, position: -1 }), null);
    assert.equal(selectNewDivisionToCharge({ persistedDivisions, position: 5 }), null);
    assert.equal(selectNewDivisionToCharge({ persistedDivisions, position: 'x' }), null);
  });
});

describe('6) Caso integral: Persona 1 ya pagada + dos lineas restantes (pedido 2265)', () => {
  it('las dos lineas restantes estan disponibles, y al construir dos divisiones nuevas reciben orden 2 y 3 (nunca colisionan con Persona 1=orden 1)', () => {
    const allLines = [lineaFactory(3833, 170), lineaFactory(3834, 170), lineaFactory(3835, 170)];
    const disponibles = filterAvailableLines({ allLines, divisions: [persona1Pagada] });
    assert.deepEqual(disponibles.map((l) => l.id_detalle_pedido), [3834, 3835]);

    const ordenes = resolveNextOrdenSequence({ existingDivisions: [persona1Pagada], count: 2 });
    assert.deepEqual(ordenes, [2, 3], 'Persona 2 -> orden 2, Persona 3 -> orden 3');
  });
});

describe('12) NO_ENTREGADO: no debe excluir un pedido con deuda vigente del listado de pendientes de cobro', () => {
  it('EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS NO incluye NO_ENTREGADO ni COMPLETADO (Caso A confirmado por auditoria de codigo: ningun flujo que marca NO_ENTREGADO toca pedidos_pago_control)', () => {
    assert.ok(!EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('NO_ENTREGADO'));
    assert.ok(!EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('COMPLETADO'));
  });

  it('EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS SI incluye los estados con cancelacion financiera real confirmada en codigo', () => {
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('CANCELADO'));
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('ANULADO'));
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('CANCELADO_POR_NO_PAGO'));
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('CANCELADO_TIMEOUT'));
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('PAGO_ANULADO'));
  });
});

const backupItem = (itemId, detalleId, total) => ({
  id_cuenta_division_item: itemId,
  id_detalle_pedido: detalleId,
  subtotal_base: total,
  subtotal_extras: 0,
  descuento_total: 0,
  isv_total: 0,
  total_linea: total
});

const backupFactory = (items) => ({
  id_cuenta_division: 701,
  estado: 'PENDIENTE',
  etiqueta: `${AUTO_BACKUP_DIVISION_LABEL_PREFIX} historico`,
  id_factura: null,
  monto_pagado: 0,
  items
});

describe('Hotfix de saldo y representacion activa', () => {
  it('1-2) el resumen financiero excluye ANULADA y conserva exactamente el saldo activo', () => {
    const summary = summarizeActiveDivisions([
      { estado: 'PAGADA', total: 170, monto_pagado: 170, monto_pendiente: 0 },
      { estado: 'PAGADA', total: 170, monto_pagado: 170, monto_pendiente: 0 },
      { estado: 'PENDIENTE', total: 170, monto_pagado: 0, monto_pendiente: 170 },
      { estado: 'ANULADA', total: 170, monto_pagado: 0, monto_pendiente: 170 }
    ]);
    assert.deepEqual(summary, { total_dividido: 510, monto_pagado: 340, monto_pendiente: 170, pendientes: 1 });
  });

  it('3) detecta una linea representada en dos divisiones activas, pero ignora copias ANULADAS', () => {
    assert.deepEqual(resolveDuplicateActiveDetalleIds([
      { estado: 'PAGADA', items: [{ id_detalle_pedido: 3833 }] },
      { estado: 'PENDIENTE', items: [{ id_detalle_pedido: 3833 }, { id_detalle_pedido: 3834 }] },
      { estado: 'ANULADA', items: [{ id_detalle_pedido: 3834 }] }
    ]), [3833]);
  });

  it('5) redistribucion parcial quita solo la linea cubierta y recalcula el respaldo historico', () => {
    const [adjustment] = resolveBackupDivisionAdjustments({
      existingDivisions: [backupFactory([backupItem(1, 3834, 170), backupItem(2, 3835, 90)])],
      newlyAssignedDetalleIds: new Set([3834])
    });
    assert.deepEqual(adjustment.coveredItemIds, [1]);
    assert.deepEqual(adjustment.remainingItems.map((item) => item.id_detalle_pedido), [3835]);
    assert.equal(adjustment.estado, 'PENDIENTE');
    assert.equal(adjustment.total, 90);
  });

  it('6) absorcion total deja el respaldo sin lineas y lo marca ANULADA con saldo cero', () => {
    const [adjustment] = resolveBackupDivisionAdjustments({
      existingDivisions: [backupFactory([backupItem(1, 3834, 170)])],
      newlyAssignedDetalleIds: new Set([3834])
    });
    assert.equal(adjustment.estado, 'ANULADA');
    assert.deepEqual(adjustment.remainingItems, []);
    assert.equal(adjustment.total, 0);
  });

  it('7) una linea que permanece en un respaldo existente no genera un segundo respaldo', () => {
    const unresolved = resolveUnrepresentedLeftoverItems({
      leftoverItems: [
        { line_index: 1, line: lineaFactory(3835, 90) }
      ],
      existingDivisions: [backupFactory([backupItem(1, 3834, 170), backupItem(2, 3835, 90)])],
      newlyAssignedDetalleIds: new Set([3834])
    });
    assert.deepEqual(unresolved, []);
  });

  it('8) una division PAGADA o facturada nunca se ajusta como respaldo', () => {
    assert.deepEqual(resolveBackupDivisionAdjustments({
      existingDivisions: [persona1Pagada],
      newlyAssignedDetalleIds: new Set([3833])
    }), []);
  });

  it('8) un respaldo parcialmente pagado no se ajusta y mantiene sus lineas reservadas', () => {
    const partial = {
      ...backupFactory([backupItem(1, 3834, 170)]),
      monto_pagado: 50
    };
    assert.deepEqual(resolveBackupDivisionAdjustments({
      existingDivisions: [partial],
      newlyAssignedDetalleIds: new Set([3834])
    }), []);
    assert.ok(resolveAssignedDetalleIds([partial]).has(3834));
  });

  it('7) un pedido con todas las divisiones activas PAGADA queda sin saldo ni pendientes', () => {
    const summary = summarizeActiveDivisions([
      { estado: 'PAGADA', total: 170, monto_pagado: 170, monto_pendiente: 0 },
      { estado: 'PAGADA', total: 170, monto_pagado: 170, monto_pendiente: 0 },
      { estado: 'PAGADA', total: 170, monto_pagado: 170, monto_pendiente: 0 },
      { estado: 'ANULADA', total: 170, monto_pagado: 0, monto_pendiente: 170 }
    ]);
    assert.equal(summary.monto_pendiente, 0);
    assert.equal(summary.pendientes, 0);
    assert.equal(summary.total_dividido, 510);
  });

  it('9) dos intentos sobre la misma linea producen una duplicidad detectable', () => {
    assert.deepEqual(resolveDuplicateActiveDetalleIds([
      { estado: 'PENDIENTE', items: [{ id_detalle_pedido: 3834 }] },
      { estado: 'PENDIENTE', items: [{ id_detalle_pedido: 3834 }] }
    ]), [3834]);
  });
});
