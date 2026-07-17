import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolvePrintJobAdministratively } from '../services/printQueueAdminService.js';

const createDb = ({ current, updated, failEvent = false }) => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id_trabajo')) return { rows: current ? [current] : [] };
      if (sql.includes('UPDATE public.trabajos_impresion')) return { rows: [updated] };
      if (sql.includes('INSERT INTO public.trabajos_impresion_eventos') && failEvent) throw new Error('audit event failed');
      return { rows: [] };
    },
    release: () => calls.push({ sql: 'RELEASE' })
  };
  return { db: { connect: async () => client }, calls };
};

const current = {
  id_trabajo: 41,
  id_sucursal: 7,
  estado: 'confirmacion_pendiente',
  intentos: 2,
  max_intentos: 5,
  id_agente_tomado: '11111111-1111-1111-1111-111111111111',
  lease_active: false
};

test('resolucion administrativa como impreso finaliza y audita usuario/motivo', async () => {
  const fixture = createDb({ current, updated: { id_trabajo: 41, id_sucursal: 7, estado: 'impreso', finalizado_at: new Date().toISOString() } });
  const result = await resolvePrintJobAdministratively({
    idSucursal: 7, jobId: 41, userId: 91, resolution: 'printed', reason: 'Papel confirmado fisicamente', db: fixture.db
  });
  assert.equal(result.estado, 'impreso');
  const update = fixture.calls.find((call) => call.sql.includes('UPDATE public.trabajos_impresion'));
  assert.equal(update.params[2], 'impreso');
  assert.equal(update.params[3], false);
  const event = fixture.calls.find((call) => call.sql.includes('INSERT INTO public.trabajos_impresion_eventos'));
  assert.equal(event.params[3], 91);
  assert.equal(event.params[4], 'manual_mark_printed');
  assert.match(event.params[7], /Papel confirmado fisicamente/);
  assert.ok(fixture.calls.some((call) => call.sql === 'COMMIT'));
});

test('resolucion administrativa como no impreso reencola de forma explicita', async () => {
  const fixture = createDb({ current, updated: { id_trabajo: 41, id_sucursal: 7, estado: 'pendiente', max_intentos: 5 } });
  const result = await resolvePrintJobAdministratively({
    idSucursal: 7, jobId: 41, userId: 91, resolution: 'not_printed', reason: 'Impresora revisada sin salida fisica', db: fixture.db
  });
  assert.equal(result.estado, 'pendiente');
  const update = fixture.calls.find((call) => call.sql.includes('UPDATE public.trabajos_impresion'));
  assert.equal(update.params[3], true);
  assert.match(update.sql, /lease_expires_at=NULL/);
  assert.match(update.sql, /id_agente_tomado=CASE WHEN \$4 THEN NULL/);
  const event = fixture.calls.find((call) => call.sql.includes('INSERT INTO public.trabajos_impresion_eventos'));
  assert.equal(event.params[4], 'manual_requeue_not_printed');
});

test('resolucion respeta sucursal y hace rollback ante fallo de auditoria', async () => {
  const wrongBranch = createDb({ current: null, updated: null });
  await assert.rejects(
    () => resolvePrintJobAdministratively({ idSucursal: 8, jobId: 41, userId: 91, resolution: 'printed', reason: 'Confirmacion fisica completa', db: wrongBranch.db }),
    (error) => error.code === 'PRINT_RESOLUTION_STATE_CONFLICT'
  );
  assert.ok(!wrongBranch.calls.some((call) => call.sql.includes('UPDATE public.trabajos_impresion')));

  const eventFailure = createDb({ current, updated: { id_trabajo: 41, estado: 'impreso' }, failEvent: true });
  await assert.rejects(
    () => resolvePrintJobAdministratively({ idSucursal: 7, jobId: 41, userId: 91, resolution: 'printed', reason: 'Confirmacion fisica completa', db: eventFailure.db }),
    /audit event failed/
  );
  assert.ok(eventFailure.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!eventFailure.calls.some((call) => call.sql === 'COMMIT'));
});

test('rutas administrativas permanecen despues de auth, sesion, CSRF y auditoria global', () => {
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const printingMount = app.indexOf('app.use(printingRoutes)');
  for (const middleware of ['app.use(authRequired)', 'app.use(requireActiveSession)', 'app.use(csrfProtect)', 'app.use(globalAuditMiddleware)']) {
    assert.ok(app.indexOf(middleware) >= 0 && app.indexOf(middleware) < printingMount, `${middleware} debe ejecutarse antes de printingRoutes`);
  }
  const router = fs.readFileSync(new URL('../routers/printing.js', import.meta.url), 'utf8');
  assert.match(router, /checkPermission\(\['VENTAS_IMPRIMIR'\]\)/);
  assert.match(router, /ADMIN_ROLE_CODES[\s\S]*ADMINISTRADOR[\s\S]*SUPER_ADMIN/);
  assert.match(router, /resolveAllowedSucursal/);
});
