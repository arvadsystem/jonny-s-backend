import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStandaloneExtraLine } from '../routers/ventas/utils/parseUtils.js';
import { buildPedidoKitchenPrintPayload } from '../routers/ventas/services/pedidoKitchenPrintPayloadService.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import { buildVentaTicketPdfDefinition } from '../routers/ventas/services/ventaTicketPdfService.js';
import { buildVentaDetailPayloadForScope } from '../routers/ventas/handlers/ventasReadHandlers.js';
import {
  buildSplitAccountNormalizedBreakdown,
  fetchCuentaDividida,
  normalizeSplitAccountStandaloneExtra
} from '../routers/ventas/services/ventaDetalleReadService.js';

test('linea sin producto/receta con exactamente un extra se clasifica como EXTRA con snapshot financiero', () => {
  const result = resolveStandaloneExtraLine({
    idProducto: null,
    idReceta: null,
    extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH', cantidad: 4, precio_unitario: 10, subtotal: 40 }]
  });
  assert.deepEqual(result, {
    id_extra: 3,
    nombre_extra_snapshot: 'Extra Ranch',
    codigo_extra_snapshot: 'EXT-RANCH',
    cantidad: 4,
    precio_unitario: 10,
    subtotal: 40
  });
});

test('no clasifica como extra si tiene producto/receta o si hay 0 o varios extras', () => {
  assert.equal(resolveStandaloneExtraLine({ idProducto: 5, idReceta: null, extras: [{ nombre: 'X' }] }), null);
  assert.equal(resolveStandaloneExtraLine({ idProducto: null, idReceta: 9, extras: [{ nombre: 'X' }] }), null);
  assert.equal(resolveStandaloneExtraLine({ idProducto: null, idReceta: null, extras: [] }), null);
  assert.equal(resolveStandaloneExtraLine({
    idProducto: null,
    idReceta: null,
    extras: [{ nombre: 'A' }, { nombre: 'B' }]
  }), null);
});

test('extra sin nombre no se clasifica como valido', () => {
  assert.equal(resolveStandaloneExtraLine({ idProducto: null, idReceta: null, extras: [{ id_extra: 3, cantidad: 2 }] }), null);
});

test('cuenta dividida normaliza un unico extra independiente sin duplicarlo', () => {
  const item = normalizeSplitAccountStandaloneExtra({
    tipo_item: 'ITEM',
    id_producto: null,
    id_receta: null,
    nombre_item: 'Item de pedido',
    cantidad: 1,
    precio_unitario: 40,
    subtotal_base: 0,
    subtotal_extras: 40,
    total_linea: 40,
    extras: [{
      id_extra: 14,
      nombre: 'Extra papas sazonadas',
      cantidad: 1,
      precio_unitario: 40,
      subtotal: 40
    }]
  });

  assert.equal(item.tipo_item, 'EXTRA');
  assert.equal(item.nombre_item, 'Extra papas sazonadas');
  assert.equal(item.es_linea_extra_independiente, true);
  assert.equal(item.id_extra, 14);
  assert.equal(item.cantidad, 1);
  assert.equal(item.precio_unitario, 40);
  assert.equal(item.subtotal_base, 0);
  assert.equal(item.subtotal_extras, 40);
  assert.equal(item.total_linea, 40);
  assert.deepEqual(item.extras, []);
});

test('cuenta dividida conserva fallback seguro con cero o varios extras', () => {
  for (const extras of [[], [{ nombre: 'A' }, { nombre: 'B' }]]) {
    const item = normalizeSplitAccountStandaloneExtra({
      tipo_item: 'ITEM',
      id_producto: null,
      id_receta: null,
      nombre_item: 'Item de pedido',
      cantidad: 1,
      total_linea: 40,
      extras
    });
    assert.equal(item.tipo_item, 'ITEM');
    assert.equal(item.nombre_item, 'Item de pedido');
    assert.deepEqual(item.extras, extras);
  }
});

