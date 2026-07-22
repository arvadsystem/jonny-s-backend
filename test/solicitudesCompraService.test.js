import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createSolicitudesCompraService,
  parseQuantity
} from '../services/solicitudesCompraService.js';

const operativeAccess = async () => ({
  idUsuario: 7,
  isSuperAdmin: false,
  roles: new Set(['CAJERO']),
  permissions: new Set()
});

const adminAccess = async () => ({
  idUsuario: 1,
  isSuperAdmin: false,
  roles: new Set(['ADMINISTRADOR']),
  permissions: new Set()
});

const operativeScope = async () => ({
  idUsuario: 7,
  isSuperAdmin: false,
  userSucursalId: 3,
  allowedSucursalIds: [3]
});

const warehouseRow = (idSucursal = 3) => ({
  id_almacen: 11,
  id_sucursal: idSucursal,
  nombre_almacen: 'Bodega principal',
  nombre_sucursal: `Sucursal ${idSucursal}`,
  estado: true
});

const resolvedMaster = (type, id) => ({
  ok: true,
  status: 200,
  masterId: id,
  master: { id_maestro: id, nombre: `${type} ${id}`, estado_global: true }
});

const activeAssignment = (type, id, warehouseId) => ({
  id_maestro: id,
  id_almacen: warehouseId,
  id_sucursal: 3,
  cantidad: 5,
  stock_minimo: 2,
  activo: true
});

const makeReadDb = (handler) => ({ query: handler });

const makeTransactionDb = (handler) => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim();
      calls.push({ sql: normalized, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [], rowCount: 0 };
      return handler(normalized, params, calls);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); }
  };
  return { db: { connect: async () => client }, calls };
};

const baseOverrides = (db, extra = {}) => ({
  db,
  readAccess: operativeAccess,
  resolveScope: operativeScope,
  resolveMaster: async (type, id) => resolvedMaster(type, id),
  getAssignment: async (type, id, warehouseId) => activeAssignment(type, id, warehouseId),
  ...extra
});

