import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKitchenPrintValidationErrorResponse,
  buildVentaKitchenPrintPayload
} from '../routers/ventas/handlers/ventasPrintHandlers.js';
import {
  assertKitchenPrintPayload,
  findInvalidKitchenItems,
  routeKitchenPrintItems
} from '../routers/ventas/services/kitchenPrintRoutingService.js';
import {
  canRequestPedidoStateTransition
} from '../routers/ventas/services/pedidoStatePermissionService.js';
import {
  classifyPedidoOperationalRouting
} from '../routers/ventas/services/pedidoOperationalRoutingService.js';
import {
  buildKitchenSaleDetailItems
} from '../routers/ventas/services/ventaDetalleReadService.js';
import {
  enqueuePedidoComandaPrintJob,
  enqueueVentaCanonicalPrintJob
} from '../routers/printing.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import { createCanonicalPrintJob } from '../services/printJobDocumentService.js';

const recipe = (name = 'Hamburguesa') => ({
  id_detalle: 1,
  tipo_item: 'RECETA',
  id_receta: 10,
  cantidad: 1,
  nombre_item: name
});

const product = (deliverWithOrder, name = 'Coca-Cola') => ({
  id_detalle: 2,
  tipo_item: 'PRODUCTO',
  id_producto: 20,
  cantidad: 1,
  nombre_item: name,
  configuracion_menu: deliverWithOrder === undefined
    ? null
    : { entregar_con_pedido: deliverWithOrder }
});

const standaloneExtra = (overrides = {}) => ({
  id_detalle: 3,
  tipo_item: 'EXTRA',
  id_extra: 8,
  cantidad: 1,
  nombre_item: 'Extra queso',
  es_linea_extra_independiente: true,
  extras: [],
  ...overrides
});

const deliveryCharge = (overrides = {}) => ({
  id_detalle: 50,
  tipo_item: 'ITEM',
  id_producto: null,
  id_receta: null,
  id_detalle_pedido: null,
  cantidad: 1,
  nombre_item: 'Cargo logistico',
  precio_unitario: 50,
  total_linea: 50,
  origen_snapshot: { origen: 'DELIVERY' },
  ...overrides
});

const baseSale = (items) => ({
  id_factura: 40,
  id_pedido: 30,
  id_sucursal: 1,
  numero_venta: 'VTA-00040',
  items
});

const printScenarios = [
  { name: 'receta sola', items: [recipe()], expected: ['Hamburguesa'] },
  { name: 'extra independiente solo', items: [standaloneExtra()], expected: ['Extra queso'] },
  { name: 'receta y producto conjunto', items: [recipe(), product(true)], expected: ['Hamburguesa', 'Coca-Cola'] },
  { name: 'receta y producto inmediato', items: [recipe(), product(false)], expected: ['Hamburguesa'] },
  {
    name: 'receta, producto conjunto y producto inmediato',
    items: [recipe(), product(true), product(false, 'Agua inmediata')],
    expected: ['Hamburguesa', 'Coca-Cola']
  },
  {
    name: 'solo producto',
    items: [product(true)],
    errorCode: 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  },
  {
    name: 'receta y linea nula invalida',
    items: [recipe(), { id_detalle: 4, tipo_item: 'ITEM', cantidad: 1, nombre_item: '' }],
    errorCode: 'PRINT_PEDIDO_REQUIERE_REVISION'
  },
  {
    name: 'receta y linea con ambos ids',
    items: [recipe(), { id_detalle: 5, tipo_item: 'ITEM', id_producto: 1, id_receta: 2, cantidad: 1 }],
    errorCode: 'PRINT_PEDIDO_REQUIERE_REVISION'
  },
  {
    name: 'extra independiente invalido',
    items: [standaloneExtra({ id_extra: null, cantidad: 0, nombre_item: '' })],
    errorCode: 'PRINT_PEDIDO_REQUIERE_REVISION'
  },
  {
    name: 'pedido historico sin preferencia',
    items: [recipe(), product(undefined, 'Producto historico')],
    expected: ['Hamburguesa', 'Producto historico']
  }
];

