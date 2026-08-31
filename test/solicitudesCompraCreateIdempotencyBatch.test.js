import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSolicitudesCompraService } from '../services/solicitudesCompraService.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const access = async () => ({ idUsuario: 7, isSuperAdmin: false, roles: new Set(['CAJERO']) });
const scope = async () => ({ userSucursalId: 3 });

const makeRuntime = ({ replay = false, reused = false, legacyExisting = false, failDetail = false } = {}) => {
  const calls = [];
  let releases = 0;
  let reservedFingerprint = null;
  const client = { release: () => { releases += 1; }, query: async (sql, params = []) => {
    const text = String(sql).trim(); calls.push({ text, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [], rowCount: 0 };
    if (text.includes('FROM public.almacenes a')) return { rows: [{ id_almacen: 11, id_sucursal: 3, nombre_almacen: 'Bodega', nombre_sucursal: 'Centro', estado: true }], rowCount: 1 };
    if (text.includes('ON CONFLICT (client_request_id)')) {
      reservedFingerprint = params[5];
      return replay || reused ? { rows: [], rowCount: 0 }
        : { rows: [{ id_solicitud_compra: 500, estado: 'PENDIENTE', fecha_creacion: '2026-08-30T12:00:00Z' }], rowCount: 1 };
    }
    if (text.includes('WHERE sc.client_request_id')) return { rows: [{ id_solicitud_compra: 500,
      id_usuario_solicitante: reused ? 99 : 7, id_almacen: 11,
      request_fingerprint: reused ? '0'.repeat(64) : reservedFingerprint,
      estado: 'APROBADA', fecha_creacion: '2026-08-30T12:00:00Z', total_lineas: 55 }], rowCount: 1 };
    if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (text.includes("INTERVAL '5 minutes'")) return legacyExisting
      ? { rows: [{ id_solicitud_compra: 499, estado: 'PENDIENTE', fecha_creacion: '2026-08-30T11:59:50Z', total_lineas: 55 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
    if (text.startsWith('WITH inputs')) return { rows: params[0].map((id) => ({ input_id: id, master_ids: [], master_id: id,
      found_id: id, nombre: `Item ${id}`, estado_global: true })), rowCount: params[0].length };
    if (text.includes("SELECT 'producto'::text AS tipo")) return { rows: [
      ...params[1].map((id) => ({ tipo: 'producto', master_id: id, id_almacen: 11, activo: true, id_sucursal: 3 })),
      ...params[2].map((id) => ({ tipo: 'insumo', master_id: id, id_almacen: 11, activo: true, id_sucursal: 3 }))
    ], rowCount: params[1].length + params[2].length };
    if (text.startsWith('WITH requested')) {
      const requested = JSON.parse(params[0]);
      return { rows: requested.map(({ master_id, presentation_id }) => ({ master_id, presentation_id,
        id_unidad_base_insumo: 5, id_unidad_base_valida: 5, nombre_unidad_base: 'Gramo',
        ...(presentation_id ? { id_presentacion: presentation_id, presentation_insumo_id: master_id,
          id_unidad_base: 5, nombre_presentacion: 'Bolsa', cantidad_presentacion: '1', cantidad_base: '10',
          factor_conversion: '10', presentation_active: true, uso_compra: true } : {}) })), rowCount: requested.length };
    }
    if (text.includes('INSERT INTO public.solicitudes_compra (')) return { rows: [{ id_solicitud_compra: 500, estado: 'PENDIENTE', fecha_creacion: '2026-08-30T12:00:00Z' }], rowCount: 1 };
    if (text.includes('INSERT INTO public.solicitudes_compra_detalle')) {
      if (failDetail) throw Object.assign(new Error('fk'), { code: '23503' });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Consulta inesperada: ${text.slice(0, 80)}`);
  } };
  const db = { connect: async () => client };
  const service = createSolicitudesCompraService({ db, readAccess: access, resolveScope: scope,
    resolveOperativeWarehouse: async () => 11, getPoolState: () => ({ totalCount: 1, idleCount: 0, waitingCount: 0 }) });
  return { service, calls, get releases() { return releases; } };
};

const payload = (count = 1, withUuid = true) => ({ id_almacen: 11, ...(withUuid ? { client_request_id: UUID } : {}),
  observacion: ' Reposición   semanal ', detalles: Array.from({ length: count }, (_, index) => index < 4
    ? { tipo_item: 'producto', id_item: 100 + index, cantidad: 1 }
    : { tipo_item: 'insumo', id_item: 200 + index, cantidad: '1.250000' }) });

test('create batch usa UUID v4, fingerprint backend y un INSERT detalle para 55 lineas', async () => {
  const runtime = makeRuntime();
  const result = await runtime.service.create({ body: payload(55) });
  assert.equal(result.id_solicitud_compra, 500);
  assert.equal(result.idempotent_replay, false);
  assert.equal(runtime.calls.filter((call) => call.text.includes('INSERT INTO public.solicitudes_compra_detalle')).length, 1);
  assert.equal(runtime.releases, 1);
  assert.equal(result.query_count, 9);
});

test('query count no crece por articulo: 1 linea=7 y 55 lineas=9', async () => {
  const one = makeRuntime(); const many = makeRuntime();
  const oneResult = await one.service.create({ body: payload(1) });
  const manyResult = await many.service.create({ body: payload(55) });
  assert.equal(oneResult.query_count, 7);
  assert.equal(manyResult.query_count, 9);
});

test('replay devuelve la misma OC y no inserta detalles', async () => {
  const runtime = makeRuntime({ replay: true });
  const result = await runtime.service.create({ body: payload(55) });
  assert.equal(result.id_solicitud_compra, 500);
  assert.equal(result.idempotent_replay, true);
  assert.equal(result.estado, 'APROBADA');
  assert.equal(runtime.calls.filter((call) => call.text.includes('INSERT INTO public.solicitudes_compra_detalle')).length, 0);
  assert.equal(runtime.releases, 1);
});

test('key reutilizada por otro usuario responde 409 sin filtrar datos y release una vez', async () => {
  const runtime = makeRuntime({ reused: true });
  await assert.rejects(runtime.service.create({ body: payload(1) }), (error) => error.status === 409
    && error.code === 'IDEMPOTENCY_KEY_REUSED' && error.message === 'El identificador de envío ya fue utilizado para otra solicitud.');
  assert.equal(runtime.releases, 1);
});

test('legacy dedupe bajo advisory lock retorna existente sin nuevo header', async () => {
  const runtime = makeRuntime({ legacyExisting: true });
  const result = await runtime.service.create({ body: payload(55, false) });
  assert.equal(result.legacy_deduplicated, true);
  assert.equal(runtime.calls.filter((call) => call.text.includes('INSERT INTO public.solicitudes_compra (')).length, 0);
  assert.equal(runtime.releases, 1);
});

test('rollback de detalle libera cliente una vez y no hace commit', async () => {
  const runtime = makeRuntime({ failDetail: true });
  await assert.rejects(runtime.service.create({ body: payload(1) }), (error) => error.status === 400);
  assert.equal(runtime.calls.filter((call) => call.text === 'ROLLBACK').length, 1);
  assert.equal(runtime.calls.filter((call) => call.text === 'COMMIT').length, 0);
  assert.equal(runtime.releases, 1);
});

test('pool.connect fallido mapea 503 DATABASE_BUSY sin release', async () => {
  const service = createSolicitudesCompraService({ db: { connect: async () => { throw new Error('timeout'); } },
    getPoolState: () => ({ totalCount: 5, idleCount: 0, waitingCount: 2 }) });
  await assert.rejects(service.create({ body: payload(1) }), (error) => error.status === 503 && error.code === 'DATABASE_BUSY');
});

test('reconciliacion no revela key ajena', async () => {
  const db = { query: async (sql) => sql.includes('client_request_id')
    ? { rows: [{ id_solicitud_compra: 500, id_usuario_solicitante: 99, estado: 'APROBADA', total_lineas: 55 }], rowCount: 1 }
    : { rows: [], rowCount: 0 } };
  const service = createSolicitudesCompraService({ db, readAccess: access, resolveScope: scope, resolveOperativeWarehouse: async () => 11 });
  assert.deepEqual(await service.getByClientRequestId({ params: { client_request_id: UUID } }), { ok: true, found: false });
});

test('reconciliacion propia devuelve estado actual y total; inexistente devuelve found false', async () => {
  let rows = [{ id_solicitud_compra: 500, id_usuario_solicitante: 7, estado: 'RECIBIDA',
    fecha_creacion: '2026-08-30T12:00:00Z', total_lineas: 55 }];
  const db = { query: async () => ({ rows, rowCount: rows.length }) };
  const service = createSolicitudesCompraService({ db, readAccess: access, resolveScope: scope, resolveOperativeWarehouse: async () => 11 });
  const found = await service.getByClientRequestId({ params: { client_request_id: UUID } });
  assert.deepEqual(found.solicitud, { id_solicitud_compra: 500, estado: 'RECIBIDA', fecha_creacion: '2026-08-30T12:00:00Z', total_lineas: 55 });
  rows = [];
  assert.deepEqual(await service.getByClientRequestId({ params: { client_request_id: UUID } }), { ok: true, found: false });
});

test('UUID invalido se rechaza antes de conectar', async () => {
  let connects = 0;
  const service = createSolicitudesCompraService({ db: { connect: async () => { connects += 1; } } });
  await assert.rejects(service.create({ body: { ...payload(1), client_request_id: 'no-es-uuid' } }),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR');
  assert.equal(connects, 0);
});

test('SQL es aditivo, transaccional, nullable y no modifica historicos', async () => {
  const sql = await readFile(new URL('../docs/sql/2026-08-30-oc-create-idempotency.sql', import.meta.url), 'utf8');
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS client_request_id uuid NULL/);
  assert.match(sql, /request_fingerprint varchar\(64\) NULL/);
  assert.match(sql, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*client_request_id/);
  assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE|DROP|UPDATE)\b/i);
  assert.match(sql, /COMMIT;\s*$/);
});

test('endpoint envios queda antes de la ruta dinamica', async () => {
  const router = await readFile(new URL('../routers/solicitudes_compra.js', import.meta.url), 'utf8');
  assert.ok(router.indexOf("router.get('/envios/:client_request_id'") < router.indexOf("router.get('/:id_solicitud_compra'"));
});
