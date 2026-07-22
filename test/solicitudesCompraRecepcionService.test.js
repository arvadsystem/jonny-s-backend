import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSolicitudesCompraRecepcionService } from '../services/solicitudesCompraRecepcionService.js';

const imageData = (mime = 'image/jpeg', extraBytes = 0) => {
  const signatures = {
    'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'image/webp': Buffer.from('RIFF0000WEBP', 'ascii'),
    'application/pdf': Buffer.from('%PDF-', 'ascii')
  };
  return `data:${mime};base64,${Buffer.concat([signatures[mime], Buffer.alloc(extraBytes)]).toString('base64')}`;
};

const product = (overrides = {}) => ({
  id_solicitud_detalle: 10, tipo_item: 'PRODUCTO', id_producto: 101, id_insumo: null,
  factor_conversion_snapshot: '1', cantidad_aprobada: '2', cantidad_base_aprobada: '2', id_proveedor: 5,
  ...overrides
});
const supply = (overrides = {}) => ({
  id_solicitud_detalle: 11, tipo_item: 'INSUMO', id_producto: null, id_insumo: 201,
  factor_conversion_snapshot: '1000', cantidad_aprobada: '1.5', cantidad_base_aprobada: '1500', id_proveedor: 6,
  ...overrides
});

const body = (overrides = {}) => ({
  observacion_recepcion: null,
  factura: { nombre_original: 'factura.jpg', mime_type: 'image/jpeg', data_url: imageData() },
  detalles: [
    { id_solicitud_detalle: 10, cantidad_recibida: 2 },
    { id_solicitud_detalle: 11, cantidad_recibida: 1.5 }
  ],
  ...overrides
});

const fixture = (options = {}) => {
  const calls = [];
  let headerReads = 0;
  let evidenceReads = 0;
  const header = { id_solicitud_compra: 7, id_sucursal: 3, id_almacen: 4, estado: 'APROBADA', inventario_aplicado: false, fecha_inventario_aplicado: null, ...options.header };
  const details = options.details || [product(), supply()];
  const query = async (sqlRaw, params = []) => {
    const sql = String(sqlRaw).replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });
    if (options.failOn && sql.includes(options.failOn)) throw Object.assign(new Error('db failure'), { code: options.failCode });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('FROM public.solicitudes_compra WHERE') && !sql.includes('_detalle')) {
      headerReads += 1;
      const value = headerReads > 1 && options.txHeader ? { ...header, ...options.txHeader } : header;
      return { rows: value ? [value] : [], rowCount: value ? 1 : 0 };
    }
    if (sql.includes('FROM public.solicitudes_compra_detalle')) return { rows: details, rowCount: details.length };
    if (sql.includes('FROM public.solicitudes_compra_evidencias') && !sql.includes('INNER JOIN')) {
      evidenceReads += 1;
      const exists = options.existingEvidence || (options.txExistingEvidence && evidenceReads > 1);
      return { rows: exists ? [{ id_evidencia: 8 }] : [], rowCount: exists ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO public.archivos')) return { rows: [{ id_archivo: 358 }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO public.solicitudes_compra_evidencias')) return { rows: [{ id_evidencia: 9 }], rowCount: 1 };
    if (sql.startsWith('UPDATE public.solicitudes_compra_detalle')) return { rows: [], rowCount: options.detailUpdateRowCount ?? 1 };
    if (sql.startsWith('INSERT INTO public.movimientos_inventario')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('UPDATE public.solicitudes_compra')) return {
      rows: [{ id_solicitud_compra: 7, estado: 'RECIBIDA', id_usuario_recepcion: options.userId || 9, fecha_recepcion: '2026-07-21T12:00:00Z', inventario_aplicado: true }],
      rowCount: options.headerUpdateRowCount ?? 1
    };
    if (sql.includes('INNER JOIN public.archivos')) return { rows: options.evidenceRows || [], rowCount: (options.evidenceRows || []).length };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release: () => calls.push({ sql: 'RELEASE', params: [] }) };
  const db = { query, connect: async () => { if (options.connectError) throw new Error('connect failure'); return client; } };
  const storageCalls = [];
  const storage = {
    upload: async (...args) => { storageCalls.push(['upload', ...args]); if (options.uploadError) throw new Error('upload failed'); },
    remove: async (...args) => { storageCalls.push(['remove', ...args]); if (options.removeError) throw Object.assign(new Error('remove failed'), { code: 'CLEANUP' }); },
    createSignedUrl: async (...args) => { storageCalls.push(['signed', ...args]); if (options.signedError) throw new Error('sign failed'); return 'https://signed.invalid/temporary'; }
  };
  const role = options.role || 'ADMIN';
  const service = createSolicitudesCompraRecepcionService({
    db, storage,
    readAccess: async () => ({ idUsuario: options.userId || 9, roles: new Set([role]), isSuperAdmin: role === 'SUPER_ADMIN' }),
    resolveScope: async () => ({ userSucursalId: options.userSucursalId ?? 3, allowedSucursalIds: options.allowedSucursalIds ?? [options.userSucursalId ?? 3] }),
    resolveMaster: async (type, id) => options.masterInvalid ? ({ ok: false }) : ({ ok: true, masterId: id, master: { estado_global: true, tipo: type } }),
    getAssignment: async () => ({ activo: !options.assignmentInactive }),
    now: () => 1721563200000,
    uuid: () => '123e4567-e89b-12d3-a456-426614174000'
  });
  return { service, calls, storageCalls };
};