test('matriz factura/pedido valida direct/agent, initial/reprint y 58/80 mm', async () => {
  for (const sourceType of ['factura', 'pedido']) {
    for (const scenario of printScenarios) {
      for (const action of ['initial', 'reprint']) {
        for (const widthMm of [58, 80]) {
          const source = sourceType === 'factura'
            ? baseSale(structuredClone(scenario.items))
            : { ...baseSale(structuredClone(scenario.items)), id_factura: null };
          const payload = buildVentaKitchenPrintPayload(source);

          if (scenario.errorCode) {
            assert.throws(
              () => assertKitchenPrintPayload(payload),
              (error) => error.status === 409 && error.code === scenario.errorCode,
              `${sourceType}/${scenario.name}/${action}/${widthMm}/direct`
            );
            await assert.rejects(
              () => createCanonicalPrintJob({ tipoDocumento: 'comanda', venta: payload, widthMm }),
              (error) => error.status === 409 && error.code === scenario.errorCode,
              `${sourceType}/${scenario.name}/${action}/${widthMm}/agent`
            );
            continue;
          }

          const operationalItems = assertKitchenPrintPayload(payload);
          assert.deepEqual(
            operationalItems.map((item) => item.nombre_item),
            scenario.expected,
            `${sourceType}/${scenario.name}/${action}/${widthMm}/direct`
          );
          const directHtml = buildComandaCocinaHtml({ ...payload, items: operationalItems }, { widthMm });
          const agentDocument = await createCanonicalPrintJob({
            tipoDocumento: 'comanda',
            venta: payload,
            widthMm
          });
          assert.equal(agentDocument.document.options.pageWidth, widthMm);
          for (const excludedName of ['Agua inmediata']) {
            assert.doesNotMatch(directHtml, new RegExp(excludedName));
            assert.doesNotMatch(agentDocument.document.data, new RegExp(excludedName));
          }
        }
      }
    }
  }
});

const deliveryPrintScenarios = [
  {
    name: 'receta y cargo',
    items: [recipe(), deliveryCharge()],
    expected: ['Hamburguesa'],
    expectedTotal: 1
  },
  {
    name: 'extra independiente y cargo',
    items: [standaloneExtra(), deliveryCharge()],
    expected: ['Extra queso'],
    expectedTotal: 0
  },
  {
    name: 'receta, producto conjunto y cargo',
    items: [recipe(), product(true), deliveryCharge()],
    expected: ['Hamburguesa', 'Coca-Cola'],
    expectedTotal: 2
  },
  {
    name: 'receta, producto inmediato y cargo',
    items: [recipe(), product(false), deliveryCharge()],
    expected: ['Hamburguesa'],
    expectedTotal: 1
  },
  {
    name: 'receta, productos conjunto e inmediato y cargo',
    items: [recipe(), product(true), product(false, 'Agua inmediata'), deliveryCharge()],
    expected: ['Hamburguesa', 'Coca-Cola'],
    expectedTotal: 2
  },
  {
    name: 'solo producto y cargo',
    items: [product(true), deliveryCharge()],
    errorCode: 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  },
  {
    name: 'solo cargo',
    items: [deliveryCharge()],
    errorCode: 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  },
  {
    name: 'cargo y linea invalida',
    items: [deliveryCharge(), { tipo_item: 'ITEM', cantidad: 1 }],
    errorCode: 'PRINT_PEDIDO_REQUIERE_REVISION'
  }
];

test('matriz de cargo delivery excluye el cargo en 128 rutas direct/agent', async () => {
  let verifiedRoutes = 0;
  for (const sourceType of ['factura', 'pedido']) {
    for (const scenario of deliveryPrintScenarios) {
      for (const action of ['initial', 'reprint']) {
        for (const widthMm of [58, 80]) {
          const source = sourceType === 'factura'
            ? baseSale(structuredClone(scenario.items))
            : { ...baseSale(structuredClone(scenario.items)), id_factura: null };
          const payload = buildVentaKitchenPrintPayload(source);

          assert.equal(payload.items_no_cocina.length, 1, `${sourceType}/${scenario.name}/${action}/${widthMm}`);
          assert.equal(payload.items_no_cocina[0].tipo_clasificacion, 'CARGO_NO_COCINA');
          assert.equal(payload.total_productos, scenario.expectedTotal || 0);

          if (scenario.errorCode) {
            assert.throws(
              () => assertKitchenPrintPayload(payload),
              (error) => error.status === 409 && error.code === scenario.errorCode,
              `${sourceType}/${scenario.name}/${action}/${widthMm}/direct`
            );
            verifiedRoutes += 1;
            await assert.rejects(
              () => createCanonicalPrintJob({ tipoDocumento: 'comanda', venta: payload, widthMm }),
              (error) => error.status === 409 && error.code === scenario.errorCode,
              `${sourceType}/${scenario.name}/${action}/${widthMm}/agent`
            );
            verifiedRoutes += 1;
            continue;
          }

          const operationalItems = assertKitchenPrintPayload(payload);
          assert.deepEqual(operationalItems.map((item) => item.nombre_item), scenario.expected);
          const directHtml = buildComandaCocinaHtml({ ...payload, items: operationalItems }, { widthMm });
          assert.doesNotMatch(directHtml, /Cargo logistico/);
          verifiedRoutes += 1;
          const agentDocument = await createCanonicalPrintJob({
            tipoDocumento: 'comanda',
            venta: payload,
            widthMm
          });
          assert.doesNotMatch(agentDocument.document.data, /Cargo logistico/);
          verifiedRoutes += 1;
        }
      }
    }
  }
  assert.equal(verifiedRoutes, 128);
});