for (const scenario of [
  { name: 'sin descuento e impuestos deshabilitados', descuento_total: 0, isv_total: 0, total_linea: 40 },
  { name: 'descuento de linea', descuento_total: 5, isv_total: 0, total_linea: 35 },
  { name: 'descuento global persistido', descuento_total: 4, isv_total: 0, total_linea: 36 },
  { name: 'impuestos habilitados', descuento_total: 0, isv_total: 6, total_linea: 46 },
  { name: 'descuento mas ISV', descuento_total: 5, isv_total: 5.25, total_linea: 40.25 }
]) {
  test(`cuenta dividida conserva snapshot fiscal para extra independiente: ${scenario.name}`, () => {
    const item = normalizeSplitAccountStandaloneExtra({
      tipo_item: 'ITEM',
      id_producto: null,
      id_receta: null,
      nombre_item: 'Item de pedido',
      cantidad: 1,
      subtotal_base: 0,
      subtotal_extras: 40,
      descuento_total: scenario.descuento_total,
      isv_total: scenario.isv_total,
      total_linea: scenario.total_linea,
      extras: [{ nombre: 'Extra papas', cantidad: 1, precio_unitario: 40, subtotal: 40 }]
    });

    assert.equal(item.subtotal_extras - item.descuento_total + item.isv_total, item.total_linea);
    assert.equal(item.descuento_total, scenario.descuento_total);
    assert.equal(item.isv_total, scenario.isv_total);
  });
}

test('desglose normalizado clasifica productos, recetas y extras sin reemplazar el total historico', () => {
  const standalone = normalizeSplitAccountStandaloneExtra({
    tipo_item: 'ITEM', id_producto: null, id_receta: null,
    subtotal_base: 40, subtotal_extras: 40, total_linea: 40,
    extras: [{ nombre: 'Extra Ranch', cantidad: 4, precio_unitario: 10, subtotal: 40 }]
  });
  const scenarios = [
    {
      name: 'producto',
      items: [{ tipo_item: 'PRODUCTO', subtotal_base: 100, subtotal_extras: 0 }],
      expected: { base: 100, extras: 0 }
    },
    {
      name: 'receta',
      items: [{ tipo_item: 'RECETA', subtotal_base: 80, subtotal_extras: 0 }],
      expected: { base: 80, extras: 0 }
    },
    {
      name: 'producto con extra asociado',
      items: [{ tipo_item: 'PRODUCTO', subtotal_base: 100, subtotal_extras: 20 }],
      expected: { base: 100, extras: 20 }
    },
    { name: 'extra independiente', items: [standalone], expected: { base: 0, extras: 40 } },
    {
      name: 'mezcla',
      items: [{ tipo_item: 'PRODUCTO', subtotal_base: 100, subtotal_extras: 20 }, standalone],
      expected: { base: 100, extras: 60 }
    }
  ];

  for (const scenario of scenarios) {
    const division = { descuento_total: 40, isv_total: 5, total: 125 };
    const result = buildSplitAccountNormalizedBreakdown({ division, items: scenario.items });
    assert.equal(result.subtotal_base, scenario.expected.base, scenario.name);
    assert.equal(result.subtotal_extras, scenario.expected.extras, scenario.name);
    assert.equal(result.descuento_total, 40, scenario.name);
    assert.equal(result.isv_total, 5, scenario.name);
    assert.equal(result.total, 125, scenario.name);
  }
});

const buildSplitAccountQueryRunner = ({ divisions, items, cobros = [] }) => ({
  query: async (sql) => {
    if (/FROM public\.ventas_cuenta_divisiones vcd/i.test(sql)) {
      return { rowCount: divisions.length, rows: divisions };
    }
    if (/FROM public\.ventas_cuenta_division_items/i.test(sql)) {
      return { rowCount: items.length, rows: items };
    }
    if (/FROM public\.facturas_cobros fc/i.test(sql)) {
      return { rowCount: cobros.length, rows: cobros };
    }
    throw new Error(`SQL inesperado: ${sql}`);
  }
});

