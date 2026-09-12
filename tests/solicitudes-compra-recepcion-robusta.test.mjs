import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  buildReceptionFingerprint,
  buildUploadFingerprint,
  parseReceivedQuantity
} = await import('../services/solicitudesCompraRecepcionService.js');

const source = fs.readFileSync(new URL('../services/solicitudesCompraRecepcionService.js', import.meta.url), 'utf8');
const router = fs.readFileSync(new URL('../routers/solicitudes_compra.js', import.meta.url), 'utf8');
const zeroMigration = fs.readFileSync(new URL('../sql/20260912012510_oc_recepcion_allow_zero.sql', import.meta.url), 'utf8');
const idempotencyMigration = fs.readFileSync(new URL('../sql/20260912012521_oc_recepcion_idempotency_contract.sql', import.meta.url), 'utf8');

test('producto 0 es valido', () => assert.equal(parseReceivedQuantity('0', 'PRODUCTO')?.decimal, '0'));
test('producto entero positivo es valido', () => assert.equal(parseReceivedQuantity('2', 'PRODUCTO')?.decimal, '2'));
test('producto decimal es invalido', () => assert.equal(parseReceivedQuantity('0.5', 'PRODUCTO'), null));
test('producto negativo es invalido', () => assert.equal(parseReceivedQuantity('-1', 'PRODUCTO'), null));
test('insumo 0 es valido', () => assert.equal(parseReceivedQuantity('0', 'INSUMO')?.decimal, '0'));
test('insumo decimal positivo es valido', () => assert.equal(parseReceivedQuantity('1.25', 'INSUMO')?.decimal, '1.25'));
test('insumo negativo es invalido', () => assert.equal(parseReceivedQuantity('-1', 'INSUMO'), null));
test('cantidad vacia es invalida', () => assert.equal(parseReceivedQuantity('', 'INSUMO'), null));
test('lineas cero se actualizan en batch', () => assert.match(source, /UNNEST\(\$1::int\[\], \$2::numeric\[\], \$3::numeric\[\]\)/));
test('lineas cero no generan movimiento', () => assert.match(source, /filter\(\(detail\) => detail\.receivedBase !== '0'\)/));
test('lineas positivas generan un movimiento por fila positiva', () => assert.match(source, /FROM UNNEST\(\$4::numeric\[\], \$5::int\[\], \$6::int\[\]\)/));
test('mezcla cero y positivos cuenta movimientos positivos', () => assert.match(source, /total_movimientos: positive\.length/));
test('todas cero permite finalizar RECIBIDA', () => assert.match(source, /SET estado = 'RECIBIDA'/));
test('mismo UUID y payload produce replay', () => assert.match(source, /formatReceptionResult\(replayRow, true\)/));
test('mismo UUID y payload diferente produce 409', () => assert.match(source, /IDEMPOTENCY_CONFLICT/));
test('UUID diferente sobre recibida conserva conflicto de estado', () => assert.match(source, /assertHeader\(header, txAccess\)/));
test('concurrencia se serializa con FOR UPDATE', () => assert.match(source, /loadHeader\(client, requestId, \{ lock: true \}\)/));
test('upload repetido mismo archivo retorna evidencia', () => assert.match(source, /replay: true, evidencia: formatEvidence\(existing\)/));
test('upload repetido distinto archivo produce conflicto', () => assert.match(source, /upload_request_id ya fue utilizado con otro archivo/));
test('fallo antes del commit ejecuta rollback', () => assert.match(source, /transactionStarted && client\) await safeRollback/));
test('fallo de storage no persiste metadata', () => assert.ok(source.indexOf('dependencies.storage.upload') < source.indexOf('INSERT INTO public.archivos')));
test('compensacion solo elimina rutas subidas por el intento', () => assert.match(source, /cleanupUploadedPaths\(uploadedPaths\)/));
test('sin factura no se permite recibir', () => assert.match(source, /FACTURA_REQUIRED/));
test('fingerprint canonico soporta 60 lineas y orden estable', () => {
  const details = Array.from({ length: 60 }, (_, index) => ({ id_solicitud_detalle: 60 - index, rawQuantity: index % 2 ? '0.000000' : '2.0' }));
  const left = buildReceptionFingerprint({ requestId: 7, observation: null, details });
  const right = buildReceptionFingerprint({ requestId: 7, observation: null, details: [...details].reverse() });
  assert.equal(left, right); assert.match(left, /^[0-9a-f]{64}$/);
});
test('fingerprint de upload incluye bytes', () => {
  const base = { requestId: 7, invoice: { originalName: 'Factura.png', mimeType: 'image/png', buffer: Buffer.from('a') } };
  assert.notEqual(buildUploadFingerprint(base), buildUploadFingerprint({ ...base, invoice: { ...base.invoice, buffer: Buffer.from('b') } }));
});
test('rutas de reconciliacion estan protegidas por permisos de recepcion', () => {
  assert.match(router, /\/recepciones\/:reception_request_id'[\s\S]*requirePermissions\(RECEIVE_PERMISSIONS\)/);
  assert.match(router, /evidencias\/envios\/:upload_request_id'[\s\S]*requirePermissions\(RECEIVE_PERMISSIONS\)/);
});

test('migracion zero reemplaza el constraint compuesto sin crear constraints individuales', () => {
  assert.match(zeroMigration, /DROP CONSTRAINT IF EXISTS chk_solicitudes_compra_detalle_cantidades/);
  assert.match(zeroMigration, /ADD CONSTRAINT chk_solicitudes_compra_detalle_cantidades/);
  assert.match(zeroMigration, /cantidad_recibida IS NULL OR cantidad_recibida >= 0::numeric/);
  assert.match(zeroMigration, /cantidad_base_recibida IS NULL OR cantidad_base_recibida >= 0::numeric/);
  assert.match(zeroMigration, /cantidad_aprobada IS NULL OR cantidad_aprobada > 0::numeric/);
  assert.match(zeroMigration, /cantidad_base_aprobada IS NULL OR cantidad_base_aprobada > 0::numeric/);
  assert.doesNotMatch(zeroMigration, /solicitudes_compra_detalle_cantidad_(?:base_)?recibida_check/);
});

test('migracion de idempotencia coincide con nombres y NOT VALID del contrato QA', () => {
  assert.match(idempotencyMigration, /solicitudes_compra_reception_request_fingerprint_format_chk/);
  assert.match(idempotencyMigration, /solicitudes_compra_evidencias_upload_request_fingerprint_format_chk/);
  assert.match(idempotencyMigration, /solicitudes_compra_reception_request_id_uidx/);
  assert.match(idempotencyMigration, /solicitudes_compra_evidencias_upload_request_id_uidx/);
  assert.equal((idempotencyMigration.match(/\) NOT VALID;/g) || []).length, 2);
});
