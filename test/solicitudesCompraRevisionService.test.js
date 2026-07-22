import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createSolicitudesCompraRevisionService,
  multiplyApprovedQuantityToBase
} from '../services/solicitudesCompraRevisionService.js';
import { createSolicitudesCompraService } from '../services/solicitudesCompraService.js';

const adminAccess = async () => ({
  idUsuario: 2,
  isSuperAdmin: false,
  roles: new Set(['ADMINISTRADOR']),
  permissions: new Set()
});

const superAdminAccess = async () => ({
  idUsuario: 1,
  isSuperAdmin: true,
  roles: new Set(),
  permissions: new Set()
});

const cashierAccess = async () => ({
  idUsuario: 3,
  isSuperAdmin: false,
  roles: new Set(['CAJERO']),
  permissions: new Set(['INVENTARIO_OC_APROBAR', 'INVENTARIO_OC_RECHAZAR'])
});

const cookAccess = async () => ({
  idUsuario: 4,
  isSuperAdmin: false,
  roles: new Set(['COCINERA']),
  permissions: new Set(['INVENTARIO_OC_RECHAZAR'])
});

const productStored = (id = 10) => ({
  id_solicitud_detalle: id,
  tipo_item: 'PRODUCTO',
  id_producto: 100 + id,
  id_insumo: null,
  factor_conversion_snapshot: '1'
});

const supplyStored = (id = 11, factor = '2.5') => ({
  id_solicitud_detalle: id,
  tipo_item: 'INSUMO',
  id_producto: null,
  id_insumo: 200 + id,
  factor_conversion_snapshot: factor
});

const approvalBody = (details = [
  { id_solicitud_detalle: 10, cantidad_aprobada: 3, id_proveedor: 5 }
]) => ({ comentario_revision: '  Revisado   correctamente ', detalles: details });

const makeTransactionDb = (handler) => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim();
      calls.push({ sql: normalized, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [], rowCount: 0 };
      return handler(normalized, params, calls);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    }
  };
  return { db: { connect: async () => client }, calls };
};

const makeApprovalFixture = ({
  access = adminAccess,
  state = 'PENDIENTE',
  inventoryApplied = false,
  stored = [productStored()],
  activeProviderIds = [5],
  failDetailUpdateAt = null,
  masterActive = true,
  assignmentActive = true,
  onResolveMaster = null,
  onGetAssignment = null
} = {}) => {
  let detailUpdates = 0;
  const tx = makeTransactionDb(async (sql, params) => {
    if (sql.includes('FROM public.solicitudes_compra') && sql.includes('id_almacen') && sql.includes('FOR UPDATE')) {
      return {
        rows: [{ id_solicitud_compra: 8, id_almacen: 12, estado: state, inventario_aplicado: inventoryApplied }],
        rowCount: 1
      };
    }
    if (sql.includes('FROM public.solicitudes_compra_detalle') && sql.includes('FOR UPDATE')) {
      return { rows: stored, rowCount: stored.length };
    }
    if (sql.includes('FROM public.proveedores') && sql.includes('ANY($1::int[])')) {
      return { rows: activeProviderIds.map((id) => ({ id_proveedor: id })), rowCount: activeProviderIds.length };
    }
    if (sql.startsWith('UPDATE public.solicitudes_compra_detalle')) {
      detailUpdates += 1;
      if (failDetailUpdateAt === detailUpdates) throw Object.assign(new Error('update failed'), { code: '23503' });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE public.solicitudes_compra')) {
      return {
        rows: [{
          id_solicitud_compra: 8,
          estado: 'APROBADA',
          id_usuario_revisor: access === superAdminAccess ? 1 : 2,
          fecha_revision: '2026-07-22T12:00:00Z'
        }],
        rowCount: 1
      };
    }
    throw new Error(`Consulta inesperada: ${sql.slice(0, 80)}`);
  });
  const service = createSolicitudesCompraRevisionService({
    db: tx.db,
    readAccess: access,
    resolveMaster: async (type, id) => {
      if (onResolveMaster) onResolveMaster(type, id);
      return {
        ok: true,
        masterId: id,
        master: { id_maestro: id, estado_global: masterActive, nombre: `${type} ${id}` }
      };
    },
    getAssignment: async (type, id) => {
      if (onGetAssignment) onGetAssignment(type, id);
      return { id_almacen: 12, activo: assignmentActive };
    }
  });
  return { service, calls: tx.calls };
};

