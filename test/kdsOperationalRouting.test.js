import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildInvalidKitchenLinePredicate,
  buildKitchenOrderEligibilityPredicate,
  buildKitchenPreparationPredicate,
  buildKitchenProductPredicate,
  buildValidDeliveryPreferencePredicate,
  buildValidStandaloneKitchenExtraPredicate,
  routeKdsOperationalRows
} from '../routers/ventas/services/kitchenPrintRoutingService.js';
import {
  classifyPedidoOperationalRouting,
  DELIVERY_PREFERENCE_FALSE_VALUES,
  DELIVERY_PREFERENCE_TRUE_VALUES
} from '../routers/ventas/services/pedidoOperationalRoutingService.js';
import { resolveKdsWaitingMetrics } from '../routers/cocina.js';

const recipeRow = ({
  idPedido = 1,
  idDetalle = 1,
  idReceta = 20,
  idProducto = null,
  cantidad = 1,
  nombre = 'Receta valida'
} = {}) => ({
  id_pedido: idPedido,
  id_detalle_pedido: idDetalle,
  id_producto: idProducto,
  id_receta: idReceta,
  id_extra_independiente: null,
  cantidad,
  nombre_item: nombre,
  configuracion_menu: null
});

const productRow = ({
  idPedido = 1,
  idDetalle = 2,
  cantidad = 1,
  nombre = 'Producto valido',
  preference,
  includePreference = true
} = {}) => ({
  id_pedido: idPedido,
  id_detalle_pedido: idDetalle,
  id_producto: 10,
  id_receta: null,
  id_extra_independiente: null,
  cantidad,
  nombre_item: nombre,
  configuracion_menu: includePreference
    ? { entregar_con_pedido: preference }
    : null
});

const standaloneExtraRow = ({
  idPedido = 1,
  idDetalle = 3,
  idExtra = 30,
  cantidad = 1,
  nombre = 'Extra valido'
} = {}) => ({
  id_pedido: idPedido,
  id_detalle_pedido: idDetalle,
  id_producto: null,
  id_receta: null,
  id_extra_independiente: idExtra,
  cantidad,
  nombre_item: nombre,
  configuracion_menu: null
});

const routedInstructions = (rows) => routeKdsOperationalRows(rows)
  .map((row) => `${row.id_detalle_pedido}:${row.kds_instruccion_operativa}`);

test('metricas KDS rechazan referencias de inicio ausentes o invalidas', () => {
  for (const startedAt of [null, undefined, '', '   ', new Date('invalid'), 'fecha-invalida']) {
    assert.deepEqual(
      resolveKdsWaitingMetrics({ startedAt, expectedMinutes: 25 }),
      {
        minutos_en_espera: null,
        esta_proximo_a_expirar: false
      }
    );
  }
});

test('predicados SQL KDS expresan el mismo contrato operacional estricto', () => {
  const preparation = buildKitchenPreparationPredicate('dp');
  const invalid = buildInvalidKitchenLinePredicate('dp');
  const preference = buildValidDeliveryPreferencePredicate('dp');
  const standalone = buildValidStandaloneKitchenExtraPredicate('dp');
  const eligibility = buildKitchenOrderEligibilityPredicate('p');

  assert.match(preparation, /dp\.cantidad IS NOT NULL/);
  assert.match(preparation, /dp\.cantidad > 0/);
  assert.match(preparation, /TRUNC\(\(dp\.cantidad\)::numeric\)/);
  assert.match(preparation, /FROM public\.recetas recipe_route/);
  assert.match(preparation, /NULLIF\(TRIM\(recipe_route\.nombre_receta\), ''\) IS NOT NULL/);
  assert.match(standalone, /SELECT COUNT\(\*\) = 1/);
  assert.match(standalone, /COUNT\(\*\) FILTER/);
  assert.match(standalone, /dpe_route\.id_extra > 0/);
  assert.match(standalone, /TRUNC\(\(dpe_route\.cantidad\)::numeric\)/);
  assert.match(preference, /jsonb_typeof\(dp\.configuracion_menu\) = 'object'/);
  assert.match(preference, /NOT \(dp\.configuracion_menu \? 'entregar_con_pedido'\)/);
  assert.match(preference, /jsonb_typeof\(dp\.configuracion_menu->'entregar_con_pedido'\) = 'boolean'/);
  assert.match(preference, /jsonb_typeof\(dp\.configuracion_menu->'entregar_con_pedido'\) = 'number'/);
  assert.match(preference, /jsonb_typeof\(dp\.configuracion_menu->'entregar_con_pedido'\) = 'string'/);
  for (const value of [...DELIVERY_PREFERENCE_TRUE_VALUES, ...DELIVERY_PREFERENCE_FALSE_VALUES]) {
    assert.match(preference, new RegExp(`'${value}'`));
  }
  assert.match(invalid, /id_producto IS NOT NULL AND dp\.id_receta IS NOT NULL/);
  assert.match(eligibility, /EXISTS \(/);
  assert.match(eligibility, /NOT EXISTS \(/);
  assert.doesNotMatch(preference, /NOT IN \('false', '0', 'no'\)/);
  assert.doesNotMatch(preparation, /COALESCE\([^)]*cantidad[^)]*, 0\) > 0/);
});