const req = (payload = body()) => ({ params: { id_solicitud_compra: '7' }, body: payload, query: {}, user: { id_usuario: 9 } });
const codeOf = async (promise) => { try { await promise; return null; } catch (error) { return { status: error.status, code: error.code, message: error.message }; } };

for (const role of ['CAJERO', 'COCINA', 'COCINERA', 'ADMIN', 'SUPER_ADMIN']) {
  test(`${role} recibe una solicitud permitida de su alcance`, async () => {
    const f = fixture({ role });
    const result = await f.service.receive(req());
    assert.equal(result.solicitud.estado, 'RECIBIDA');
    assert.equal(result.solicitud.total_movimientos, 2);
  });
}

test('operativo no puede recibir otra sucursal', async () => {
  const f = fixture({ role: 'CAJERO', userSucursalId: 2 });
  assert.deepEqual(await codeOf(f.service.receive(req())), { status: 403, code: 'FORBIDDEN', message: 'No tiene acceso a esta solicitud de compra.' });
  assert.equal(f.storageCalls.length, 0);
});

test('rol no permitido responde 403', async () => {
  assert.equal((await codeOf(fixture({ role: 'MESERO' }).service.receive(req()))).status, 403);
});

test('administrador queda limitado a su alcance administrativo actual', async () => {
  const f = fixture({ role: 'ADMIN', userSucursalId: 2, allowedSucursalIds: [2] });
  assert.equal((await codeOf(f.service.receive(req()))).status, 403);
});

test('solicitud inexistente responde 404', async () => {
  const f = fixture({ header: null });
  // La fixture combina objetos; se fuerza la lectura inexistente con una DB minima.
  f.service = createSolicitudesCompraRecepcionService({
    db: { query: async () => ({ rows: [], rowCount: 0 }) }, storage: {},
    readAccess: async () => ({ idUsuario: 1, roles: new Set(['ADMIN']) }), resolveScope: async () => ({})
  });
  assert.equal((await codeOf(f.service.receive(req()))).status, 404);
});

for (const state of ['PENDIENTE', 'RECHAZADA', 'RECIBIDA', 'CANCELADA']) {
  test(`solicitud ${state} no puede recibirse`, async () => {
    const error = await codeOf(fixture({ header: { estado: state } }).service.receive(req()));
    assert.deepEqual([error.status, error.code], [409, 'INVALID_STATE']);
  });
}

test('inventario aplicado bloquea recepcion', async () => {
  const error = await codeOf(fixture({ header: { inventario_aplicado: true } }).service.receive(req()));
  assert.deepEqual([error.status, error.code], [409, 'CONFLICT']);
});

