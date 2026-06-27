import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const cajasSource = readFileSync(new URL('../../routers/cajas.js', import.meta.url), 'utf8');
const defaultsMigration = readFileSync(new URL('../2026-06-27_caja_operational_timestamp_defaults.sql', import.meta.url), 'utf8');
const qaRepair = readFileSync(new URL('../qa_repair_caja_sesion_2_roles.sql', import.meta.url), 'utf8');

test('POST asignaciones bloquea cambio de rol durante sesion abierta antes del upsert', () => {
  const postStart = cajasSource.indexOf("router.post('/ventas/cajas/asignaciones'");
  const postEnd = cajasSource.indexOf("router.patch('/ventas/cajas/asignaciones/:id'", postStart);
  const postSource = cajasSource.slice(postStart, postEnd);

  assert.match(postSource, /fetchOpenSessionForCaja\(client,\s*idCaja,\s*\{\s*forUpdate:\s*true\s*\}\)/);
  assert.match(postSource, /fetchActiveCajaAuthorizationForUpdate\(client,\s*idCaja,\s*idUsuario\)/);
  assert.match(postSource, /VENTAS_CAJAS_ASSIGNMENT_OPEN_SESSION_LOCKED/);
  assert.match(postSource, /requestedRoleCode === 'AUXILIAR'/);
  assert.match(postSource, /Asignacion de caja ya registrada con el mismo rol/);
  assert.match(postSource, /insertSessionParticipant\(\{[\s\S]*roleCode:\s*'AUXILIAR'/);

  const openSessionIndex = postSource.indexOf('const openSession = await fetchOpenSessionForCaja');
  const upsertIndex = postSource.indexOf('const idCajaUsuarioAutorizado = await upsertCajaAuthorization');
  assert.ok(openSessionIndex > -1 && upsertIndex > -1 && openSessionIndex < upsertIndex);
});

test('resumen de sesion clasifica responsable y participantes por pertenencia a sesion', () => {
  assert.match(cajasSource, /WHEN fc\.id_usuario_ejecutor = \$2 THEN 'RESPONSABLE'/);
  assert.doesNotMatch(
    cajasSource,
    /WHERE csp\.id_sesion_caja = fc\.id_sesion_caja[\s\S]{0,180}AND fc\.fecha_cobro >= COALESCE\(csp\.fecha_inicio/
  );
  assert.match(cajasSource, /WHEN crp\.codigo IS NOT NULL THEN crp\.codigo/);
  assert.match(cajasSource, /ELSE 'EJECUTOR'/);
  assert.doesNotMatch(defaultsMigration, /total_otros_ejecutores/i);
});

test('migracion y reparacion QA usan hora local sin crear total_otros_ejecutores persistente', () => {
  assert.match(defaultsMigration, /ALTER TABLE public\.cajas_sesiones_participantes[\s\S]*fecha_inicio SET DEFAULT \(now\(\) AT TIME ZONE 'America\/Tegucigalpa'\)/);
  assert.match(defaultsMigration, /ALTER TABLE public\.facturas_cobros[\s\S]*fecha_cobro SET DEFAULT \(now\(\) AT TIME ZONE 'America\/Tegucigalpa'\)/);
  assert.match(qaRepair, /WHERE cs\.id_sesion_caja = 2/);
  assert.match(qaRepair, /total_responsable[\s\S]*total_auxiliares[\s\S]*total_otros_ejecutores[\s\S]*total_teorico/);
  assert.doesNotMatch(`${defaultsMigration}\n${qaRepair}`, /ADD COLUMN\s+total_otros_ejecutores/i);
});