test('matriz de 7 recetas conserva solo cantidades, nombres e IDs validos', () => {
  const cases = [
    { name: 'entero numerico', row: recipeRow(), visible: true },
    { name: 'entero como texto', row: recipeRow({ cantidad: '2' }), visible: true },
    { name: 'cero', row: recipeRow({ cantidad: 0 }), visible: false },
    { name: 'negativo', row: recipeRow({ cantidad: -1 }), visible: false },
    { name: 'fraccionario', row: recipeRow({ cantidad: 1.5 }), visible: false },
    { name: 'nombre vacio', row: recipeRow({ nombre: '' }), visible: false },
    {
      name: 'producto y receta simultaneos',
      row: recipeRow({ idProducto: 10 }),
      visible: false
    }
  ];

  assert.equal(cases.length, 7);
  for (const scenario of cases) {
    const routed = routeKdsOperationalRows([scenario.row]);
    assert.equal(routed.length > 0, scenario.visible, scenario.name);
    if (scenario.visible) {
      assert.equal(routed[0].kds_instruccion_operativa, 'PREPARAR', scenario.name);
    }
  }
});

test('matriz de 17 productos aplica preferencia estricta y bloqueo integral', () => {
  const preferenceCases = [
    { name: 'ausente', includePreference: false, valid: true, joint: true },
    { name: 'boolean true', preference: true, valid: true, joint: true },
    { name: 'boolean false', preference: false, valid: true, joint: false },
    { name: 'texto true', preference: 'true', valid: true, joint: true },
    { name: 'texto false', preference: 'false', valid: true, joint: false },
    { name: 'numero 1', preference: 1, valid: true, joint: true },
    { name: 'numero 0', preference: 0, valid: true, joint: false },
    { name: 'texto si', preference: 'si', valid: true, joint: true },
    { name: 'texto si acentuado', preference: 'sí', valid: true, joint: true },
    { name: 'texto no', preference: 'no', valid: true, joint: false },
    { name: 'texto desconocido', preference: 'talvez', valid: false, joint: false },
    { name: 'texto vacio', preference: '', valid: false, joint: false },
    { name: 'numero 2', preference: 2, valid: false, joint: false },
    { name: 'numero negativo', preference: -1, valid: false, joint: false },
    { name: 'null explicito', preference: null, valid: false, joint: false }
  ];
  const quantityCases = [
    { name: 'cantidad cero', cantidad: 0 },
    { name: 'cantidad fraccionaria', cantidad: 1.5 }
  ];
  const cases = [
    ...preferenceCases.map((scenario) => ({
      ...scenario,
      row: productRow(scenario)
    })),
    ...quantityCases.map((scenario) => ({
      ...scenario,
      valid: false,
      joint: false,
      row: productRow({ preference: true, cantidad: scenario.cantidad })
    }))
  ];

  assert.equal(cases.length, 17);
  for (const scenario of cases) {
    const rows = [recipeRow(), scenario.row];
    const routed = routeKdsOperationalRows(rows);
    if (!scenario.valid) {
      assert.deepEqual(routed, [], scenario.name);
      continue;
    }
    assert.equal(routed.some((row) => row.id_detalle_pedido === 1), true, scenario.name);
    assert.equal(
      routed.some((row) => row.id_detalle_pedido === 2),
      scenario.joint,
      scenario.name
    );
  }
});