for (const scenario of [
  { name: 'cuenta pendiente', estado: 'PENDIENTE', pagado: 0, pendiente: 40, cobros: [] },
  { name: 'pago parcial', estado: 'PENDIENTE', pagado: 20, pendiente: 20, cobros: [{ monto: 20 }] },
  { name: 'pago completo', estado: 'PAGADA', pagado: 40, pendiente: 0, cobros: [{ monto: 40 }] }
]) {
  test(`fetchCuentaDividida conserva importes historicos para ${scenario.name}`, async () => {
    const division = {
      id_cuenta_division: 51,
      id_factura: 12,
      id_pedido: 501,
      etiqueta: 'Persona 1',
      orden: 1,
      subtotal_base: 40,
      subtotal_extras: 40,
      descuento_total: 40,
      isv_total: 0,
      total: 40,
      monto_pagado: scenario.pagado,
      monto_pendiente: scenario.pendiente,
      estado: scenario.estado
    };
    const item = {
      id_cuenta_division: 51,
      id_cuenta_division_item: 61,
      tipo_item: 'ITEM',
      id_producto: null,
      id_receta: null,
      nombre_item_snapshot: 'Item de pedido',
      cantidad: 4,
      precio_unitario: 10,
      subtotal_base: 0,
      subtotal_extras: 40,
      descuento_total: 0,
      isv_total: 0,
      total_linea: 40,
      extras_snapshot: [{ nombre: 'Extra Ranch', cantidad: 4, precio_unitario: 10, subtotal: 40 }],
      complementos_snapshot: [],
      origen_snapshot: {}
    };
    const cobros = scenario.cobros.map((cobro, index) => ({
      id_factura_cobro: index + 1,
      id_cuenta_division: 51,
      id_metodo_pago: 1,
      metodo_pago: 'Efectivo',
      monto: cobro.monto
    }));
    const result = await fetchCuentaDividida(buildSplitAccountQueryRunner({
      divisions: [division], items: [item], cobros
    }), { idFactura: 12, idPedido: 501 });

    assert.equal(result.total, 40);
    assert.equal(result.monto_pagado, scenario.pagado);
    assert.equal(result.monto_pendiente, scenario.pendiente);
    assert.equal(result.divisiones[0].subtotal_base, 40);
    assert.equal(result.divisiones[0].subtotal_extras, 40);
    assert.equal(result.divisiones[0].descuento_total, 40);
    assert.equal(result.divisiones[0].desglose_normalizado.subtotal_base, 0);
    assert.equal(result.divisiones[0].desglose_normalizado.subtotal_extras, 40);
    assert.equal(result.divisiones[0].desglose_normalizado.total, 40);
    assert.equal(result.divisiones[0].items[0].nombre_item, 'Extra Ranch');
    assert.deepEqual(result.divisiones[0].items[0].extras, []);
  });
}

for (const scenario of [
  { nombre: 'Extra bacon', cantidad: 4, precio_unitario: 30, subtotal: 120 },
  { nombre: 'Extra Ranch', cantidad: 4, precio_unitario: 10, subtotal: 40 },
  { nombre: 'Extra papas sazonadas', cantidad: 3, precio_unitario: 40, subtotal: 120 }
]) {
  test(`cantidad x precio_unitario = subtotal para ${scenario.nombre}`, () => {
    const line = resolveStandaloneExtraLine({
      idProducto: null,
      idReceta: null,
      extras: [{ id_extra: 9, nombre: scenario.nombre, cantidad: scenario.cantidad, precio_unitario: scenario.precio_unitario, subtotal: scenario.subtotal }]
    });
    assert.equal(line.cantidad * line.precio_unitario, line.subtotal);
  });
}

const buildPedidoQueryRunner = (rows) => ({
  query: async (sql) => {
    if (sql.includes('information_schema.')) return { rowCount: 1, rows: [{ exists: 1 }] };
    return { rowCount: 1, rows: [{ id_pedido: 501, id_sucursal: 9, numero_pedido: 'PED-00501', items: rows }] };
  }
});

