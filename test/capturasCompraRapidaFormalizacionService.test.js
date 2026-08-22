import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCapturasCompraRapidaFormalizacionService } from '../services/capturasCompraRapidaFormalizacionService.js';

const request = (role = 'ADMINISTRADOR', body = { detalles: [{ tipo_item: 'producto', id_item: 8, cantidad: 2, id_proveedor: 5 }] }) => ({ params: { id_captura: '35' }, body, user: { role } });
const access = async (req) => ({ idUsuario: 7, roles: new Set([req.user.role]), isSuperAdmin: req.user.role === 'SUPER_ADMIN' });

const fixture = ({ captureState = 'PENDIENTE', requestId = 120, failMovement = false } = {}) => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim(); calls.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('capturas_compra_rapida_evidencias')) return { rows: [{ id_archivo: 40, id_usuario_registro: 11 }, { id_archivo: 41, id_usuario_registro: 11 }] };
      if (text.includes('FROM public.capturas_compra_rapida') && text.includes('FOR UPDATE')) return { rows: [{ id_captura_compra_rapida: 35, id_sucursal: 2, id_almacen: 3, id_usuario_registro: 11, estado: captureState, fecha_envio: '2026-08-22T10:00:00Z', id_solicitud_compra: null }] };
      if (text.includes('FROM public.almacenes')) return { rows: [{ id_almacen: 3, id_sucursal: 2 }] };
      if (text.startsWith('SELECT id_proveedor')) return { rows: [{ id_proveedor: 5 }] };
      if (text.startsWith('INSERT INTO public.solicitudes_compra ')) return { rows: [{ id_solicitud_compra: requestId }], rowCount: 1 };
      if (text.startsWith('INSERT INTO public.movimientos_inventario')) { if (failMovement) throw new Error('movement failed'); return { rows: [], rowCount: 1 }; }
      if (text.startsWith('UPDATE public.capturas_compra_rapida')) return { rows: [{ id_captura_compra_rapida: 35, estado: 'FORMALIZADA', id_solicitud_compra: requestId, id_usuario_gestion: 7 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ text: 'RELEASE', params: [] }); }
  };
  return { calls, db: { connect: async () => client }, client };
};

const serviceFor = (state) => createCapturasCompraRapidaFormalizacionService({
  db: state.db,
  readAccess: access,
  resolveMaster: async (type, id) => ({ ok: true, masterId: id, master: { estado_global: true } }),
  getAssignment: async () => ({ activo: true, id_sucursal: 2 }),
  loadSnapshot: async () => ({ id_presentacion_insumo: 99, id_unidad_base: 4, nombre_presentacion_snapshot: 'Fardo', factor_conversion_snapshot: '200' })
});

test('ADMINISTRADOR y SUPER_ADMIN formalizan; ROOT ADMIN CAJERO y COCINA quedan rechazados dentro de transaccion', async () => {
  for (const role of ['ADMINISTRADOR', 'SUPER_ADMIN']) {
    const state = fixture(); const result = await serviceFor(state).formalize(request(role)); assert.equal(result.solicitud.estado, 'RECIBIDA');
  }
  for (const role of ['ROOT', 'ADMIN', 'CAJERO', 'COCINA']) {
    const state = fixture(); await assert.rejects(serviceFor(state).formalize(request(role)), (error) => error.status === 403); assert.ok(state.calls.some((call) => call.text === 'ROLLBACK'));
  }
});

test('estado distinto de PENDIENTE produce 409 bajo FOR UPDATE y rollback', async () => {
  for (const captureState of ['BORRADOR', 'RECHAZADA', 'FORMALIZADA']) {
    const state = fixture({ captureState }); await assert.rejects(serviceFor(state).formalize(request()), (error) => error.status === 409 && error.code === 'INVALID_STATE');
    assert.match(state.calls.find((call) => call.text.includes('FROM public.capturas_compra_rapida')).text, /FOR UPDATE/);
    assert.ok(state.calls.some((call) => call.text === 'ROLLBACK'));
  }
});

test('payload estricto rechaza decimales de producto, precision excesiva, proveedor ausente, extra y duplicados', async () => {
  const invalid = [
    [{ tipo_item: 'producto', id_item: 1, cantidad: '1.5', id_proveedor: 5 }],
    [{ tipo_item: 'insumo', id_item: 1, cantidad: '1.1234567', id_proveedor: 5 }],
    [{ tipo_item: 'producto', id_item: 1, cantidad: 1 }],
    [{ tipo_item: 'producto', id_item: 1, cantidad: 1, id_proveedor: 5, estado: 'RECIBIDA' }]
  ];
  for (const detalles of invalid) await assert.rejects(serviceFor(fixture()).formalize(request('ADMINISTRADOR', { detalles })), (error) => error.status === 400);
  const duplicateState = fixture();
  await assert.rejects(serviceFor(duplicateState).formalize(request('ADMINISTRADOR', { detalles: [{ tipo_item: 'producto', id_item: 1, cantidad: 1, id_proveedor: 5 }, { tipo_item: 'producto', id_item: 1, cantidad: 2, id_proveedor: 5 }] })), (error) => error.status === 400);
});

test('crea OC RECIBIDA, detalles coherentes, reutiliza evidencias y crea un movimiento por linea', async () => {
  const state = fixture();
  const body = { detalles: [{ tipo_item: 'producto', id_item: 8, cantidad: 2, id_proveedor: 5 }, { tipo_item: 'insumo', id_item: 9, id_presentacion_insumo: 99, cantidad: '1.500001', id_proveedor: 5 }] };
  const result = await serviceFor(state).formalize(request('ADMINISTRADOR', body));
  assert.deepEqual(result.solicitud, { id_solicitud_compra: 120, estado: 'RECIBIDA', inventario_aplicado: true, total_lineas: 2, total_movimientos: 2, total_evidencias: 2 });
  assert.equal(state.calls.filter((call) => call.text.startsWith('INSERT INTO public.solicitudes_compra_detalle')).length, 2);
  assert.equal(state.calls.filter((call) => call.text.startsWith('INSERT INTO public.solicitudes_compra_evidencias')).length, 2);
  assert.equal(state.calls.filter((call) => call.text.startsWith('INSERT INTO public.movimientos_inventario')).length, 2);
  const supplyDetail = state.calls.filter((call) => call.text.startsWith('INSERT INTO public.solicitudes_compra_detalle'))[1];
  assert.equal(supplyDetail.params[10], '300.0002');
  assert.equal(state.calls.at(-2).text, 'COMMIT');
});

test('fallo de movimiento revierte toda la operacion y nunca confirma captura', async () => {
  const state = fixture({ failMovement: true });
  await assert.rejects(serviceFor(state).formalize(request()), (error) => error.status === 500);
  assert.ok(state.calls.some((call) => call.text === 'ROLLBACK'));
  assert.ok(!state.calls.some((call) => call.text.startsWith('UPDATE public.capturas_compra_rapida')));
  assert.ok(!state.calls.some((call) => call.text === 'COMMIT'));
});

test('contrato no sube Storage no inserta archivos no actualiza stock manual y expone trazabilidad', async () => {
  const source = await readFile(new URL('../services/capturasCompraRapidaFormalizacionService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /storage\.(?:upload|remove)|INSERT INTO public\.archivos/);
  assert.doesNotMatch(source, /UPDATE (?:public\.)?(?:productos|productos_almacenes|insumos|insumos_almacenes)\s+SET/i);
  assert.match(source, /ref_origen, id_ref/);
  assert.match(source, /motivo_rechazo = NULL, id_solicitud_compra = \$3/);
});