test('matriz de 7 extras independientes exige exactamente uno valido', () => {
  const cases = [
    {
      name: 'extra valido',
      lines: [{
        tipo_item: 'ITEM',
        cantidad: 1,
        extras: [{ id_extra: 30, nombre: 'Extra valido', cantidad: 1 }]
      }],
      valid: true
    },
    {
      name: 'cantidad cero',
      lines: [{
        tipo_item: 'ITEM',
        cantidad: 1,
        extras: [{ id_extra: 30, nombre: 'Extra valido', cantidad: 0 }]
      }],
      valid: false
    },
    {
      name: 'cantidad fraccionaria',
      lines: [{
        tipo_item: 'ITEM',
        cantidad: 1,
        extras: [{ id_extra: 30, nombre: 'Extra valido', cantidad: 1.5 }]
      }],
      valid: false
    },
    {
      name: 'sin id',
      lines: [{
        tipo_item: 'ITEM',
        cantidad: 1,
        extras: [{ nombre: 'Extra valido', cantidad: 1 }]
      }],
      valid: false
    },
    {
      name: 'sin nombre',
      lines: [{
        tipo_item: 'ITEM',
        cantidad: 1,
        extras: [{ id_extra: 30, nombre: '', cantidad: 1 }]
      }],
      valid: false
    },
    {
      name: 'dos extras ambiguos',
      lines: [{
        tipo_item: 'ITEM',
        cantidad: 1,
        extras: [
          { id_extra: 30, nombre: 'Extra A', cantidad: 1 },
          { id_extra: 31, nombre: 'Extra B', cantidad: 1 }
        ]
      }],
      valid: false
    },
    {
      name: 'sin extras',
      lines: [{ tipo_item: 'ITEM', cantidad: 1, extras: [] }],
      valid: false
    }
  ];

  assert.equal(cases.length, 7);
  for (const scenario of cases) {
    const classified = classifyPedidoOperationalRouting(scenario.lines);
    assert.equal(classified.requiere_cocina, scenario.valid, scenario.name);
    assert.equal(classified.requiere_revision, !scenario.valid, scenario.name);
  }

  assert.deepEqual(
    routedInstructions([standaloneExtraRow()]),
    ['3:PREPARAR']
  );
});

test('consulta KDS usa helpers centrales, sin fallback de cantidad o nombre', () => {
  const source = fs.readFileSync(new URL('../routers/cocina.js', import.meta.url), 'utf8');
  assert.match(source, /buildKitchenOrderEligibilityPredicate\('p'/);
  assert.match(source, /buildValidStandaloneKitchenExtraRowPredicate\('dpe'\)/);
  assert.match(source, /routeKdsOperationalRows\(result\.rows\)/);
  assert.match(source, /for \(const row of operationalRows\)/);
  assert.match(source, /const cantidad = Number\(row\.cantidad\)/);
  assert.doesNotMatch(source, /parsePositiveInt\(row\.cantidad\) \|\| 0/);
  assert.doesNotMatch(source, /nombre_item: row\.nombre_item \|\| 'Item de cocina'/);
  assert.doesNotMatch(source, /nombre_extra_snapshot, 'Item de cocina'\) AS nombre_item/);
});

test('casos KDS validos, conjuntos, inmediatos, invalidos y solo-producto', () => {
  assert.deepEqual(
    routedInstructions([recipeRow(), productRow({ preference: true })]),
    ['1:PREPARAR', '2:ENTREGAR_JUNTO_CON_EL_PEDIDO']
  );
  assert.deepEqual(
    routedInstructions([recipeRow(), productRow({ preference: false })]),
    ['1:PREPARAR']
  );
  assert.deepEqual(
    routeKdsOperationalRows([recipeRow({ cantidad: 0 })]),
    []
  );
  assert.deepEqual(
    routeKdsOperationalRows([
      recipeRow(),
      productRow({ preference: true, cantidad: 0 })
    ]),
    []
  );
  assert.deepEqual(
    routeKdsOperationalRows([
      recipeRow(),
      productRow({ preference: 'talvez' })
    ]),
    []
  );
  assert.deepEqual(
    routeKdsOperationalRows([
      recipeRow(),
      {
        id_pedido: 1,
        id_detalle_pedido: 9,
        id_producto: null,
        id_receta: null,
        id_extra_independiente: null,
        cantidad: 1,
        nombre_item: 'Linea sin clasificacion',
        configuracion_menu: null
      }
    ]),
    []
  );
  assert.deepEqual(
    routeKdsOperationalRows([productRow({ preference: true })]),
    []
  );
});