test('pedido con extra independiente se normaliza sin "Item de pedido" y con cantidad del snapshot', async () => {
  const queryRunner = buildPedidoQueryRunner([{
    id_detalle: 900, id_detalle_pedido: 900, tipo_item: 'ITEM',
    id_producto: null, id_receta: null,
    nombre_item: 'Item de pedido', nombre_producto: 'Item de pedido',
    cantidad: 4, observacion: null,
    extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH', cantidad: 4, precio_unitario: 10, subtotal: 40 }],
    configuracion_menu: null
  }]);

  const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 501);
  const item = pedido.items[0];
  assert.equal(item.tipo_item, 'EXTRA');
  assert.equal(item.nombre_item, 'Extra Ranch');
  assert.equal(item.es_linea_extra_independiente, true);
  assert.equal(item.id_extra, 3);
  assert.equal(item.codigo_extra_snapshot, 'EXT-RANCH');
  assert.equal(item.cantidad, 4);

  const html = buildComandaCocinaHtml(pedido, { widthMm: 80 });
  assert.match(html, /Extra Ranch/);
  assert.doesNotMatch(html, /Item de pedido/);
  assert.doesNotMatch(html, /Extra:\s*Extra Ranch/i);
});

test('el contador de productos excluye lineas EXTRA', async () => {
  const queryRunner = buildPedidoQueryRunner([
    { id_detalle: 1, id_detalle_pedido: 1, tipo_item: 'PRODUCTO', id_producto: 10, id_receta: null, nombre_item: '6 Alitas', cantidad: 1, extras: [], configuracion_menu: null },
    { id_detalle: 2, id_detalle_pedido: 2, tipo_item: 'ITEM', id_producto: null, id_receta: null, nombre_item: 'Item de pedido', cantidad: 4, extras: [{ id_extra: 3, nombre: 'Extra bacon', cantidad: 4, precio_unitario: 30, subtotal: 120 }], configuracion_menu: null },
    { id_detalle: 3, id_detalle_pedido: 3, tipo_item: 'ITEM', id_producto: null, id_receta: null, nombre_item: 'Item de pedido', cantidad: 4, extras: [{ id_extra: 4, nombre: 'Extra Ranch', cantidad: 4, precio_unitario: 10, subtotal: 40 }], configuracion_menu: null },
    { id_detalle: 4, id_detalle_pedido: 4, tipo_item: 'ITEM', id_producto: null, id_receta: null, nombre_item: 'Item de pedido', cantidad: 3, extras: [{ id_extra: 5, nombre: 'Extra papas', cantidad: 3, precio_unitario: 40, subtotal: 120 }], configuracion_menu: null }
  ]);
  const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 501);
  assert.equal(pedido.total_productos, 1);
  assert.equal(pedido.items.filter((i) => i.tipo_item === 'EXTRA').length, 3);
});

test('buildPedidoKitchenPrintPayload legacy (v2) conserva "Item de pedido" y no normaliza', async () => {
  const queryRunner = buildPedidoQueryRunner([{
    id_detalle: 900, id_detalle_pedido: 900, tipo_item: 'ITEM',
    id_producto: null, id_receta: null,
    nombre_item: 'Item de pedido', nombre_producto: 'Item de pedido',
    cantidad: 4, observacion: null,
    extras: [{ id_extra: 3, nombre: 'Extra Ranch', codigo: 'EXT-RANCH', cantidad: 4, precio_unitario: 10, subtotal: 40 }],
    configuracion_menu: null
  }]);
  const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 501, { normalizeStandaloneExtras: false });
  const item = pedido.items[0];
  assert.equal(item.es_linea_extra_independiente, false);
  assert.equal(item.tipo_item, 'ITEM');
  assert.equal(item.nombre_item, 'Item de pedido');
});

test('el ticket de factura no duplica el extra como fila y como detalle anidado', () => {
  const venta = {
    id_factura: 12,
    fecha_hora_facturacion: '2026-07-19T23:39:35.024Z',
    sub_total: 40, total: 40,
    items: [{
      id_detalle: 1, cantidad: 4, nombre_item: 'Extra Ranch',
      total_linea: 40, sub_total: 40, es_linea_extra_independiente: true,
      extras: [{ nombre: 'Extra Ranch', cantidad: 4, subtotal: 40 }]
    }]
  };
  const definition = buildVentaTicketPdfDefinition(venta);
  const texts = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.text !== undefined) texts.push(String(value.text));
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'text') walk(child);
    }
  };
  walk(definition.content);
  assert.equal(texts.filter((t) => t.includes('Extra Ranch')).length, 1);
  assert.doesNotMatch(texts.join('\n'), /\+ Extra Ranch/);
});