test('matriz de cantidades exige enteros positivos y acepta "2" serializado', () => {
  const quantityCases = [
    { value: 1, valid: true },
    { value: 2, valid: true },
    { value: 0, valid: false },
    { value: -1, valid: false },
    { value: 0.5, valid: false },
    { value: Number.NaN, valid: false },
    { value: Number.POSITIVE_INFINITY, valid: false },
    { value: null, valid: false },
    { value: undefined, valid: false },
    { value: '2', valid: true },
    { value: '0', valid: false }
  ];
  const factories = [
    {
      type: 'PRODUCTO',
      build: (cantidad) => ({ ...product(true), cantidad })
    },
    {
      type: 'RECETA',
      build: (cantidad) => ({ ...recipe(), cantidad })
    },
    {
      type: 'EXTRA_INDEPENDIENTE',
      build: (cantidad) => standaloneExtra({ cantidad })
    }
  ];

  let verified = 0;
  for (const factory of factories) {
    for (const quantityCase of quantityCases) {
      const result = classifyPedidoOperationalRouting([factory.build(quantityCase.value)]);
      if (quantityCase.valid) {
        assert.equal(result.requiere_revision, false, `${factory.type}/${String(quantityCase.value)}`);
        const classified = [
          ...result.productos,
          ...result.recetas,
          ...result.extras_independientes
        ];
        assert.equal(classified[0].cantidad, Number(quantityCase.value));
      } else {
        assert.equal(result.requiere_cocina, false, `${factory.type}/${String(quantityCase.value)}`);
        assert.equal(result.requiere_revision, true, `${factory.type}/${String(quantityCase.value)}`);
        assert.equal(result.lineas_invalidas[0].motivo, 'CANTIDAD_INVALIDA');
      }
      verified += 1;
    }
  }
  assert.equal(verified, 33);
});

test('loader current conserva cantidad invalida y solo historical permite inferencia', () => {
  const row = {
    id_detalle: 1,
    tipo_item: 'RECETA',
    id_receta: 10,
    nombre_item: 'Hamburguesa',
    cantidad: null,
    sub_total: 200,
    precio_unitario: 100
  };
  const [current] = buildKitchenSaleDetailItems([row]);
  const [historical] = buildKitchenSaleDetailItems(
    [row],
    { allowHistoricalQuantityInference: true }
  );

  assert.equal(current.cantidad, null);
  assert.equal(
    classifyPedidoOperationalRouting([current]).lineas_invalidas[0].motivo,
    'CANTIDAD_INVALIDA'
  );
  assert.equal(historical.cantidad, 2);
  assert.equal(classifyPedidoOperationalRouting([historical]).requiere_revision, false);
});

test('matriz de preferencia distingue propiedad ausente, valores validos e invalidos', () => {
  const cases = [
    { name: 'ausente', config: null, valid: true, expected: true, present: false },
    { name: 'true', value: true, valid: true, expected: true },
    { name: 'false', value: false, valid: true, expected: false },
    { name: '"true"', value: 'true', valid: true, expected: true },
    { name: '"false"', value: 'false', valid: true, expected: false },
    { name: '1', value: 1, valid: true, expected: true },
    { name: '0', value: 0, valid: true, expected: false },
    { name: '"1"', value: '1', valid: true, expected: true },
    { name: '"0"', value: '0', valid: true, expected: false },
    { name: '"si"', value: 'si', valid: true, expected: true },
    { name: '"si con tilde"', value: 'sí', valid: true, expected: true },
    { name: '"no"', value: 'no', valid: true, expected: false },
    { name: '"talvez"', value: 'talvez', valid: false },
    { name: 'vacia', value: '', valid: false },
    { name: 'array', value: [], valid: false },
    { name: 'objeto', value: {}, valid: false },
    { name: '2', value: 2, valid: false },
    { name: '-1', value: -1, valid: false },
    { name: 'null presente', value: null, valid: false }
  ];

  for (const preferenceCase of cases) {
    const item = product(true);
    item.configuracion_menu = Object.hasOwn(preferenceCase, 'config')
      ? preferenceCase.config
      : { entregar_con_pedido: preferenceCase.value };
    const result = classifyPedidoOperationalRouting([recipe(), item]);
    if (preferenceCase.valid) {
      assert.equal(result.requiere_revision, false, preferenceCase.name);
      assert.equal(result.productos[0].entregar_con_pedido, preferenceCase.expected);
      assert.equal(
        result.productos[0].preferencia_entrega_presente,
        preferenceCase.present ?? true
      );
    } else {
      assert.equal(result.requiere_cocina, false, preferenceCase.name);
      assert.equal(result.requiere_revision, true, preferenceCase.name);
      assert.equal(result.lineas_invalidas[0].motivo, 'PREFERENCIA_ENTREGA_INVALIDA');
    }
  }
});

