import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const safeSource = readFileSync(
  resolve('sql/20260720_allow_negative_cash_close_theoretical_SAFE.sql'),
  'utf8'
);
const verifySource = readFileSync(
  resolve('sql/20260720_allow_negative_cash_close_theoretical_VERIFY.sql'),
  'utf8'
);
const rollbackSource = readFileSync(
  resolve('sql/20260720_allow_negative_cash_close_theoretical_ROLLBACK.sql'),
  'utf8'
);
const preflightSource = readFileSync(
  resolve('sql/20260720_allow_negative_cash_close_theoretical_PREFLIGHT.sql'),
  'utf8'
);
const routerSource = readFileSync(resolve('routers/cajas.js'), 'utf8');

// Los comentarios "-- ..." explican intencion en prosa y legitimamente
// mencionan palabras como DROP/ALTER/VALIDATE (p. ej. "DROP CONSTRAINT IF
// EXISTS es idempotente"). Las aserciones de "no contiene DDL/DML" y los
// conteos de statements deben operar sobre el codigo sin comentarios, no
// sobre el texto crudo del archivo.
const stripSqlComments = (source) => source
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const safeCode = stripSqlComments(safeSource);
const verifyCode = stripSqlComments(verifySource);
const rollbackCode = stripSqlComments(rollbackSource);
const preflightCode = stripSqlComments(preflightSource);