// --- Prueba integral post-facturacion: buildVentaDetailPayloadForScope --------

const buildFacturaDetailQueryRunner = ({ itemOverrides = {}, divisions = [], divisionItems = [], cobros = [] } = {}) => {
  const kitchenRow = {
    id_detalle: 71,
    id_detalle_pedido: 501,
    tipo_item: 'ITEM',
    id_producto: null,
    id_receta: null,
    nombre_item: 'Item de cocina',
    nombre_producto: 'Item de cocina',
    cantidad: 4,
    precio_unitario: 40,
    sub_total: 40,
    subtotal_linea: 40,
    total_linea: 40,
    descuento: 0, descuento_linea: 0, descuento_global: 0,
    observacion: null,
    origen_snapshot: {},
    ...itemOverrides
  };
  const facturaExtraRow = {
    id_detalle_factura: 71,
    id_extra: 3,
    nombre: 'Extra Ranch',
    codigo_extra_snapshot: 'EXT-RANCH',
    cantidad: 4,
    precio_unitario: 10,
    subtotal: 40
  };
  return {
    query: async (sql) => {
      if (sql.includes('information_schema.')) return { rowCount: 1, rows: [{ exists: 1 }] };
      if (/FROM\s+facturas\s+f/i.test(sql)) {
        return { rowCount: 1, rows: [{
          id_factura: 12, codigo_venta: 'VTA-00012', id_pedido: 501,
          fecha_hora_pedido: '2026-07-19T23:39:35.024Z', fecha_hora_facturacion: '2026-07-19T23:39:35.024Z',
          id_sucursal: 9, nombre_sucursal: 'El Carmen', id_usuario: 1, nombre_usuario: 'Ana Cajera',
          sub_total: 40, total: 40, cliente_nombre: 'Consumidor final', facturacion_snapshot: null
        }] };
      }
      if (/FROM\s+detalle_facturas\s+df/i.test(sql) && /detalle_facturas_origen/i.test(sql)) {
        return { rowCount: 1, rows: [kitchenRow] };
      }
      if (/FROM\s+public\.detalle_factura_extras/i.test(sql)) {
        return { rowCount: 1, rows: [facturaExtraRow] };
      }
      if (/FROM public\.ventas_cuenta_divisiones vcd/i.test(sql)) {
        return { rowCount: divisions.length, rows: divisions };
      }
      if (/FROM public\.ventas_cuenta_division_items/i.test(sql)) {
        return { rowCount: divisionItems.length, rows: divisionItems };
      }
      if (/FROM public\.facturas_cobros fc/i.test(sql)) {
        return { rowCount: cobros.length, rows: cobros };
      }
      if (/pedidos_delivery|pedidos_contacto|pedidos_contexto/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  };
};

test('buildVentaDetailPayloadForScope normaliza el extra independiente con precio y subtotal correctos', async () => {
  const result = await buildVentaDetailPayloadForScope({
    idFactura: 12,
    allowedSucursalIds: [9],
    queryRunner: buildFacturaDetailQueryRunner()
  });
  assert.equal(result.status, 200);
  const item = result.body.items.find((i) => i.es_linea_extra_independiente);
  assert.ok(item, 'debe existir una linea de extra independiente');
  assert.equal(item.tipo_item, 'EXTRA');
  assert.equal(item.nombre_item, 'Extra Ranch');
  assert.equal(item.cantidad, 4);
  assert.equal(item.precio_unitario, 10);
  assert.equal(item.sub_total, 40);
  assert.equal(item.total_linea, 40);
  assert.equal(item.cantidad * item.precio_unitario, item.sub_total);

  const names = result.body.items.map((i) => i.nombre_item);
  assert.ok(!names.includes('Item de pedido'), 'no debe aparecer "Item de pedido"');
  assert.ok(!names.includes('Item de cocina'), 'no debe aparecer "Item de cocina"');
  assert.equal(names.filter((n) => n === 'Extra Ranch').length, 1);
});

for (const scenario of [
  { name: 'sin descuento', descuento: 0, isv: 0, total: 40 },
  { name: 'con descuento', descuento: 5, isv: 0, total: 35 },
  { name: 'con ISV', descuento: 0, isv: 6, total: 46 },
  { name: 'con descuento e ISV', descuento: 5, isv: 5.25, total: 40.25 }
]) {
  test(`detalle de venta conserva total_linea historico del extra ${scenario.name}`, async () => {
    const result = await buildVentaDetailPayloadForScope({
      idFactura: 12,
      allowedSucursalIds: [9],
      queryRunner: buildFacturaDetailQueryRunner({
        itemOverrides: {
          total_linea: scenario.total,
          descuento: scenario.descuento,
          descuento_linea: scenario.descuento,
          isv_15_linea: scenario.isv
        }
      })
    });
    const item = result.body.items[0];
    assert.equal(item.sub_total, 40);
    assert.equal(item.subtotal_linea, 40);
    assert.equal(item.descuento_linea, scenario.descuento);
    assert.equal(item.isv_15_linea, scenario.isv);
    assert.equal(item.total_linea, scenario.total);
  });
}

test('detalle integra reversion parcial y total sin alterar la cuenta dividida historica', async () => {
  const divisions = [{
    id_cuenta_division: 51, id_factura: 12, id_pedido: 501,
    etiqueta: 'Persona 1', orden: 1,
    subtotal_base: 40, subtotal_extras: 40, descuento_total: 40, isv_total: 0,
    total: 40, monto_pagado: 40, monto_pendiente: 0, estado: 'PAGADA'
  }];
  const divisionItems = [{
    id_cuenta_division: 51, id_cuenta_division_item: 61,
    tipo_item: 'ITEM', id_producto: null, id_receta: null,
    nombre_item_snapshot: 'Item de pedido', cantidad: 4, precio_unitario: 10,
    subtotal_base: 0, subtotal_extras: 40, descuento_total: 0, isv_total: 0,
    total_linea: 40,
    extras_snapshot: [{ nombre: 'Extra Ranch', cantidad: 4, precio_unitario: 10, subtotal: 40 }],
    complementos_snapshot: [], origen_snapshot: {}
  }];
  const reversiones = [
    { id_reversion: 1, tipo_reversion: 'PARCIAL', monto_reversado: 20, lineas: [{ total_revertido: 20 }] },
    { id_reversion: 2, tipo_reversion: 'TOTAL', monto_reversado: 40, lineas: [{ total_revertido: 40 }] }
  ];
  let reversionLoads = 0;
  const result = await buildVentaDetailPayloadForScope({
    idFactura: 12,
    allowedSucursalIds: [9],
    idUsuarioDetalle: 1,
    queryRunner: buildFacturaDetailQueryRunner({ divisions, divisionItems }),
    loadReversiones: async () => {
      reversionLoads += 1;
      return reversiones;
    }
  });

  assert.equal(reversionLoads, 1);
  assert.deepEqual(result.body.reversiones, reversiones);
  assert.equal(result.body.cuenta_dividida.divisiones[0].total, 40);
  assert.equal(result.body.cuenta_dividida.divisiones[0].monto_pagado, 40);
  assert.equal(result.body.cuenta_dividida.divisiones[0].desglose_normalizado.total, 40);
  assert.equal(result.body.cuenta_dividida.divisiones[0].items[0].nombre_item, 'Extra Ranch');
});

test('buildVentaDetailPayloadForScope legacy (v2) preserva el detalle sin normalizar', async () => {
  const result = await buildVentaDetailPayloadForScope({
    idFactura: 12,
    allowedSucursalIds: [9],
    normalizeStandaloneExtras: false,
    queryRunner: buildFacturaDetailQueryRunner()
  });
  assert.equal(result.status, 200);
  const item = result.body.items[0];
  assert.ok(!item.es_linea_extra_independiente);
  assert.equal(item.nombre_item, 'Item de cocina');
});