test('cargo delivery requiere metadata canonica y una linea desconocida sigue bloqueando', () => {
  const valid = classifyPedidoOperationalRouting([deliveryCharge()]);
  assert.equal(valid.requiere_revision, false);
  assert.equal(valid.items_no_cocina.length, 1);
  assert.deepEqual(valid.items_preparables, []);
  assert.deepEqual(valid.items_entrega_conjunta, []);

  const unknown = classifyPedidoOperationalRouting([
    deliveryCharge({ origen_snapshot: {}, nombre_item: 'Costo de envio' })
  ]);
  assert.equal(unknown.requiere_revision, true);
  assert.equal(unknown.lineas_invalidas[0].motivo, 'LINEA_SIN_CLASIFICACION');
});

test('clasificador reporta todas las lineas invalidas antes de rutear', () => {
  const invalidItems = [
    recipe(),
    { id_detalle: 4, tipo_item: 'ITEM', cantidad: 1 },
    { id_detalle: 5, id_producto: 1, id_receta: 2, cantidad: 1 },
    standaloneExtra({ id_extra: null, cantidad: -1, nombre_item: '' })
  ];
  const found = findInvalidKitchenItems(invalidItems);
  assert.equal(found.length, 3);
  assert.throws(
    () => routeKitchenPrintItems(invalidItems),
    (error) => error.code === 'PRINT_PEDIDO_REQUIERE_REVISION'
      && error.lineas_invalidas.length === 3
  );
});

test('GET de comanda mapea solo-producto e invalidos a HTTP 409 estable', () => {
  for (const { items, code } of [
    { items: [product(true)], code: 'PRINT_PEDIDO_NO_REQUIERE_COCINA' },
    { items: [recipe(), { tipo_item: 'ITEM', cantidad: 1 }], code: 'PRINT_PEDIDO_REQUIERE_REVISION' }
  ]) {
    const payload = buildVentaKitchenPrintPayload(baseSale(items));
    let error;
    try {
      assertKitchenPrintPayload(payload);
    } catch (caught) {
      error = caught;
    }
    const response = buildKitchenPrintValidationErrorResponse(error);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, code);
    assert.deepEqual(response.body.lineas_invalidas, error.lineas_invalidas);
  }
});

test('venta inmediata incluye receta y producto de entrega conjunta', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe(), product(true)]));
  assert.deepEqual(payload.items.map((item) => item.instruccion_operativa), [
    'PREPARAR',
    'ENTREGAR_JUNTO_CON_EL_PEDIDO'
  ]);
});

test('venta inmediata excluye producto de entrega inmediata', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe(), product(false)]));
  assert.deepEqual(payload.items.map((item) => item.nombre_item), ['Hamburguesa']);
});

test('pedido pendiente incluye producto conjunto junto a la preparacion', () => {
  const items = routeKitchenPrintItems([recipe(), product(true)]);
  assert.deepEqual(items.map((item) => item.nombre_item), ['Hamburguesa', 'Coca-Cola']);
});

test('pedido pendiente excluye producto de entrega inmediata', () => {
  const items = routeKitchenPrintItems([recipe(), product(false)]);
  assert.deepEqual(items.map((item) => item.nombre_item), ['Hamburguesa']);
});

test('venta solo-producto no genera documento de comanda', async () => {
  await assert.rejects(
    () => createCanonicalPrintJob({
      tipoDocumento: 'comanda',
      venta: baseSale([product(true)]),
      widthMm: 80
    }),
    (error) => error.status === 409 && error.code === 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  );
});

test('payload solo-producto ya filtrado conserva rechazo de no cocina al agregar configuracion', () => {
  const filtered = buildVentaKitchenPrintPayload(baseSale([product(true)]));
  const configured = buildVentaKitchenPrintPayload(filtered, { impresoras: [] });
  assert.equal(configured.requiere_revision, false);
  assert.equal(configured.requiere_cocina, false);
  assert.deepEqual(configured.lineas_invalidas, []);
  assert.throws(
    () => assertKitchenPrintPayload(configured),
    (error) => error.code === 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  );
});