describe('monto teorico negativo en cierre de caja', () => {
  it('SAFE toma lock NOWAIT con timeouts endurecidos, elimina solo los tres CHECK y no modifica filas', () => {
    assert.match(safeSource, /BEGIN;/);
    assert.match(safeSource, /COMMIT;/);
    // Timeouts endurecidos: 1s/20s, nunca los 5s/120s originales (podrian
    // encolar ventas detras de la migracion en vez de fallar rapido).
    assert.match(safeSource, /SET LOCAL lock_timeout = '1s';/);
    assert.match(safeSource, /SET LOCAL statement_timeout = '20s';/);
    assert.match(safeSource, /SET LOCAL idle_in_transaction_session_timeout = '20s';/);
    assert.doesNotMatch(safeSource, /lock_timeout = '5s'/);
    assert.doesNotMatch(safeSource, /statement_timeout = '120s'/);
    // Lock explicito NOWAIT sobre las tres tablas, antes de cualquier DROP.
    assert.match(safeSource, /LOCK TABLE[\s\S]*public\.cajas_sesiones[\s\S]*public\.cajas_cierres[\s\S]*public\.cajas_arqueos[\s\S]*IN ACCESS EXCLUSIVE MODE NOWAIT;/);
    const lockIndex = safeSource.indexOf('IN ACCESS EXCLUSIVE MODE NOWAIT');
    const firstDropIndex = safeSource.indexOf('DROP CONSTRAINT IF EXISTS');
    assert.ok(lockIndex > 0 && firstDropIndex > lockIndex, 'el lock NOWAIT debe tomarse antes de eliminar restricciones');

    assert.match(safeSource, /conkey/);
    assert.match(safeSource, /pg_get_expr\(c\.conbin, c\.conrelid\)/);
    assert.match(safeSource, /monto_teorico_cierre>=0/);
    assert.match(safeSource, /ARRAY\[target_column\]::smallint\[\]/);
    assert.match(safeSource, /monto_teorico_attnum smallint/);
    assert.match(safeSource, /monto_contado_attnum smallint/);
    assert.match(safeSource, /ARRAY\[monto_teorico_attnum\]::smallint\[\]/);
    assert.match(safeSource, /ARRAY\[monto_contado_attnum\]::smallint\[\]/);
    assert.match(safeSource, /DROP CONSTRAINT IF EXISTS ck_cajas_sesiones_monto_teorico/);
    assert.match(safeSource, /DROP CONSTRAINT IF EXISTS ck_cajas_cierres_monto_teorico/);
    assert.match(safeSource, /DROP CONSTRAINT IF EXISTS ck_cajas_arqueos_teorico/);

    // Validacion estricta (no solo existencia) de ck_cajas_arqueos_contado:
    // tipo, validada, columnas exactas y expresion equivalente.
    assert.match(safeSource, /public\.cajas_arqueos/);
    assert.match(safeSource, /ck_cajas_arqueos_contado/);
    assert.match(safeSource, /constraint_validated IS NOT TRUE/);
    assert.match(safeSource, /'monto_contado>=0'/);
    assert.match(safeSource, /'monto_teorico>=0'/);

    assert.doesNotMatch(safeCode, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    // Exactamente 3 DROP CONSTRAINT (los tres objetivo) -- monto_contado y el
    // resto de columnas de dinero solo pueden aparecer en la validacion de
    // solo-lectura (mensajes de error, comparaciones), nunca como objetivo de
    // un ALTER destructivo.
    assert.equal((safeCode.match(/DROP CONSTRAINT IF EXISTS/g) || []).length, 3);
    assert.equal((safeCode.match(/\bALTER TABLE\b/g) || []).length, 3);
  });

  it('VERIFY es solo lectura, detecta CHECK equivalentes por columna, catalogo OTRO y conteos de regresion', () => {
    assert.doesNotMatch(verifyCode, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    assert.match(verifySource, /c\.conkey @> ARRAY\[a\.attnum\]::smallint\[\]/);
    assert.match(verifySource, /checks_equivalentes_no_negativos/);
    assert.match(verifySource, /permite_valores_negativos/);
    for (const column of [
      'monto_apertura',
      'monto_declarado_cierre',
      'monto_ventas_efectivo',
      'monto_ventas_no_efectivo',
      'monto_ingresos_manuales',
      'monto_egresos_manuales',
      'monto_declarado',
      'monto_contado'
    ]) {
      assert.match(verifySource, new RegExp(column));
    }
    assert.match(verifySource, /public\.cajas_arqueos/);
    assert.match(verifySource, /c\.convalidated/);
    assert.match(verifySource, /control_no_negativo_presente_y_validado/);
    // Ausencia explicita de los tres CHECK eliminados por SAFE.
    assert.match(verifySource, /ck_cajas_sesiones_monto_teorico/);
    assert.match(verifySource, /ck_cajas_cierres_monto_teorico/);
    assert.match(verifySource, /ck_cajas_arqueos_teorico/);
    assert.match(verifySource, /AS ausente/);
    // Catalogo EFECTIVO/TARJETA/TRANSFERENCIA/OTRO y validez de OTRO.
    assert.match(verifySource, /'EFECTIVO', true.*'TARJETA', false.*'TRANSFERENCIA', false.*'OTRO', false/s);
    assert.match(verifySource, /AS valido/);
    // Evidencia de regresion cero (conteos/sumas de ventas, cobros, facturas, pedidos).
    assert.match(verifySource, /cantidad_facturas/);
    assert.match(verifySource, /suma_facturas/);
    assert.match(verifySource, /cantidad_cobros/);
    assert.match(verifySource, /suma_cobros/);
    assert.match(verifySource, /cantidad_pedidos/);
    assert.match(verifySource, /sesiones_abiertas/);
    // No debe depender de fixtures hardcodeados de un entorno especifico
    // (montos o ids de fila fijos no tienen sentido en un script reusable
    // contra QA o produccion reales).
    assert.doesNotMatch(verifySource, /id_movimiento_caja\s*=\s*17/);
    assert.doesNotMatch(verifySource, /16763\.00/);
  });

  it('ROLLBACK usa NOWAIT, falla cerrado si existen negativos, y separa ADD (NOT VALID) de VALIDATE en fases distintas', () => {
    assert.match(rollbackSource, /SET LOCAL lock_timeout = '1s';/);
    assert.match(rollbackSource, /SET LOCAL statement_timeout = '20s';/);
    assert.match(rollbackSource, /SET LOCAL idle_in_transaction_session_timeout = '20s';/);
    assert.doesNotMatch(rollbackSource, /lock_timeout = '5s'/);
    assert.doesNotMatch(rollbackSource, /statement_timeout = '120s'/);
    assert.match(rollbackSource, /LOCK TABLE[\s\S]*IN ACCESS EXCLUSIVE MODE NOWAIT;/);

    assert.match(rollbackSource, /WHERE monto_teorico_cierre < 0/g);
    assert.match(rollbackSource, /WHERE monto_teorico < 0/);
    assert.match(rollbackSource, /Rollback bloqueado/);
    assert.match(rollbackSource, /constraint_columns IS DISTINCT FROM ARRAY\[target_column\]::smallint\[\]/g);
    assert.match(rollbackSource, /monto_teorico_cierreisnullormonto_teorico_cierre>=0/);
    assert.match(rollbackSource, /monto_teorico_cierre>=0/);
    assert.match(rollbackSource, /'monto_teorico>=0'/);
    assert.match(rollbackSource, /existe con una definicion incorrecta/g);
    assert.match(rollbackSource, /monto_contado_attnum smallint/);
    assert.match(rollbackSource, /constraint_type IS DISTINCT FROM 'c'::"char"/);
    assert.match(rollbackSource, /constraint_columns IS DISTINCT FROM ARRAY\[monto_contado_attnum\]::smallint\[\]/);
    assert.match(rollbackSource, /normalized_expression <> 'monto_contado>=0'/);
    assert.match(rollbackSource, /ck_cajas_arqueos_contado no coincide exactamente/);

    assert.match(rollbackSource, /ADD CONSTRAINT ck_cajas_sesiones_monto_teorico/);
    assert.match(rollbackSource, /ADD CONSTRAINT ck_cajas_cierres_monto_teorico/);
    assert.match(rollbackSource, /ADD CONSTRAINT ck_cajas_arqueos_teorico/);
    assert.match(rollbackSource, /\)\s*NOT VALID;/g);
    assert.match(rollbackSource, /VALIDATE CONSTRAINT ck_cajas_sesiones_monto_teorico/);
    assert.match(rollbackSource, /VALIDATE CONSTRAINT ck_cajas_cierres_monto_teorico/);
    assert.match(rollbackSource, /VALIDATE CONSTRAINT ck_cajas_arqueos_teorico/);
    assert.equal((rollbackSource.match(/SET LOCAL lock_timeout = '1s';/g) || []).length, 4);
    assert.equal((rollbackSource.match(/SET LOCAL statement_timeout = '20s';/g) || []).length, 4);
    assert.equal((rollbackSource.match(/SET LOCAL idle_in_transaction_session_timeout = '20s';/g) || []).length, 4);
    assert.match(rollbackSource, /PHASE_2_VALIDATE_CAJAS_SESIONES_BEGIN/);
    assert.match(rollbackSource, /PHASE_2_VALIDATE_CAJAS_CIERRES_BEGIN/);
    assert.match(rollbackSource, /PHASE_2_VALIDATE_CAJAS_ARQUEOS_BEGIN/);
    assert.match(rollbackSource, /Fallo VALIDATE CONSTRAINT public\.cajas_sesiones\.ck_cajas_sesiones_monto_teorico/);
    assert.match(rollbackSource, /Fallo VALIDATE CONSTRAINT public\.cajas_cierres\.ck_cajas_cierres_monto_teorico/);
    assert.match(rollbackSource, /Fallo VALIDATE CONSTRAINT public\.cajas_arqueos\.ck_cajas_arqueos_teorico/);

    // Fase 1 (ADD ... NOT VALID) debe estar en un COMMIT anterior al de las
    // fases de VALIDATE CONSTRAINT: evita mantener ACCESS EXCLUSIVE durante
    // el escaneo de VALIDATE (los locks de una transaccion no se liberan
    // hasta su COMMIT). Se busca sobre el codigo sin comentarios: la
    // introduccion del archivo menciona "VALIDATE CONSTRAINT" en prosa antes
    // de la fase 1 real.
    const firstCommitIndex = rollbackCode.indexOf('COMMIT;');
    const firstValidateIndex = rollbackCode.indexOf('VALIDATE CONSTRAINT');
    assert.ok(firstCommitIndex > 0 && firstValidateIndex > firstCommitIndex, 'VALIDATE CONSTRAINT debe ejecutarse despues del COMMIT de la fase 1');

    assert.doesNotMatch(rollbackCode, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it('PREFLIGHT es solo lectura y clasifica cada restriccion individualmente (no por conteo)', () => {
    assert.doesNotMatch(preflightCode, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|LOCK)\b/i);
    assert.match(preflightSource, /to_regclass\(t\.tabla\)/);
    assert.match(preflightSource, /estado_restriccion/);
    assert.match(preflightSource, /'LEGACY'/);
    assert.match(preflightSource, /'SAFE'/);
    assert.match(preflightSource, /'PARCIAL'/);
    assert.match(preflightSource, /estado_migracion/);
    assert.match(preflightSource, /protege_exclusivamente_monto_contado/);
    assert.match(preflightSource, /control_no_negativo_presente_y_validado/);
    assert.match(preflightSource, /AS valido/);
    assert.match(preflightSource, /sesiones_abiertas/);
    assert.match(preflightSource, /pg_stat_activity/);
    assert.match(preflightSource, /interval '5 seconds'/);
    assert.match(preflightSource, /pg_locks/);
    assert.match(preflightSource, /sesiones_negativas/);
    assert.match(preflightSource, /pg_total_relation_size/);
  });

  it('el cierre conserva valor exacto, diferencia, revision y notificacion', () => {
    const start = routerSource.indexOf('const closeSessionHandler = async');
    const end = routerSource.indexOf("router.patch('/ventas/cajas/sesiones/:id/cerrar'", start);
    const closeSource = routerSource.slice(start, end);

    assert.match(closeSource, /const recomputedValidation = assertCloseValidationMatchesCurrentSummary/);
    assert.match(closeSource, /montoTeorico = recomputedValidation\.monto_teorico_total/);
    assert.match(closeSource, /montoDeclaradoCierre = recomputedValidation\.monto_declarado_total/);
    assert.match(closeSource, /diferencia = recomputedValidation\.diferencia_total/);
    assert.match(closeSource, /payload_declarado_json, resultado_json/);
    assert.match(closeSource, /arqueosPersistir = recomputedValidation\.rows\.map/);
    assert.match(closeSource, /PENDIENTE_REVISION/);
    assert.match(closeSource, /createCajaCloseEmailNotification\(client/);
    assert.match(closeSource, /requiresAudit/);
    assert.doesNotMatch(closeSource, /Math\.max\(0,\s*montoTeorico\)|montoTeorico\s*=\s*0/);
  });

  it('assertCloseValidationMatchesCurrentSummary valida la fila OTRO y detecta filas inesperadas/duplicadas', () => {
    const start = routerSource.indexOf('const assertCloseValidationMatchesCurrentSummary');
    const end = routerSource.indexOf('const getScopeContext', start);
    const assertSource = routerSource.slice(start, end);

    assert.match(assertSource, /buildExpectedOtroValidationRow/);
    assert.match(assertSource, /recomputeAndAssertCloseValidation/);
    assert.match(assertSource, /const storedByCode = new Map/);
    assert.match(assertSource, /const rowsForCode = storedByCode\.get\(code\) \|\| \[\]/);
    assert.match(assertSource, /methodRows\.length !== 1/);
    assert.match(assertSource, /DUPLICADO/);
    assert.match(assertSource, /INESPERADO/);
    assert.match(assertSource, /validationMethodId !== currentMethodId/);
    assert.match(assertSource, /Boolean\(storedOtroRow\) !== Boolean\(expectedOtroRow\)/);
    assert.match(assertSource, /storedOtroId !== expectedOtroId/);
    assert.match(assertSource, /storedOtroTeorico !== expectedOtroTeorico/);
  });
});