const approveRequest = (body = approvalBody()) => ({
  params: { id_solicitud_compra: 8 },
  body
});

test('administrador consulta un catalogo minimo de proveedores activos', async () => {
  let capturedSql = '';
  const db = {
    async query(sql) {
      capturedSql = sql;
      return { rows: [{ id_proveedor: 5, nombre_proveedor: 'Proveedor Activo', total_count: 1 }], rowCount: 1 };
    }
  };
  const service = createSolicitudesCompraRevisionService({ db, readAccess: adminAccess });
  const result = await service.listProviders({ query: {} });
  assert.deepEqual(result.proveedores, [{ id_proveedor: 5, nombre_proveedor: 'Proveedor Activo' }]);
  assert.deepEqual(result.pagination, { page: 1, limit: 20, total: 1, total_pages: 1 });
  assert.match(capturedSql, /COALESCE\(p\.estado, true\) = true/);
  assert.doesNotMatch(capturedSql, /rtn|telefono|correo|direccion|precio|costo/i);
});

test('proveedor inactivo no aparece en el catalogo', async () => {
  const db = {
    async query(sql) {
      assert.match(sql, /COALESCE\(p\.estado, true\) = true/);
      return { rows: [], rowCount: 0 };
    }
  };
  const service = createSolicitudesCompraRevisionService({ db, readAccess: adminAccess });
  const result = await service.listProviders({ query: { buscar: 'Inactivo' } });
  assert.deepEqual(result.proveedores, []);
  assert.equal(result.pagination.total, 0);
});

test('cajero no puede consultar proveedores aunque tenga permiso', async () => {
  let queried = false;
  const db = { async query() { queried = true; return { rows: [] }; } };
  const service = createSolicitudesCompraRevisionService({ db, readAccess: cashierAccess });
  await assert.rejects(service.listProviders({ query: {} }), (error) => error.status === 403 && error.code === 'FORBIDDEN');
  assert.equal(queried, false);
});

test('cajero no puede aprobar aunque tenga permiso', async () => {
  const fixture = makeApprovalFixture({ access: cashierAccess });
  await assert.rejects(fixture.service.approve(approveRequest()), (error) => error.status === 403);
  assert.ok(fixture.calls.some((call) => call.sql === 'ROLLBACK'));
});

test('cocinera no puede rechazar aunque tenga permiso', async () => {
  const tx = makeTransactionDb(async () => { throw new Error('No debe consultar solicitud'); });
  const service = createSolicitudesCompraRevisionService({ db: tx.db, readAccess: cookAccess });
  await assert.rejects(
    service.reject({ params: { id_solicitud_compra: 8 }, body: { comentario_revision: 'Sin existencia' } }),
    (error) => error.status === 403
  );
  assert.ok(tx.calls.some((call) => call.sql === 'ROLLBACK'));
});

test('administrador aprueba solicitud PENDIENTE', async () => {
  const fixture = makeApprovalFixture();
  const result = await fixture.service.approve(approveRequest());
  assert.equal(result.solicitud.estado, 'APROBADA');
  assert.equal(result.solicitud.id_usuario_revisor, 2);
  assert.equal(result.solicitud.total_lineas, 1);
  assert.ok(fixture.calls.some((call) => call.sql.includes('FOR UPDATE')));
  assert.ok(fixture.calls.some((call) => call.sql === 'COMMIT'));
});

test('superadministrador aprueba mediante bypass de rol actual', async () => {
  const fixture = makeApprovalFixture({ access: superAdminAccess });
  const result = await fixture.service.approve(approveRequest());
  assert.equal(result.solicitud.id_usuario_revisor, 1);
  assert.equal(result.solicitud.estado, 'APROBADA');
});

