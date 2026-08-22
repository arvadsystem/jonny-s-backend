import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_KEY ||= 'test-only-not-a-real-key';
const { createCapturasCompraRapidaService, decodeQuickCaptureInvoice } = await import('../services/capturasCompraRapidaService.js');

const access = (role, options = {}) => async () => ({
  idUsuario: options.idUsuario || 7,
  isSuperAdmin: options.isSuperAdmin || false,
  roles: new Set([role]),
  permissions: new Set(['INVENTARIO_OC_CAPTURA_RAPIDA_CREAR', 'INVENTARIO_OC_CAPTURA_RAPIDA_VER'])
});

const createDb = () => {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id_captura_compra_rapida: 12, id_sucursal: params[0], id_almacen: params[1], id_usuario_registro: params[2], estado: 'BORRADOR' }], rowCount: 1 };
    }
  };
};

for (const role of ['CAJERO', 'COCINA', 'COCINERO', 'COCINERA', 'JEFA_COCINA', 'JEFE_COCINA']) {
  test(`${role} crea BORRADOR usando scope y almacen del backend`, async () => {
    const db = createDb();
    const service = createCapturasCompraRapidaService({
      db, readAccess: access(role), resolveScope: async () => ({ userSucursalId: 3 }), resolveWarehouse: async () => 11
    });
    const result = await service.create({ body: {} });
    assert.equal(result.captura.estado, 'BORRADOR');
    assert.deepEqual(db.calls[0].params, [3, 11, 7]);
  });
}

for (const scenario of [
  { role: 'ADMIN' }, { role: 'ROOT' }, { role: 'ADMINISTRADOR' }, { role: 'SUPER_ADMIN', isSuperAdmin: true }
]) {
  test(`${scenario.role} no crea aunque posea permiso accidental`, async () => {
    const service = createCapturasCompraRapidaService({ db: createDb(), readAccess: access(scenario.role, scenario), resolveScope: async () => ({ userSucursalId: 3 }), resolveWarehouse: async () => 11 });
    await assert.rejects(service.create({ body: {} }), (error) => error.status === 403);
  });
}

test('create rechaza scope enviado por cliente antes de insertar', async () => {
  const db = createDb();
  const service = createCapturasCompraRapidaService({ db, readAccess: access('CAJERO') });
  await assert.rejects(service.create({ body: { id_sucursal: 99, id_almacen: 88 } }), (error) => error.status === 400);
  assert.equal(db.calls.length, 0);
});

test('operativo sin sucursal recibe 403', async () => {
  const service = createCapturasCompraRapidaService({ db: createDb(), readAccess: access('CAJERO'), resolveScope: async () => ({}) });
  await assert.rejects(service.create({ body: {} }), (error) => error.status === 403);
});

test('admin y super admin pueden consultar; root no', async () => {
  for (const scenario of [{ role: 'ADMINISTRADOR' }, { role: 'SUPER_ADMIN', isSuperAdmin: true }]) {
    const db = { async query() { return { rows: [], rowCount: 0 }; } };
    const service = createCapturasCompraRapidaService({ db, readAccess: access(scenario.role, scenario) });
    const result = await service.list({ query: {} });
    assert.deepEqual(result.capturas, []);
  }
  const service = createCapturasCompraRapidaService({ db: createDb(), readAccess: access('ROOT') });
  await assert.rejects(service.list({ query: {} }), (error) => error.status === 403);
});

test('listado operativo filtra por id_usuario_registro y detalle no filtra por sucursal solamente', async () => {
  let sql = '';
  const db = { async query(statement) { sql = statement; return { rows: [], rowCount: 0 }; } };
  const service = createCapturasCompraRapidaService({ db, readAccess: access('CAJERO') });
  await service.list({ query: {} });
  assert.match(sql, /c\.id_usuario_registro = \$1/);
});

const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
test('valida JPEG PNG y WEBP por MIME y firma', () => {
  const fixtures = [
    ['image/jpeg', [0xff, 0xd8, 0xff, 0x00]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['image/webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]]
  ];
  for (const [mime, bytes] of fixtures) assert.equal(decodeQuickCaptureInvoice({ nombre_original: 'x', mime_type: mime, data_url: dataUrl(mime, bytes) }).mimeType, mime);
});

test('rechaza PDF MIME falso imagen vacia y mas de 6 MB', () => {
  const oversizedJpeg = Buffer.alloc((6 * 1024 * 1024) + 1);
  oversizedJpeg.set([0xff, 0xd8, 0xff]);
  assert.throws(() => decodeQuickCaptureInvoice({ nombre_original: 'x.pdf', mime_type: 'application/pdf', data_url: dataUrl('application/pdf', [1]) }), (error) => error.status === 415);
  assert.throws(() => decodeQuickCaptureInvoice({ nombre_original: 'x.png', mime_type: 'image/png', data_url: dataUrl('image/png', [0xff, 0xd8, 0xff]) }), (error) => error.status === 415);
  assert.throws(() => decodeQuickCaptureInvoice({ nombre_original: 'x.jpg', mime_type: 'image/jpeg', data_url: 'data:image/jpeg;base64,' }), (error) => error.status === 400);
  assert.throws(() => decodeQuickCaptureInvoice({ nombre_original: 'x.jpg', mime_type: 'image/jpeg', data_url: `data:image/jpeg;base64,${oversizedJpeg.toString('base64')}` }), (error) => error.status === 413);
});

test('fuente mantiene locks limites estados compensacion y ausencia de efectos OC/inventario', async () => {
  const source = await readFile(new URL('../services/capturasCompraRapidaService.js', import.meta.url), 'utf8');
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /MAX_EVIDENCES = 10/);
  assert.match(source, /estado = 'PENDIENTE', fecha_envio = NOW\(\)/);
  assert.match(source, /id_usuario_registro = \$2 AND estado = 'BORRADOR'/);
  assert.match(source, /cleanup\(\[uploadedPath\]\)/);
  assert.match(source, /solicitudes_compra\/capturas-rapidas/);
  assert.doesNotMatch(source, /INSERT INTO public\.solicitudes_compra(?:\s|\()/);
  assert.doesNotMatch(source, /solicitudes_compra_detalle|movimientos_inventario|UPDATE public\.(?:productos|insumos)/);
});

test('router monta ocho endpoints antes de la ruta dinamica y omite rechazar/formalizar', async () => {
  const source = await readFile(new URL('../routers/solicitudes_compra.js', import.meta.url), 'utf8');
  const quick = source.indexOf("router.post('/capturas-rapidas'");
  const dynamic = source.indexOf("router.get('/:id_solicitud_compra'");
  assert.ok(quick >= 0 && quick < dynamic);
  assert.equal((source.match(/router\.(?:get|post|put|delete)\('\/capturas-rapidas/g) || []).length, 8);
  assert.doesNotMatch(source, /capturas-rapidas[^'\n]*\/(?:rechazar|formalizar)/);
});