test('fecha de inventario aplicada bloquea recepcion', async () => {
  assert.equal((await codeOf(fixture({ header: { fecha_inventario_aplicado: '2026-01-01' } }).service.receive(req()))).status, 409);
});

test('factura es obligatoria', async () => {
  assert.equal((await codeOf(fixture().service.receive(req(body({ factura: undefined }))))).status, 400);
});

for (const [mime, extension] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]) {
  test(`${mime} valido se sube con extension ${extension}`, async () => {
    const f = fixture();
    await f.service.receive(req(body({ factura: { nombre_original: 'foto.bad', mime_type: mime, data_url: imageData(mime) } })));
    assert.match(f.storageCalls[0][1], new RegExp(`\\.${extension}$`));
  });
}

test('PDF es rechazado', async () => {
  const invoice = { nombre_original: 'x.pdf', mime_type: 'application/pdf', data_url: imageData('application/pdf') };
  assert.deepEqual((await codeOf(fixture().service.receive(req(body({ factura: invoice }))))).code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('MIME falso es rechazado', async () => {
  const invoice = { nombre_original: 'x.jpg', mime_type: 'image/jpeg', data_url: imageData('image/png').replace('image/png', 'image/jpeg') };
  assert.equal((await codeOf(fixture().service.receive(req(body({ factura: invoice }))))).status, 415);
});

test('firma binaria invalida es rechazada', async () => {
  const invoice = { nombre_original: 'x.jpg', mime_type: 'image/jpeg', data_url: `data:image/jpeg;base64,${Buffer.from('hello').toString('base64')}` };
  assert.equal((await codeOf(fixture().service.receive(req(body({ factura: invoice }))))).status, 415);
});

test('base64 invalido es rechazado', async () => {
  const invoice = { nombre_original: 'x.jpg', mime_type: 'image/jpeg', data_url: 'data:image/jpeg;base64,@@@' };
  assert.equal((await codeOf(fixture().service.receive(req(body({ factura: invoice }))))).status, 400);
});

test('archivo mayor de 6 MB responde 413', async () => {
  const invoice = { nombre_original: 'x.jpg', mime_type: 'image/jpeg', data_url: imageData('image/jpeg', 6 * 1024 * 1024) };
  assert.deepEqual((await codeOf(fixture().service.receive(req(body({ factura: invoice }))))).code, 'FILE_TOO_LARGE');
});

test('nombre original se normaliza y ruta privada es determinista', async () => {
  const f = fixture();
  await f.service.receive(req(body({ factura: { nombre_original: '../../fáctúra<script>.jpg', mime_type: 'image/jpeg', data_url: imageData() } })));
  const fileInsert = f.calls.find((call) => call.sql.startsWith('INSERT INTO public.archivos'));
  assert.equal(fileInsert.params[0], 'facturascript.jpg');
  assert.equal(fileInsert.params[1], 'admin-docs/solicitudes-compra/7/factura-1721563200000-123e4567-e89b-12d3-a456-426614174000.jpg');
  assert.doesNotMatch(fileInsert.params[1], /jonnys-assets/);
});

test('lineas faltantes son rechazadas antes del upload', async () => {
  const f = fixture();
  assert.equal((await codeOf(f.service.receive(req(body({ detalles: [{ id_solicitud_detalle: 10, cantidad_recibida: 2 }] }))))).status, 400);
  assert.equal(f.storageCalls.length, 0);
});

test('lineas adicionales son rechazadas', async () => {
  const f = fixture();
  const detalles = [...body().detalles, { id_solicitud_detalle: 99, cantidad_recibida: 1 }];
  assert.equal((await codeOf(f.service.receive(req(body({ detalles }))))).status, 400);
});

test('IDs duplicados son rechazados', async () => {
  const detalles = [{ id_solicitud_detalle: 10, cantidad_recibida: 2 }, { id_solicitud_detalle: 10, cantidad_recibida: 2 }];
  assert.equal((await codeOf(fixture().service.receive(req(body({ detalles }))))).status, 400);
});

test('producto exige entero positivo', async () => {
  const detalles = [{ id_solicitud_detalle: 10, cantidad_recibida: 2.5 }, body().detalles[1]];
  assert.equal((await codeOf(fixture().service.receive(req(body({ detalles }))))).status, 400);
});

test('insumo acepta cuatro decimales y calcula base con snapshot', async () => {
  const f = fixture({ details: [product(), supply({ cantidad_aprobada: '1.2345', cantidad_base_aprobada: '1234.5' })] });
  const detalles = [body().detalles[0], { id_solicitud_detalle: 11, cantidad_recibida: '1.2345' }];
  await f.service.receive(req(body({ detalles })));
  const update = f.calls.filter((call) => call.sql.startsWith('UPDATE public.solicitudes_compra_detalle'))[1];
  assert.deepEqual(update.params.slice(2), ['1.2345', '1234.5']);
});

for (const invalid of [0, -1, null, '1.00001']) {
  test(`cantidad de insumo invalida ${String(invalid)} es rechazada`, async () => {
    const detalles = [body().detalles[0], { id_solicitud_detalle: 11, cantidad_recibida: invalid }];
    assert.equal((await codeOf(fixture().service.receive(req(body({ detalles }))))).status, 400);
  });
}

test('diferencia exige observacion antes del upload', async () => {
  const f = fixture();
  const detalles = [{ id_solicitud_detalle: 10, cantidad_recibida: 1 }, body().detalles[1]];
  assert.equal((await codeOf(f.service.receive(req(body({ detalles }))))).status, 400);
  assert.equal(f.storageCalls.length, 0);
});

test('diferencia menor o mayor es aceptada con observacion', async () => {
  for (const amount of [1, 3]) {
    const detalles = [{ id_solicitud_detalle: 10, cantidad_recibida: amount }, body().detalles[1]];
    const result = await fixture().service.receive(req(body({ detalles, observacion_recepcion: '  diferencia aceptada  ' })));
    assert.equal(result.ok, true);
  }
});

test('igualdad numerica 2, 2.0 y 2.0000 no exige observacion', async () => {
  for (const amount of [2, '2.0', '2.0000']) {
    const detalles = [{ id_solicitud_detalle: 10, cantidad_recibida: amount }, body().detalles[1]];
    assert.equal((await fixture().service.receive(req(body({ detalles })))).ok, true);
  }
});

test('proveedor debe estar asignado', async () => {
  assert.equal((await codeOf(fixture({ details: [product({ id_proveedor: null }), supply()] }).service.receive(req()))).status, 409);
});

test('proveedor inactivo posterior no se consulta ni bloquea', async () => {
  const f = fixture();
  await f.service.receive(req());
  assert.equal(f.calls.some((call) => /FROM public\.proveedores/.test(call.sql)), false);
});

test('maestro invalido y asignacion inactiva bloquean dentro de transaccion', async () => {
  for (const options of [{ masterInvalid: true }, { assignmentInactive: true }]) {
    const f = fixture(options);
    assert.equal((await codeOf(f.service.receive(req()))).status, 409);
    assert.ok(f.calls.some((call) => call.sql === 'ROLLBACK'));
    assert.equal(f.storageCalls.at(-1)[0], 'remove');
  }
});

test('crea exactamente un movimiento por detalle con cantidad base y referencias', async () => {
  const f = fixture();
  await f.service.receive(req());
  const moves = f.calls.filter((call) => call.sql.startsWith('INSERT INTO public.movimientos_inventario'));
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0].params.slice(0, 5), ['2', 4, 101, null, 7]);
  assert.deepEqual(moves[1].params.slice(0, 5), ['1500', 4, null, 201, 7]);
  assert.match(moves[0].sql, /'ENTRADA'.*'SOLICITUD_COMPRA'/);
});

test('encabezado queda RECIBIDA con usuario, fecha e inventario aplicado', async () => {
  const f = fixture();
  const result = await f.service.receive(req());
  assert.deepEqual([result.solicitud.estado, result.solicitud.id_usuario_recepcion, result.solicitud.inventario_aplicado], ['RECIBIDA', 9, true]);
  const update = f.calls.find((call) => call.sql.startsWith('UPDATE public.solicitudes_compra SET'));
  assert.match(update.sql, /fecha_recepcion = NOW\(\).*fecha_inventario_aplicado = NOW\(\)/);
  assert.match(update.sql, /estado = 'APROBADA' AND inventario_aplicado = false/);
});

test('registra archivo privado y una evidencia FACTURA', async () => {
  const f = fixture();
  const result = await f.service.receive(req());
  assert.deepEqual(result.evidencia, { id_evidencia: 9, id_archivo: 358, nombre_original: 'factura.jpg', tipo_archivo: 'image/jpeg' });
  assert.equal(f.calls.filter((call) => call.sql.startsWith('INSERT INTO public.archivos')).length, 1);
  assert.match(f.calls.find((call) => call.sql.startsWith('INSERT INTO public.solicitudes_compra_evidencias')).sql, /'FACTURA'/);
});

test('evidencia previa bloquea sin upload', async () => {
  const f = fixture({ existingEvidence: true });
  assert.equal((await codeOf(f.service.receive(req()))).status, 409);
  assert.equal(f.storageCalls.length, 0);
});

test('evidencia concurrente bloquea, revierte y compensa', async () => {
  const f = fixture({ txExistingEvidence: true });
  assert.equal((await codeOf(f.service.receive(req()))).status, 409);
  assert.ok(f.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(f.storageCalls.at(-1)[0], 'remove');
});

test('falla de upload responde STORAGE_ERROR sin abrir transaccion', async () => {
  const f = fixture({ uploadError: true });
  const error = await codeOf(f.service.receive(req()));
  assert.deepEqual([error.status, error.code], [502, 'STORAGE_ERROR']);
  assert.equal(f.calls.some((call) => call.sql === 'BEGIN'), false);
});

test('falla de movimiento ejecuta ROLLBACK sin COMMIT y compensa', async () => {
  const f = fixture({ failOn: 'INSERT INTO public.movimientos_inventario' });
  assert.equal((await codeOf(f.service.receive(req()))).status, 500);
  assert.ok(f.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(f.calls.some((call) => call.sql === 'COMMIT'), false);
  assert.equal(f.storageCalls.at(-1)[0], 'remove');
});

test('falla al adquirir conexion despues de upload tambien compensa', async () => {
  const f = fixture({ connectError: true });
  assert.equal((await codeOf(f.service.receive(req()))).status, 500);
  assert.equal(f.storageCalls.at(-1)[0], 'remove');
});

test('falla de compensacion conserva error principal sin ruta ni secreto', async () => {
  const f = fixture({ failOn: 'INSERT INTO public.archivos', removeError: true });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const error = await codeOf(f.service.receive(req()));
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(error.message, /admin-docs|service|key|token/i);
  } finally { console.warn = originalWarn; }
});

test('FOR UPDATE protege encabezado, detalles y evidencia', async () => {
  const f = fixture();
  await f.service.receive(req());
  const locked = f.calls.filter((call) => /FOR UPDATE/.test(call.sql));
  assert.equal(locked.length, 3);
});

test('endpoint de evidencias respeta sucursal', async () => {
  const f = fixture({ role: 'COCINA', userSucursalId: 99 });
  assert.equal((await codeOf(f.service.listEvidence(req()))).status, 403);
});

test('endpoint genera URL firmada de 300 segundos mediante mock', async () => {
  const evidenceRows = [{ id_evidencia: 9, tipo_evidencia: 'FACTURA', fecha_registro: '2026-01-01', id_usuario_registro: 9,
    nombre_original: 'factura.jpg', url_publica: 'admin-docs/solicitudes-compra/7/x.jpg', tipo_archivo: 'image/jpeg', tamano_bytes: 44, usuario_nombre: 'Ana' }];
  const f = fixture({ evidenceRows });
  const result = await f.service.listEvidence(req());
  assert.equal(result.evidencias[0].expira_en_segundos, 300);
  assert.equal(result.evidencias[0].url_firmada, 'https://signed.invalid/temporary');
  assert.deepEqual(f.storageCalls[0], ['signed', 'solicitudes-compra/7/x.jpg', 300]);
});

test('URL firmada no se persiste en DB ni se expone la ruta privada', async () => {
  const evidenceRows = [{ id_evidencia: 9, tipo_evidencia: 'FACTURA', fecha_registro: 'x', id_usuario_registro: 9,
    nombre_original: 'x.jpg', url_publica: 'admin-docs/solicitudes-compra/7/x.jpg', tipo_archivo: 'image/jpeg', tamano_bytes: 4, usuario_nombre: 'Ana' }];
  const f = fixture({ evidenceRows });
  const result = await f.service.listEvidence(req());
  assert.equal(JSON.stringify(f.calls).includes('https://signed.invalid'), false);
  assert.equal(Object.hasOwn(result.evidencias[0], 'url_publica'), false);
});

test('fallo de firma temporal responde STORAGE_ERROR', async () => {
  const evidenceRows = [{ id_evidencia: 9, tipo_evidencia: 'FACTURA', fecha_registro: 'x', id_usuario_registro: 9,
    nombre_original: 'x.jpg', url_publica: 'admin-docs/solicitudes-compra/7/x.jpg', tipo_archivo: 'image/jpeg', tamano_bytes: 4, usuario_nombre: 'Ana' }];
  const error = await codeOf(fixture({ evidenceRows, signedError: true }).service.listEvidence(req()));
  assert.deepEqual([error.status, error.code], [502, 'STORAGE_ERROR']);
});

test('listado usa EXISTS y detalle incluye datos de recepcion sin URL firmada', async () => {
  const source = await readFile(new URL('../services/solicitudesCompraService.js', import.meta.url), 'utf8');
  assert.match(source, /EXISTS\s*\([\s\S]*solicitudes_compra_evidencias/);
  for (const field of ['cantidad_base_recibida', 'fecha_inventario_aplicado', 'receptor', 'tiene_evidencia']) assert.match(source, new RegExp(field));
  assert.doesNotMatch(source, /createSignedUrl/);
});

test('rutas recibir y evidencias se declaran antes del GET dinamico', async () => {
  const source = await readFile(new URL('../routers/solicitudes_compra.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf("router.post('/:id_solicitud_compra/recibir'") < source.indexOf("router.get('/:id_solicitud_compra'"));
  assert.ok(source.indexOf("router.get('/:id_solicitud_compra/evidencias'") < source.indexOf("router.get('/:id_solicitud_compra'"));
  assert.match(source, /INVENTARIO_OC_RECEPCIONAR/);
  assert.match(source, /INVENTARIO_ORDENES_COMPRA_RECEPCIONAR/);
});

test('fuente no usa disco, bucket publico, credenciales ni project ID', async () => {
  const source = await readFile(new URL('../services/solicitudesCompraRecepcionService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fs\.|writeFile|UPLOADS_DIR|jonnys-assets|service_role|SUPABASE_URL|SUPABASE_KEY|project[_-]?id/i);
});

test('fuente no actualiza stock manual ni movimientos existentes', async () => {
  const source = await readFile(new URL('../services/solicitudesCompraRecepcionService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+public\.(productos_almacenes|insumos_almacenes|movimientos_inventario)/i);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+public\.movimientos_inventario/i);
  assert.doesNotMatch(source, /(productos|insumos)\.id_almacen/);
});

test('payload rechaza campos internos y financieros inesperados', async () => {
  for (const key of ['id_sucursal', 'id_almacen', 'id_usuario_recepcion', 'inventario_aplicado', 'precio', 'total', 'bucket', 'id_archivo']) {
    const error = await codeOf(fixture().service.receive(req({ ...body(), [key]: 1 })));
    assert.equal(error.status, 400, key);
  }
});

test('detalle rechaza cantidad_base_recibida e identificadores maestros enviados por cliente', async () => {
  for (const key of ['cantidad_base_recibida', 'id_producto', 'id_insumo', 'id_proveedor']) {
    const detalles = [{ ...body().detalles[0], [key]: 1 }, body().detalles[1]];
    assert.equal((await codeOf(fixture().service.receive(req(body({ detalles }))))).status, 400, key);
  }
});