test('cantidad decimal de producto es rechazada', async () => {
  const fixture = makeApprovalFixture();
  await assert.rejects(
    fixture.service.approve(approveRequest(approvalBody([
      { id_solicitud_detalle: 10, cantidad_aprobada: 1.5, id_proveedor: 5 }
    ]))),
    (error) => error.status === 400 && /entero positivo/.test(error.message)
  );
});

test('cantidad de insumo con cuatro decimales es aceptada', async () => {
  const fixture = makeApprovalFixture({ stored: [supplyStored(11, '2.5')] });
  const result = await fixture.service.approve(approveRequest(approvalBody([
    { id_solicitud_detalle: 11, cantidad_aprobada: '1.2345', id_proveedor: 5 }
  ])));
  assert.equal(result.solicitud.estado, 'APROBADA');
});

test('cantidad_base_aprobada usa factor_conversion_snapshot con redondeo a cuatro decimales', async () => {
  assert.equal(multiplyApprovedQuantityToBase('1.2345', '2.5'), '3.0863');
  const fixture = makeApprovalFixture({ stored: [supplyStored(11, '2.5')] });
  await fixture.service.approve(approveRequest(approvalBody([
    { id_solicitud_detalle: 11, cantidad_aprobada: '1.2345', id_proveedor: 5 }
  ])));
  const update = fixture.calls.find((call) => call.sql.startsWith('UPDATE public.solicitudes_compra_detalle'));
  assert.equal(update.params[2], '1.2345');
  assert.equal(update.params[3], '3.0863');
});

test('proveedor inexistente es rechazado', async () => {
  const fixture = makeApprovalFixture({ activeProviderIds: [] });
  await assert.rejects(fixture.service.approve(approveRequest()), (error) => error.status === 400 && /proveedores/.test(error.message));
});

test('proveedor inactivo es rechazado por validacion agrupada', async () => {
  const fixture = makeApprovalFixture({ activeProviderIds: [] });
  await assert.rejects(fixture.service.approve(approveRequest()), (error) => error.code === 'VALIDATION_ERROR');
  const providerQuery = fixture.calls.find((call) => call.sql.includes('FROM public.proveedores'));
  assert.match(providerQuery.sql, /COALESCE\(estado, true\) = true/);
  assert.deepEqual(providerQuery.params, [[5]]);
});

test('linea faltante es rechazada', async () => {
  const fixture = makeApprovalFixture({ stored: [productStored(10), productStored(12)] });
  await assert.rejects(fixture.service.approve(approveRequest()), (error) => error.status === 400 && /exactamente/.test(error.message));
});

test('linea adicional es rechazada', async () => {
  const fixture = makeApprovalFixture({ stored: [productStored(10)] });
  await assert.rejects(
    fixture.service.approve(approveRequest(approvalBody([
      { id_solicitud_detalle: 10, cantidad_aprobada: 1, id_proveedor: 5 },
      { id_solicitud_detalle: 12, cantidad_aprobada: 1, id_proveedor: 5 }
    ]))),
    (error) => error.status === 400 && /exactamente/.test(error.message)
  );
});

test('ID de detalle duplicado es rechazado antes de abrir transaccion', async () => {
  let connected = false;
  const service = createSolicitudesCompraRevisionService({
    db: { async connect() { connected = true; throw new Error('No debe conectar'); } },
    readAccess: adminAccess
  });
  await assert.rejects(
    service.approve(approveRequest(approvalBody([
      { id_solicitud_detalle: 10, cantidad_aprobada: 1, id_proveedor: 5 },
      { id_solicitud_detalle: 10, cantidad_aprobada: 2, id_proveedor: 5 }
    ]))),
    (error) => error.status === 400 && /duplicados/.test(error.message)
  );
  assert.equal(connected, false);
});

test('detalle de otra solicitud es rechazado', async () => {
  const fixture = makeApprovalFixture({ stored: [productStored(10)] });
  await assert.rejects(
    fixture.service.approve(approveRequest(approvalBody([
      { id_solicitud_detalle: 99, cantidad_aprobada: 1, id_proveedor: 5 }
    ]))),
    (error) => error.status === 400 && /no pertenece/.test(error.message)
  );
});