test('pedido solo-producto no crea ni encola trabajo de comanda', async () => {
  let createCalls = 0;
  let enqueueCalls = 0;
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({
      req: { user: { id_usuario: 5 } },
      idPedido: 30,
      tipoDocumento: 'comanda',
      loadPedido: async () => ({
        id_pedido: 30,
        id_factura: null,
        id_sucursal: 1,
        items: [product(true)]
      }),
      createPayload: async () => { createCalls += 1; },
      enqueue: async () => { enqueueCalls += 1; }
    }),
    (error) => error.status === 409 && error.code === 'PRINT_PEDIDO_NO_REQUIERE_COCINA'
  );
  assert.equal(createCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test('factura invalida no crea documento canonico ni llama a enqueue', async () => {
  let createCalls = 0;
  let enqueueCalls = 0;
  const invalidPayload = buildVentaKitchenPrintPayload(baseSale([
    recipe(),
    { id_detalle: 9, tipo_item: 'ITEM', cantidad: 1 }
  ]));

  await assert.rejects(
    () => enqueueVentaCanonicalPrintJob({
      venta: invalidPayload,
      tipoDocumento: 'comanda',
      widthMm: 80,
      idempotencyKey: 'comanda:40:inicial',
      createPayload: async (args) => {
        createCalls += 1;
        return createCanonicalPrintJob(args);
      },
      enqueue: async () => { enqueueCalls += 1; }
    }),
    (error) => error.code === 'PRINT_PEDIDO_REQUIERE_REVISION'
  );
  assert.equal(createCalls, 1);
  assert.equal(enqueueCalls, 0);
});

test('pedido invalido se bloquea antes de crear documento o encolar', async () => {
  let createCalls = 0;
  let enqueueCalls = 0;
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({
      req: { user: { id_usuario: 5 } },
      idPedido: 30,
      tipoDocumento: 'comanda',
      loadPedido: async () => ({
        id_pedido: 30,
        id_factura: null,
        id_sucursal: 1,
        items: [recipe(), { id_detalle: 9, tipo_item: 'ITEM', cantidad: 1 }]
      }),
      createPayload: async () => { createCalls += 1; },
      enqueue: async () => { enqueueCalls += 1; }
    }),
    (error) => error.code === 'PRINT_PEDIDO_REQUIERE_REVISION'
  );
  assert.equal(createCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test('extra independiente genera comanda como PREPARAR sin extra anidado', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([{
    id_detalle: 3,
    tipo_item: 'EXTRA',
    id_extra: 8,
    cantidad: 2,
    nombre_item: 'Extra queso',
    es_linea_extra_independiente: true,
    extras: [{ id_extra: 8, nombre: 'Extra queso', cantidad: 2 }]
  }]));
  assert.equal(payload.requiere_cocina, true);
  assert.equal(payload.items[0].instruccion_operativa, 'PREPARAR');
  assert.deepEqual(payload.items[0].extras, []);
});

test('comanda separa PREPARAR y ENTREGAR JUNTO CON EL PEDIDO', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe(), product(true)]));
  const html = buildComandaCocinaHtml(payload, { widthMm: 58 });
  assert.match(html, />PREPARAR</);
  assert.match(html, />ENTREGAR JUNTO CON EL PEDIDO</);
  assert.ok(html.indexOf('Hamburguesa') < html.indexOf('Coca-Cola'));
});

test('comanda sin productos acompanantes omite la seccion vacia', () => {
  const payload = buildVentaKitchenPrintPayload(baseSale([recipe()]));
  const html = buildComandaCocinaHtml(payload, { widthMm: 80 });
  assert.match(html, />PREPARAR</);
  assert.doesNotMatch(html, />ENTREGAR JUNTO CON EL PEDIDO</);
});

test('administrador conserva autorizacion operativa para cambiar estado', async () => {
  const allowed = await canRequestPedidoStateTransition({
    req: {},
    targetState: 'EN_COCINA',
    hasAnyRole: async (_req, roles) => roles.includes('ADMINISTRADOR'),
    hasAnyPermission: async () => false
  });
  assert.equal(allowed, true);
});

test('usuario con solo permiso de lectura no puede cambiar estado', async () => {
  const allowed = await canRequestPedidoStateTransition({
    req: {},
    targetState: 'EN_COCINA',
    hasAnyRole: async () => false,
    hasAnyPermission: async (_req, permissions) => permissions.includes('VENTAS_VER')
  });
  assert.equal(allowed, false);
});