test('matriz comun JS/SQL cubre los bloqueos y rutas operacionales', () => {
  const productSql = buildKitchenProductPredicate('dp');
  const preparationSql = buildKitchenPreparationPredicate('dp');
  const invalidSql = buildInvalidKitchenLinePredicate('dp');
  const matrix = [
    {
      name: 'receta valida',
      rows: [recipeRow()],
      visible: ['1:PREPARAR'],
      sql: preparationSql,
      marker: /FROM public\.recetas recipe_route/
    },
    {
      name: 'receta cantidad cero',
      rows: [recipeRow({ cantidad: 0 })],
      visible: [],
      sql: invalidSql,
      marker: /TRUNC\(\(dp\.cantidad\)::numeric\)/
    },
    {
      name: 'receta cantidad fraccionaria',
      rows: [recipeRow({ cantidad: 0.5 })],
      visible: [],
      sql: invalidSql,
      marker: /TRUNC\(\(dp\.cantidad\)::numeric\)/
    },
    {
      name: 'producto conjunto',
      rows: [recipeRow(), productRow({ preference: true })],
      visible: ['1:PREPARAR', '2:ENTREGAR_JUNTO_CON_EL_PEDIDO'],
      sql: productSql,
      marker: /entregar_con_pedido/
    },
    {
      name: 'producto inmediato',
      rows: [recipeRow(), productRow({ preference: false })],
      visible: ['1:PREPARAR'],
      sql: productSql,
      marker: /entregar_con_pedido/
    },
    {
      name: 'producto historico',
      rows: [recipeRow(), productRow({ includePreference: false })],
      visible: ['1:PREPARAR', '2:ENTREGAR_JUNTO_CON_EL_PEDIDO'],
      sql: productSql,
      marker: /configuracion_menu IS NULL/
    },
    {
      name: 'preferencia invalida',
      rows: [recipeRow(), productRow({ preference: 'talvez' })],
      visible: [],
      sql: invalidSql,
      marker: /jsonb_typeof/
    },
    {
      name: 'ids simultaneos',
      rows: [recipeRow({ idProducto: 10 })],
      visible: [],
      sql: invalidSql,
      marker: /id_producto IS NOT NULL AND dp\.id_receta IS NOT NULL/
    },
    {
      name: 'extra valido',
      rows: [standaloneExtraRow()],
      visible: ['3:PREPARAR'],
      sql: preparationSql,
      marker: /detalle_pedido_extras/
    },
    {
      name: 'extra invalido',
      rows: [standaloneExtraRow({ idExtra: null })],
      visible: [],
      sql: invalidSql,
      marker: /NOT/
    },
    {
      name: 'linea sin clasificacion',
      rows: [{
        id_pedido: 1,
        id_detalle_pedido: 8,
        id_producto: null,
        id_receta: null,
        id_extra_independiente: null,
        cantidad: 1,
        nombre_item: 'Sin clasificacion',
        configuracion_menu: null
      }],
      visible: [],
      sql: invalidSql,
      marker: /id_producto IS NULL/
    }
  ];

  for (const scenario of matrix) {
    const classifierLines = scenario.rows.map((row) => ({
      id_detalle_pedido: row.id_detalle_pedido,
      tipo_item: row.id_extra_independiente !== null && row.id_extra_independiente !== undefined
        ? 'EXTRA'
        : row.id_producto !== null && row.id_producto !== undefined
          ? 'PRODUCTO'
          : row.id_receta !== null && row.id_receta !== undefined
            ? 'RECETA'
            : 'ITEM',
      id_producto: row.id_producto,
      id_receta: row.id_receta,
      id_extra: row.id_extra_independiente,
      es_linea_extra_independiente: row.id_extra_independiente !== null
        && row.id_extra_independiente !== undefined,
      cantidad: row.cantidad,
      nombre_item: row.nombre_item,
      configuracion_menu: row.configuracion_menu,
      extras: []
    }));
    const classified = classifyPedidoOperationalRouting(classifierLines);
    const expectedVisible = scenario.visible.length > 0;
    assert.equal(classified.requiere_revision, !expectedVisible, scenario.name);
    assert.equal(classified.requiere_cocina, expectedVisible, scenario.name);
    assert.equal(routedInstructions(scenario.rows).length > 0, expectedVisible, scenario.name);
    assert.deepEqual(routedInstructions(scenario.rows), scenario.visible, scenario.name);
    assert.match(scenario.sql, scenario.marker, scenario.name);
  }
});