test('solicitud no PENDIENTE no puede aprobarse', async () => {
  const fixture = makeApprovalFixture({ state: 'APROBADA' });
  await assert.rejects(fixture.service.approve(approveRequest()), (error) => error.status === 409 && error.code === 'INVALID_STATE');
});

test('solicitud no PENDIENTE no puede rechazarse', async () => {
  const tx = makeTransactionDb(async (sql) => {
    if (sql.includes('FROM public.solicitudes_compra')) {
      return { rows: [{ id_solicitud_compra: 8, estado: 'RECHAZADA', inventario_aplicado: false }], rowCount: 1 };
    }
    throw new Error('No debe actualizar');
  });
  const service = createSolicitudesCompraRevisionService({ db: tx.db, readAccess: adminAccess });
  await assert.rejects(
    service.reject({ params: { id_solicitud_compra: 8 }, body: { comentario_revision: 'Duplicada' } }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE'
  );
});

test('rechazo exige comentario no vacio', async () => {
  let connected = false;
  const service = createSolicitudesCompraRevisionService({
    db: { async connect() { connected = true; throw new Error('No debe conectar'); } },
    readAccess: adminAccess
  });
  await assert.rejects(
    service.reject({ params: { id_solicitud_compra: 8 }, body: { comentario_revision: '   ' } }),
    (error) => error.status === 400 && /obligatorio/.test(error.message)
  );
  assert.equal(connected, false);
});

test('rechazo guarda comentario normalizado, revisor y fecha', async () => {
  let updateParams;
  const tx = makeTransactionDb(async (sql, params) => {
    if (sql.includes('FROM public.solicitudes_compra')) {
      return { rows: [{ id_solicitud_compra: 8, estado: 'PENDIENTE', inventario_aplicado: false }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE public.solicitudes_compra')) {
      updateParams = params;
      assert.match(sql, /fecha_revision = NOW\(\)/);
      return {
        rows: [{ id_solicitud_compra: 8, estado: 'RECHAZADA', comentario_revision: params[1], id_usuario_revisor: params[2], fecha_revision: '2026-07-22T12:00:00Z' }],
        rowCount: 1
      };
    }
    throw new Error('Consulta inesperada');
  });
  const service = createSolicitudesCompraRevisionService({ db: tx.db, readAccess: adminAccess });
  const result = await service.reject({
    params: { id_solicitud_compra: 8 },
    body: { comentario_revision: '  No   corresponde  ' }
  });
  assert.deepEqual(updateParams, [8, 'No corresponde', 2]);
  assert.equal(result.solicitud.estado, 'RECHAZADA');
  assert.equal(result.solicitud.id_usuario_revisor, 2);
  assert.ok(tx.calls.some((call) => call.sql === 'COMMIT'));
});

test('error en actualizacion ejecuta ROLLBACK y no COMMIT', async () => {
  const fixture = makeApprovalFixture({
    stored: [productStored(10), productStored(12)],
    failDetailUpdateAt: 2
  });
  await assert.rejects(
    fixture.service.approve(approveRequest(approvalBody([
      { id_solicitud_detalle: 10, cantidad_aprobada: 1, id_proveedor: 5 },
      { id_solicitud_detalle: 12, cantidad_aprobada: 2, id_proveedor: 5 }
    ]))),
    (error) => error.status === 400
  );
  assert.ok(fixture.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!fixture.calls.some((call) => call.sql === 'COMMIT'));
});

test('detalle devuelve proveedor como objeto sin datos financieros', async () => {
  let queryIndex = 0;
  const db = {
    async query(sql) {
      queryIndex += 1;
      if (queryIndex === 1) {
        return {
          rows: [{
            id_solicitud_compra: 8, id_sucursal: 3, id_almacen: 12, id_usuario_solicitante: 7,
            nombre_sucursal: 'Sucursal', nombre_almacen: 'Bodega', solicitante_nombre: 'Usuario',
            estado: 'APROBADA', observacion_solicitud: null, comentario_revision: null,
            observacion_recepcion: null, fecha_creacion: '2026-07-22', fecha_revision: '2026-07-22',
            fecha_recepcion: null, id_usuario_revisor: 2, revisor_nombre: 'Admin'
          }],
          rowCount: 1
        };
      }
      assert.match(sql, /LEFT JOIN public\.proveedores prov/);
      return {
        rows: [{
          tipo_item: 'PRODUCTO', id_item: 110, nombre: 'Producto', categoria: 'Categoria',
          cantidad_solicitada: '3', presentacion_snapshot: 'Unidad', cantidad_base_solicitada: '3',
          unidad_base: null, cantidad_aprobada: '2', cantidad_base_aprobada: '2',
          proveedor: { id_proveedor: 5, nombre_proveedor: 'Proveedor' }, cantidad_recibida: null,
          stock_actual: '4', stock_minimo: '2', estado_stock: 'DISPONIBLE'
        }],
        rowCount: 1
      };
    }
  };
  const service = createSolicitudesCompraService({
    db,
    readAccess: adminAccess,
    resolveScope: async () => ({ userSucursalId: 3, allowedSucursalIds: [3] })
  });
  const result = await service.getById({ params: { id_solicitud_compra: 8 } });
  assert.deepEqual(result.detalles[0].proveedor, { id_proveedor: 5, nombre_proveedor: 'Proveedor' });
  assert.equal(result.detalles[0].cantidad_base_aprobada, 2);
  assert.equal('precio' in result.detalles[0].proveedor, false);
});

test('revision no crea movimientos ni actualiza asignaciones de inventario', async () => {
  const source = await readFile(new URL('../services/solicitudesCompraRevisionService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /INSERT\s+INTO\s+public\.movimientos_inventario/i);
  assert.doesNotMatch(source, /UPDATE\s+public\.(?:productos_almacenes|insumos_almacenes)/i);
});

test('rutas administrativas se declaran antes del detalle dinamico', async () => {
  const source = await readFile(new URL('../routers/solicitudes_compra.js', import.meta.url), 'utf8');
  const dynamicIndex = source.indexOf("router.get('/:id_solicitud_compra'");
  assert.ok(source.indexOf("router.get('/proveedores'") >= 0);
  assert.ok(source.indexOf("router.put('/:id_solicitud_compra/aprobar'") >= 0);
  assert.ok(source.indexOf("router.put('/:id_solicitud_compra/rechazar'") >= 0);
  assert.ok(source.indexOf("router.get('/proveedores'") < dynamicIndex);
  assert.ok(source.indexOf("router.put('/:id_solicitud_compra/aprobar'") < dynamicIndex);
  assert.ok(source.indexOf("router.put('/:id_solicitud_compra/rechazar'") < dynamicIndex);
});

test('codigo nuevo no contiene acceso Supabase, CLI, credenciales ni clientes administrativos', async () => {
  const sources = await Promise.all([
    readFile(new URL('../services/solicitudesCompraRevisionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../routers/solicitudes_compra.js', import.meta.url), 'utf8')
  ]);
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /supabase|service_role|execute_sql|apply_migration|project[_-]?id|cluideiojeikzcmmizhe/i);
});

test('aprobacion revalida maestro y asignacion local sin modificar stock', async () => {
  let masterChecks = 0;
  let assignmentChecks = 0;
  const fixture = makeApprovalFixture({
    stored: [productStored(10), supplyStored(11)],
    onResolveMaster: () => { masterChecks += 1; },
    onGetAssignment: () => { assignmentChecks += 1; }
  });
  await fixture.service.approve(approveRequest(approvalBody([
    { id_solicitud_detalle: 10, cantidad_aprobada: 1, id_proveedor: 5 },
    { id_solicitud_detalle: 11, cantidad_aprobada: 2, id_proveedor: 5 }
  ])));
  assert.equal(masterChecks, 2);
  assert.equal(assignmentChecks, 2);
});
