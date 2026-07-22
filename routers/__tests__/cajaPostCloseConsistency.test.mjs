import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { validateCajaCloseEditObservation } from '../../services/cajaCloseEditValidationService.js';

const routerSource = readFileSync(resolve('routers/cajas.js'), 'utf8');
const smokeSource = readFileSync(resolve('scripts/qa-caja-negative-close-smoke.mjs'), 'utf8');

const routeSlice = (startMarker, endMarker) => {
  const start = routerSource.indexOf(startMarker);
  const end = routerSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `No se encontro la ruta entre ${startMarker} y ${endMarker}`);
  return routerSource.slice(start, end);
};

describe('consistencia financiera posterior al cierre', () => {
  it('la edicion generica bloquea campos financieros segmentados y solo persiste observacion con auditoria', () => {
    const route = routeSlice(
      "router.patch('/ventas/cajas/cierres/:id'",
      "router.get('/ventas/cajas/reportes/resumen'"
    );

    assert.match(route, /cajas_cierres_arqueos_metodos/);
    assert.match(route, /tiene_detalle_segmentado/);
    assert.match(route, /monto_declarado_cierre/);
    assert.match(route, /id_arqueo_final/);
    assert.match(route, /id_resolucion_cierre_caja/);
    assert.match(route, /VENTAS_CAJAS_CLOSE_SEGMENTED_EDIT_REQUIRES_REVALIDATION/);
    assert.match(route, /VENTAS_CAJAS_CLOSE_FINANCIAL_EDIT_NOT_ALLOWED/);
    assert.match(route, /SET observacion = \$1/);
    assert.match(route, /SET observacion_cierre = \$1/);
    assert.match(route, /INSERT INTO public\.cajas_cierres_auditoria/);
    assert.doesNotMatch(route, /loadCajaCloseFinancialSnapshot/);
    assert.doesNotMatch(route, /SET id_resolucion_cierre_caja = \$1,[\s\S]*monto_declarado_cierre/);
  });

  it('exige observacion_cierre presente y no vacia antes de abrir conexion o escribir auditoria', () => {
    const route = routeSlice(
      "router.patch('/ventas/cajas/cierres/:id'",
      "router.get('/ventas/cajas/reportes/resumen'"
    );
    const validationIndex = route.indexOf('validateCajaCloseEditObservation(req.body)');
    const connectIndex = route.indexOf('pool.connect()');
    const updateIndex = route.indexOf('UPDATE public.cajas_cierres');
    const auditIndex = route.indexOf('INSERT INTO public.cajas_cierres_auditoria');

    assert.ok(validationIndex > 0);
    assert.ok(connectIndex > validationIndex);
    assert.ok(updateIndex > connectIndex);
    assert.ok(auditIndex > updateIndex);
    assert.match(route, /VENTAS_CAJAS_CLOSE_EDIT_OBSERVATION_REQUIRED/);

    const persisted = {
      closeObservation: 'Observacion anterior',
      sessionObservation: 'Observacion anterior',
      audits: []
    };
    const executeEdit = (body) => {
      const validation = validateCajaCloseEditObservation(body);
      if (!validation.valid) {
        return { status: 400, code: 'VENTAS_CAJAS_CLOSE_EDIT_OBSERVATION_REQUIRED' };
      }
      persisted.closeObservation = validation.observation;
      persisted.sessionObservation = validation.observation;
      persisted.audits.push({ observation: validation.observation });
      return { status: 200 };
    };

    const missing = executeEdit({ motivo_edicion: 'Correccion administrativa' });
    assert.deepEqual(missing, { status: 400, code: 'VENTAS_CAJAS_CLOSE_EDIT_OBSERVATION_REQUIRED' });
    assert.equal(persisted.closeObservation, 'Observacion anterior');
    assert.equal(persisted.sessionObservation, 'Observacion anterior');
    assert.equal(persisted.audits.length, 0);

    const empty = executeEdit({ motivo_edicion: 'Correccion administrativa', observacion_cierre: '   ' });
    assert.deepEqual(empty, { status: 400, code: 'VENTAS_CAJAS_CLOSE_EDIT_OBSERVATION_REQUIRED' });
    assert.equal(persisted.closeObservation, 'Observacion anterior');
    assert.equal(persisted.sessionObservation, 'Observacion anterior');
    assert.equal(persisted.audits.length, 0);

    const valid = executeEdit({ motivo_edicion: 'Correccion administrativa', observacion_cierre: '  Nueva   observacion  ' });
    assert.deepEqual(valid, { status: 200 });
    assert.equal(persisted.closeObservation, 'Nueva observacion');
    assert.equal(persisted.sessionObservation, 'Nueva observacion');
    assert.deepEqual(persisted.audits, [{ observation: 'Nueva observacion' }]);
  });

  it('rechaza un id_arqueo_final perteneciente a otra sesion', () => {
    const route = routeSlice(
      "router.patch('/ventas/cajas/cierres/:id'",
      "router.get('/ventas/cajas/reportes/resumen'"
    );
    assert.match(route, /SELECT id_sesion_caja[\s\S]*FROM public\.cajas_arqueos/);
    assert.match(route, /String\(arqueoResult\.rows\[0\]\.id_sesion_caja\) !== String\(cierre\.id_sesion_caja\)/);
    assert.match(route, /VENTAS_CAJAS_ARQUEO_SESSION_MISMATCH/);
  });

  for (const [label, startMarker, endMarker, insertPattern] of [
    [
      'arqueo',
      "router.post('/ventas/cajas/sesiones/:id/arqueos'",
      "router.get('/ventas/cajas/sesiones/:id/arqueos'",
      /INSERT INTO public\.cajas_arqueos/
    ],
    [
      'movimiento',
      "router.post('/ventas/cajas/sesiones/:id/movimientos'",
      "router.get('/ventas/cajas/sesiones/:id/movimientos'",
      /INSERT INTO public\.cajas_movimientos/
    ]
  ]) {
    it(`la ruta de ${label} toma lock financiero y luego FOR UPDATE antes del INSERT`, () => {
      const route = routeSlice(startMarker, endMarker);
      const lockIndex = route.indexOf('await lockCajaFinancialSession(client, idSesionCaja)');
      const sessionIndex = route.indexOf('await ensureOpenSession(client, idSesionCaja, { forUpdate: true })');
      const insertIndex = route.search(insertPattern);
      assert.ok(lockIndex > 0);
      assert.ok(sessionIndex > lockIndex);
      assert.ok(insertIndex > sessionIndex);
    });
  }

  it('el smoke usa lock global, libera en finally y asigna ids aleatorios previamente verificados', () => {
    assert.match(smokeSource, /SELECT pg_try_advisory_lock/);
    assert.match(smokeSource, /QA_CAJA_CLOSE_SMOKE_ALREADY_RUNNING/);
    assert.match(smokeSource, /SELECT pg_advisory_unlock/);
    assert.match(smokeSource, /if \(releaseSmokeLock\) await releaseSmokeLock\(\)/);
    assert.match(smokeSource, /crypto\.randomInt\(900_000_000, 990_000_000\)/);
    assert.match(smokeSource, /allocateUniqueSmokeBaseId/);
    assert.match(smokeSource, /FROM public\.cajas_sesiones[\s\S]*FROM public\.cajas_movimientos[\s\S]*FROM public\.facturas_cobros/);
    assert.doesNotMatch(smokeSource, /900_000_000 \+ \(Date\.now\(\) % 90_000_000\)/);
  });
});