test('catalogo devuelve productos del almacen con stock local', async () => {
  const db = makeReadDb(async (sql) => {
    if (sql.includes('FROM public.almacenes a') && !sql.includes('WITH catalogo')) return { rows: [warehouseRow()], rowCount: 1 };
    if (sql.includes('WITH catalogo')) return {
      rows: [{
        tipo_item: 'PRODUCTO', id_item: 20, nombre: 'Agua', descripcion: 'Botella', categoria: 'Bebidas',
        id_almacen: 11, nombre_almacen: 'Bodega principal', id_sucursal: 3, nombre_sucursal: 'Sucursal 3',
        cantidad: '4.5', stock_minimo: '5', estado_stock: 'STOCK_BAJO', unidad_base: 'Unidad',
        presentaciones: [], total_count: 1
      }],
      rowCount: 1
    };
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(db));
  const result = await service.listCatalog({ query: { id_almacen: 11, tipo: 'producto' } });
  assert.equal(result.items[0].tipo_item, 'producto');
  assert.equal(result.items[0].cantidad, 4.5);
  assert.equal(result.items[0].estado_stock, 'STOCK_BAJO');
  assert.deepEqual(result.items[0].presentaciones, []);
});

test('catalogo devuelve insumos con presentaciones de compra', async () => {
  const presentation = {
    id_presentacion: 9,
    nombre_presentacion: 'Saco',
    cantidad_presentacion: 1,
    unidad_presentacion: 'Saco',
    cantidad_base: 25,
    unidad_base: 'Kilogramo',
    factor_conversion: 25,
    es_predeterminada_compra: true
  };
  const db = makeReadDb(async (sql) => {
    if (sql.includes('FROM public.almacenes a') && !sql.includes('WITH catalogo')) return { rows: [warehouseRow()], rowCount: 1 };
    return {
      rows: [{
        tipo_item: 'INSUMO', id_item: 30, nombre: 'Harina', descripcion: null, categoria: 'Secos',
        id_almacen: 11, nombre_almacen: 'Bodega principal', id_sucursal: 3, nombre_sucursal: 'Sucursal 3',
        cantidad: '0', stock_minimo: '2.5', estado_stock: 'SIN_STOCK', unidad_base: 'Kilogramo (kg)',
        presentaciones: [presentation], total_count: 1
      }],
      rowCount: 1
    };
  });
  const service = createSolicitudesCompraService(baseOverrides(db));
  const result = await service.listCatalog({ query: { id_almacen: 11, tipo: 'insumo' } });
  assert.deepEqual(result.items[0].presentaciones, [presentation]);
});

test('catalogo bloquea almacen de otra sucursal para operativo', async () => {
  const db = makeReadDb(async () => ({ rows: [warehouseRow(4)], rowCount: 1 }));
  const service = createSolicitudesCompraService(baseOverrides(db));
  await assert.rejects(
    service.listCatalog({ query: { id_almacen: 11 } }),
    (error) => error.status === 403 && error.code === 'FORBIDDEN'
  );
});

test('crea solicitud de producto con snapshot Unidad', async () => {
  const tx = makeTransactionDb(async (sql, params) => {
    if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
    if (sql.includes('INSERT INTO public.solicitudes_compra (')) {
      return { rows: [{ id_solicitud_compra: 40, estado: 'PENDIENTE', fecha_creacion: '2026-07-21T12:00:00Z' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.solicitudes_compra_detalle')) {
      assert.equal(params[1], 'PRODUCTO');
      assert.equal(params[6], 'Unidad');
      assert.equal(params[7], '1');
      assert.equal(params[8], '3');
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(tx.db));
  const result = await service.create({ body: { id_almacen: 11, detalles: [{ tipo_item: 'producto', id_item: 10, cantidad: 3 }] } });
  assert.equal(result.id_solicitud_compra, 40);
  assert.equal(result.estado, 'PENDIENTE');
  assert.equal(result.total_lineas, 1);
});

test('crea insumo en unidad base con factor 1', async () => {
  const tx = makeTransactionDb(async (sql, params) => {
    if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
    if (sql.includes('SELECT i.id_unidad_medida AS id_unidad_base')) {
      return { rows: [{ id_unidad_base: 5, nombre_unidad_base: 'Gramo' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.solicitudes_compra (')) {
      return { rows: [{ id_solicitud_compra: 41, estado: 'PENDIENTE', fecha_creacion: '2026-07-21T12:00:00Z' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.solicitudes_compra_detalle')) {
      assert.equal(params[1], 'INSUMO');
      assert.equal(params[5], 5);
      assert.equal(params[6], 'Gramo');
      assert.equal(params[7], '1');
      assert.equal(params[8], '1500');
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(tx.db));
  await service.create({ body: { id_almacen: 11, detalles: [{ tipo_item: 'insumo', id_item: 50, cantidad: 1500 }] } });
});

test('crea insumo con presentacion y conserva su snapshot', async () => {
  const tx = makeTransactionDb(async (sql, params) => {
    if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
    if (sql.includes('FROM public.insumo_presentaciones ip')) {
      return { rows: [{ id_presentacion: 15, id_insumo: 230, id_unidad_base: 5, id_unidad_base_insumo: 5, nombre_presentacion: 'Bolsa', factor_conversion: '1000' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.solicitudes_compra (')) {
      return { rows: [{ id_solicitud_compra: 42, estado: 'PENDIENTE', fecha_creacion: '2026-07-21T12:00:00Z' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.solicitudes_compra_detalle')) {
      assert.equal(params[4], 15);
      assert.equal(params[6], 'Bolsa');
      assert.equal(params[7], '1000');
      assert.equal(params[8], '2');
      assert.match(sql, /\$9::numeric \* \$8::numeric/);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(tx.db));
  await service.create({ body: { id_almacen: 11, detalles: [{ tipo_item: 'insumo', id_item: 230, id_presentacion_insumo: 15, cantidad: 2 }] } });
});

test('conversion a unidad base usa cantidad por factor de base de datos', () => {
  const requested = parseQuantity('2.5');
  assert.equal(requested.decimal, '2.5');
  assert.equal(Number(requested.decimal) * 1000, 2500);
});

test('rechaza presentacion perteneciente a otro insumo', async () => {
  const tx = makeTransactionDb(async (sql) => {
    if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
    if (sql.includes('FROM public.insumo_presentaciones ip')) {
      return { rows: [{ id_presentacion: 15, id_insumo: 999, id_unidad_base: 5, id_unidad_base_insumo: 5, nombre_presentacion: 'Bolsa', factor_conversion: '1000' }], rowCount: 1 };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(tx.db));
  await assert.rejects(
    service.create({ body: { id_almacen: 11, detalles: [{ tipo_item: 'insumo', id_item: 230, id_presentacion_insumo: 15, cantidad: 2 }] } }),
    (error) => error.status === 400 && /no pertenece/.test(error.message)
  );
  assert.ok(tx.calls.some((call) => call.sql === 'ROLLBACK'));
});

test('rechaza item sin asignacion activa al almacen', async () => {
  const tx = makeTransactionDb(async (sql) => {
    if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(tx.db, { getAssignment: async () => null }));
  await assert.rejects(
    service.create({ body: { id_almacen: 11, detalles: [{ tipo_item: 'producto', id_item: 10, cantidad: 1 }] } }),
    (error) => error.status === 409 && /asignacion activa/.test(error.message)
  );
});

test('rechaza cantidades cero, negativas y decimales para productos', async () => {
  for (const cantidad of [0, -1, '1.5']) {
    const tx = makeTransactionDb(async (sql) => {
      if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
      throw new Error('No debe consultar el item');
    });
    const service = createSolicitudesCompraService(baseOverrides(tx.db));
    await assert.rejects(
      service.create({ body: { id_almacen: 11, detalles: [{ tipo_item: 'producto', id_item: 10, cantidad }] } }),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR'
    );
  }
});

test('rechaza proveedor y campos financieros', async () => {
  for (const payload of [
    { id_almacen: 11, id_proveedor: 2, detalles: [{ tipo_item: 'producto', id_item: 10, cantidad: 1 }] },
    { id_almacen: 11, detalles: [{ tipo_item: 'producto', id_item: 10, cantidad: 1, precio: 25 }] }
  ]) {
    const service = createSolicitudesCompraService(baseOverrides({ connect: async () => { throw new Error('No debe conectar'); } }));
    await assert.rejects(service.create({ body: payload }), (error) => error.status === 400 && /campos no permitidos/.test(error.message));
  }
});

test('hace rollback completo cuando falla una linea', async () => {
  let detailInserts = 0;
  const tx = makeTransactionDb(async (sql) => {
    if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
    if (sql.includes('INSERT INTO public.solicitudes_compra (')) {
      return { rows: [{ id_solicitud_compra: 43, estado: 'PENDIENTE', fecha_creacion: '2026-07-21T12:00:00Z' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.solicitudes_compra_detalle')) {
      detailInserts += 1;
      if (detailInserts === 2) throw Object.assign(new Error('fk'), { code: '23503' });
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(tx.db));
  await assert.rejects(
    service.create({ body: { id_almacen: 11, detalles: [
      { tipo_item: 'producto', id_item: 10, cantidad: 1 },
      { tipo_item: 'producto', id_item: 11, cantidad: 1 }
    ] } }),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR'
  );
  assert.ok(tx.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!tx.calls.some((call) => call.sql === 'COMMIT'));
});

test('listado operativo queda limitado por sucursal', async () => {
  let captured;
  const db = makeReadDb(async (sql, params) => {
    captured = { sql, params };
    return { rows: [], rowCount: 0 };
  });
  const service = createSolicitudesCompraService(baseOverrides(db));
  await service.list({ query: {} });
  assert.match(captured.sql, /sc\.id_sucursal = \$1/);
  assert.equal(captured.params[0], 3);
});

test('detalle operativo responde 403 para otra sucursal', async () => {
  let calls = 0;
  const db = makeReadDb(async () => {
    calls += 1;
    return { rows: [{ id_solicitud_compra: 44, id_sucursal: 4 }], rowCount: 1 };
  });
  const service = createSolicitudesCompraService(baseOverrides(db));
  await assert.rejects(
    service.getById({ params: { id_solicitud_compra: 44 } }),
    (error) => error.status === 403 && error.code === 'FORBIDDEN'
  );
  assert.equal(calls, 1);
});

test('detalle expone IDs reales distintos y conserva encabezado, proveedor y cantidades', async () => {
  const header = {
    id_solicitud_compra: '44', id_sucursal: '3', nombre_sucursal: 'Sucursal 3',
    id_almacen: '11', nombre_almacen: 'Bodega principal', id_usuario_solicitante: '7',
    solicitante_nombre: 'Operador', estado: 'APROBADA', observacion_solicitud: 'Reposicion',
    comentario_revision: 'Aprobada', observacion_recepcion: null,
    fecha_creacion: '2026-07-21T12:00:00Z', fecha_revision: '2026-07-21T13:00:00Z',
    fecha_recepcion: null, inventario_aplicado: false, fecha_inventario_aplicado: null,
    tiene_evidencia: false, id_usuario_recepcion: null, receptor_nombre: null,
    id_usuario_revisor: '1', revisor_nombre: 'Administrador'
  };
  const provider = { id_proveedor: 5, nombre_proveedor: 'Proveedor Central' };
  const details = [
    {
      id_solicitud_detalle: '15', tipo_item: 'INSUMO', id_item: '230', nombre: 'Harina',
      categoria: 'Secos', cantidad_solicitada: '2', presentacion_snapshot: 'Saco 25 kg',
      cantidad_base_solicitada: '50', unidad_base: 'Kilogramo', cantidad_aprobada: '2',
      cantidad_base_aprobada: '50', proveedor: provider, cantidad_recibida: null,
      cantidad_base_recibida: null, stock_actual: '20', stock_minimo: '5', estado_stock: 'DISPONIBLE'
    },
    {
      id_solicitud_detalle: '16', tipo_item: 'INSUMO', id_item: '230', nombre: 'Harina',
      categoria: 'Secos', cantidad_solicitada: '3', presentacion_snapshot: 'Bolsa 1 kg',
      cantidad_base_solicitada: '3', unidad_base: 'Kilogramo', cantidad_aprobada: '2.5',
      cantidad_base_aprobada: '2.5', proveedor: null, cantidad_recibida: '2',
      cantidad_base_recibida: '2', stock_actual: '20', stock_minimo: '5', estado_stock: 'DISPONIBLE'
    }
  ];
  let detailSql = '';
  const db = makeReadDb(async (sql) => {
    if (sql.includes('FROM public.solicitudes_compra sc')) return { rows: [header], rowCount: 1 };
    if (sql.includes('FROM public.solicitudes_compra_detalle d')) {
      detailSql = sql;
      return { rows: details, rowCount: 2 };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(db, { readAccess: adminAccess }));
  const result = await service.getById({ params: { id_solicitud_compra: 44 } });

  assert.match(detailSql, /SELECT\s+d\.id_solicitud_detalle,\s*d\.tipo_item/);
  assert.match(detailSql, /ORDER BY d\.id_solicitud_detalle/);
  assert.deepEqual(result.solicitud, {
    id_solicitud_compra: 44,
    sucursal: { id_sucursal: 3, nombre: 'Sucursal 3' },
    almacen: { id_almacen: 11, nombre: 'Bodega principal' },
    solicitante: { id_usuario: 7, nombre: 'Operador' },
    estado: 'APROBADA', observacion_solicitud: 'Reposicion', comentario_revision: 'Aprobada',
    observacion_recepcion: null, fecha_creacion: '2026-07-21T12:00:00Z',
    fecha_revision: '2026-07-21T13:00:00Z', fecha_recepcion: null,
    inventario_aplicado: false, fecha_inventario_aplicado: null, tiene_evidencia: false,
    receptor: null, revisor: { id_usuario: 1, nombre: 'Administrador' }
  });
  assert.deepEqual(result.detalles.map((line) => line.id_solicitud_detalle), [15, 16]);
  assert.ok(result.detalles.every((line) => Number.isInteger(line.id_solicitud_detalle) && line.id_solicitud_detalle > 0));
  assert.equal(result.detalles[0].id_item, result.detalles[1].id_item);
  assert.notEqual(result.detalles[0].id_solicitud_detalle, result.detalles[0].id_item);
  assert.notEqual(result.detalles[0].presentacion_snapshot, result.detalles[1].presentacion_snapshot);
  assert.deepEqual(result.detalles[0].proveedor, provider);
  assert.deepEqual(
    result.detalles.map(({ cantidad_solicitada, cantidad_aprobada, cantidad_recibida }) => ({ cantidad_solicitada, cantidad_aprobada, cantidad_recibida })),
    [
      { cantidad_solicitada: 2, cantidad_aprobada: 2, cantidad_recibida: null },
      { cantidad_solicitada: 3, cantidad_aprobada: 2.5, cantidad_recibida: 2 }
    ]
  );
});

test('servicio no crea movimientos de inventario', async () => {
  const source = await readFile(new URL('../services/solicitudesCompraService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /INSERT\s+INTO\s+public\.movimientos_inventario/i);
  assert.doesNotMatch(source, /UPDATE\s+public\.(?:productos_almacenes|insumos_almacenes)/i);
});

test('lineas duplicadas se agrupan antes de insertar', async () => {
  let detailInserts = 0;
  const tx = makeTransactionDb(async (sql, params) => {
    if (sql.includes('FROM public.almacenes a')) return { rows: [warehouseRow()], rowCount: 1 };
    if (sql.includes('INSERT INTO public.solicitudes_compra (')) {
      return { rows: [{ id_solicitud_compra: 45, estado: 'PENDIENTE', fecha_creacion: '2026-07-21T12:00:00Z' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.solicitudes_compra_detalle')) {
      detailInserts += 1;
      assert.equal(params[8], '5');
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraService(baseOverrides(tx.db));
  const result = await service.create({ body: { id_almacen: 11, detalles: [
    { tipo_item: 'producto', id_item: 10, cantidad: 2 },
    { tipo_item: 'producto', id_item: 10, cantidad: 3 }
  ] } });
  assert.equal(detailInserts, 1);
  assert.equal(result.total_lineas, 1);
});

test('administrador puede filtrar listado por sucursal sin datos financieros', async () => {
  let captured;
  const db = makeReadDb(async (sql, params) => {
    captured = { sql, params };
    return { rows: [], rowCount: 0 };
  });
  const service = createSolicitudesCompraService(baseOverrides(db, { readAccess: adminAccess }));
  await service.list({ query: { id_sucursal: 8 } });
  assert.match(captured.sql, /sc\.id_sucursal = \$1/);
  assert.doesNotMatch(captured.sql, /precio|costo|total_monetario/i);
  assert.equal(captured.params[0], 8);
});

test('router nuevo conserva montados los endpoints base y su orden seguro', async () => {
  const [appSource, routerSource] = await Promise.all([
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../routers/solicitudes_compra.js', import.meta.url), 'utf8')
  ]);
  assert.match(appSource, /app\.use\('\/solicitudes_compra', solicitudesCompraRoutes\)/);
  assert.match(routerSource, /router\.get\('\/catalogo'/);
  assert.match(routerSource, /router\.post\('\/'/);
  assert.match(routerSource, /router\.get\('\/'/);
  assert.match(routerSource, /router\.get\('\/:id_solicitud_compra'/);
  assert.ok(routerSource.indexOf("router.get('/catalogo'") < routerSource.indexOf("router.get('/:id_solicitud_compra'"));
});
