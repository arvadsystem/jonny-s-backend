import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import pg from 'pg';
import {
  assertIsolatedDatabaseServerAndMarker,
  assertIsolatedDatabaseUrlAllowed
} from '../services/cajaCloseIsolatedDatabaseGuard.js';
import { assertCoreCatalogValid } from '../services/cajaCloseComputationService.js';
import { loadCajaCloseFinancialSnapshot } from '../services/cajaCloseFinancialSnapshotService.js';
import {
  lockCajaFinancialSession,
  mapCajaFinancialLockError
} from '../services/cajaFinancialLockService.js';

const SAFE_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_SAFE.sql', import.meta.url);
const ROLLBACK_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_ROLLBACK.sql', import.meta.url);
const PREFLIGHT_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_PREFLIGHT.sql', import.meta.url);

const TARGETS = Object.freeze([
  {
    table: 'public.cajas_sesiones',
    name: 'ck_cajas_sesiones_monto_teorico',
    expression: 'monto_teorico_cierre IS NULL OR monto_teorico_cierre >= 0'
  },
  {
    table: 'public.cajas_cierres',
    name: 'ck_cajas_cierres_monto_teorico',
    expression: 'monto_teorico_cierre >= 0'
  },
  {
    table: 'public.cajas_arqueos',
    name: 'ck_cajas_arqueos_teorico',
    expression: 'monto_teorico >= 0'
  }
]);

const normalizeExpression = (value) => String(value || '')
  .toLowerCase()
  .replace(/\s+|[()]|::numeric/g, '');

const createPool = (connectionString) => new pg.Pool({
  connectionString,
  ssl: false,
  max: 6,
  application_name: 'qa-caja-negative-close-isolated'
});

const initializeSchema = async (queryRunner) => {
  await queryRunner.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;

    CREATE TABLE public.__jonnys_disposable_test_database (
      purpose text PRIMARY KEY
    );
    INSERT INTO public.__jonnys_disposable_test_database (purpose)
    VALUES ('CAJA_CLOSE_ISOLATED_TEST');

    CREATE TABLE public.cajas_sesiones (
      id_sesion_caja bigint PRIMARY KEY,
      monto_teorico_cierre numeric(14,2),
      marca text,
      monto_apertura numeric(14,2) NOT NULL DEFAULT 0,
      estado_codigo text NOT NULL DEFAULT 'ABIERTA',
      CONSTRAINT ck_cajas_sesiones_monto_teorico
        CHECK (monto_teorico_cierre IS NULL OR monto_teorico_cierre >= 0)
    );

    CREATE TABLE public.cajas_cierres (
      id_cierre_caja bigint PRIMARY KEY,
      monto_teorico_cierre numeric(14,2) NOT NULL DEFAULT 0,
      marca text,
      CONSTRAINT ck_cajas_cierres_monto_teorico
        CHECK (monto_teorico_cierre >= 0)
    );

    -- La posicion replica el contrato confirmado: monto_teorico=7 y
    -- monto_contado=8. Las columnas intermedias existen solo para conservar
    -- esos attnum en este PostgreSQL desechable.
    CREATE TABLE public.cajas_arqueos (
      id_arqueo_caja bigint PRIMARY KEY,
      id_sesion_caja bigint,
      id_caja integer,
      id_sucursal integer,
      id_usuario integer,
      fecha_registro timestamptz,
      monto_teorico numeric(14,2) NOT NULL DEFAULT 0,
      monto_contado numeric(14,2) NOT NULL DEFAULT 0,
      CONSTRAINT ck_cajas_arqueos_teorico CHECK (monto_teorico >= 0),
      CONSTRAINT ck_cajas_arqueos_contado CHECK (monto_contado >= 0)
    );

    CREATE TABLE public.cat_metodos_pago (
      id_metodo_pago integer PRIMARY KEY,
      codigo text NOT NULL,
      estado boolean NOT NULL DEFAULT true,
      afecta_efectivo boolean
    );
    CREATE TABLE public.cat_cajas_movimientos_tipos (
      id_tipo_movimiento_caja integer PRIMARY KEY,
      codigo text NOT NULL,
      signo integer NOT NULL
    );
    CREATE TABLE public.facturas (id_factura bigint PRIMARY KEY);
    CREATE TABLE public.detalle_facturas (
      id_detalle_factura bigint PRIMARY KEY,
      total_detalle numeric(14,2) NOT NULL
    );
    CREATE TABLE public.facturas_cobros (
      id_factura_cobro bigint PRIMARY KEY,
      monto numeric(14,2) NOT NULL,
      id_factura bigint,
      id_sesion_caja bigint,
      id_metodo_pago integer
    );
    CREATE TABLE public.facturas_reversiones (
      id_reversion bigint PRIMARY KEY,
      id_factura_original bigint NOT NULL,
      id_sesion_caja_original bigint,
      monto_reversado numeric(14,2) NOT NULL,
      estado text NOT NULL
    );
    CREATE TABLE public.pedidos (id_pedido bigint PRIMARY KEY);
    CREATE TABLE public.cajas_movimientos (
      id_movimiento_caja bigint PRIMARY KEY,
      id_sesion_caja bigint,
      id_tipo_movimiento_caja integer,
      monto numeric(14,2)
    );

    CREATE OR REPLACE FUNCTION public.fn_ventas_lock_caja_financial_session(
      p_id_sesion_caja bigint,
      p_timeout_ms integer DEFAULT 5000
    )
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_deadline timestamptz := clock_timestamp() + make_interval(secs => p_timeout_ms::double precision / 1000.0);
      v_lock_key bigint := ~p_id_sesion_caja;
    BEGIN
      LOOP
        EXIT WHEN pg_try_advisory_xact_lock(v_lock_key);
        IF clock_timestamp() >= v_deadline THEN
          RAISE EXCEPTION 'VENTAS_CAJA_FINANCIAL_LOCK_TIMEOUT' USING ERRCODE = '55P03';
        END IF;
        PERFORM pg_sleep(0.025);
      END LOOP;
    END;
    $$;

    INSERT INTO public.cat_metodos_pago (id_metodo_pago, codigo, estado, afecta_efectivo) VALUES
      (1, 'EFECTIVO', true, true),
      (2, 'TARJETA', true, false),
      (3, 'TRANSFERENCIA', true, false),
      (4, 'OTRO', true, false);
    INSERT INTO public.cat_cajas_movimientos_tipos VALUES (1, 'APERTURA', 1);
    INSERT INTO public.cajas_sesiones (id_sesion_caja, monto_teorico_cierre, marca, monto_apertura)
    VALUES (1, 10, 'BASE', 10);
    INSERT INTO public.cajas_cierres VALUES (1, 10, 'BASE');
    INSERT INTO public.cajas_arqueos (
      id_arqueo_caja, id_sesion_caja, id_caja, id_sucursal, id_usuario,
      fecha_registro, monto_teorico, monto_contado
    ) VALUES (1, 1, 1, 1, 1, NOW(), 10, 10);
    INSERT INTO public.facturas VALUES (1);
    INSERT INTO public.detalle_facturas VALUES (1, 123.45);
    INSERT INTO public.facturas_cobros (id_factura_cobro, monto) VALUES (1, 123.45);
    INSERT INTO public.pedidos VALUES (1);
    INSERT INTO public.cajas_movimientos VALUES (1);
  `);
};

const constraintSnapshot = async (queryRunner) => {
  const result = await queryRunner.query(`
    WITH expected(tabla, conname, orden) AS (
      VALUES
        ('public.cajas_sesiones'::regclass, 'ck_cajas_sesiones_monto_teorico', 1),
        ('public.cajas_cierres'::regclass, 'ck_cajas_cierres_monto_teorico', 2),
        ('public.cajas_arqueos'::regclass, 'ck_cajas_arqueos_teorico', 3)
    )
    SELECT
      e.tabla::text AS tabla,
      e.conname,
      c.oid IS NOT NULL AS presente,
      c.convalidated,
      c.conkey,
      pg_get_expr(c.conbin, c.conrelid) AS expresion
    FROM expected e
    LEFT JOIN pg_constraint c
      ON c.conrelid = e.tabla
     AND c.conname = e.conname
     AND c.contype = 'c'
    ORDER BY e.orden
  `);
  return result.rows.map((row) => ({
    tabla: row.tabla,
    conname: row.conname,
    presente: row.presente,
    convalidated: row.presente ? row.convalidated : null,
    conkey: row.presente ? row.conkey.map(Number) : null,
    expresion: row.presente ? normalizeExpression(row.expresion) : null
  }));
};

const countedConstraintSnapshot = async (queryRunner) => {
  const result = await queryRunner.query(`
    SELECT c.contype, c.convalidated, c.conkey,
           pg_get_expr(c.conbin, c.conrelid) AS expresion
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_arqueos'::regclass
      AND c.conname = 'ck_cajas_arqueos_contado'
  `);
  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  return {
    contype: row.contype,
    convalidated: row.convalidated,
    conkey: row.conkey.map(Number),
    expresion: normalizeExpression(row.expresion)
  };
};

const regressionMetrics = async (queryRunner) => {
  const result = await queryRunner.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.facturas) AS cantidad_facturas,
      (SELECT COALESCE(SUM(total_detalle), 0)::text FROM public.detalle_facturas) AS suma_facturas,
      (SELECT COUNT(*)::int FROM public.facturas_cobros) AS cantidad_cobros,
      (SELECT COALESCE(SUM(monto), 0)::text FROM public.facturas_cobros) AS suma_cobros,
      (SELECT COUNT(*)::int FROM public.pedidos) AS cantidad_pedidos,
      (SELECT COUNT(*)::int FROM public.cajas_movimientos) AS cantidad_movimientos,
      (SELECT COUNT(*)::int FROM public.cajas_arqueos) AS cantidad_arqueos,
      (SELECT COUNT(*)::int FROM public.cajas_cierres) AS cantidad_cierres,
      (SELECT COUNT(*)::int FROM public.cajas_sesiones) AS cantidad_sesiones
  `);
  return result.rows[0];
};

const runMultiStatement = async (client, sql) => {
  try {
    return await client.query(sql);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
};

const setLegacyState = async (client) => {
  await client.query('BEGIN');
  try {
    for (const target of TARGETS) {
      await client.query(`ALTER TABLE ${target.table} DROP CONSTRAINT IF EXISTS ${target.name}`);
      await client.query(`ALTER TABLE ${target.table} ADD CONSTRAINT ${target.name} CHECK (${target.expression}) NOT VALID`);
      await client.query(`ALTER TABLE ${target.table} VALIDATE CONSTRAINT ${target.name}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

const setCombination = async (client, bits) => {
  await setLegacyState(client);
  for (let index = 0; index < TARGETS.length; index += 1) {
    if (bits[index] === '0') {
      const target = TARGETS[index];
      await client.query(`ALTER TABLE ${target.table} DROP CONSTRAINT ${target.name}`);
    }
  }
};

const restoreConstraintSnapshot = async (client, snapshot) => {
  await client.query('BEGIN');
  try {
    for (const target of TARGETS) {
      await client.query(`ALTER TABLE ${target.table} DROP CONSTRAINT IF EXISTS ${target.name}`);
    }
    for (const original of snapshot) {
      if (!original.presente) continue;
      const target = TARGETS.find((entry) => entry.name === original.conname);
      assert.ok(target);
      await client.query(`ALTER TABLE ${target.table} ADD CONSTRAINT ${target.name} CHECK (${target.expression}) NOT VALID`);
      if (original.convalidated) {
        await client.query(`ALTER TABLE ${target.table} VALIDATE CONSTRAINT ${target.name}`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  assert.deepEqual(await constraintSnapshot(client), snapshot);
};

const assertSafeState = async (queryRunner) => {
  const state = await constraintSnapshot(queryRunner);
  assert.ok(state.every((row) => row.presente === false));
  return state;
};

const expectFailure = async (client, sql, predicate) => {
  let captured = null;
  try {
    await runMultiStatement(client, sql);
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, 'se esperaba que PostgreSQL rechazara la operacion');
  if (predicate) assert.equal(predicate(captured), true);
  return captured;
};

const testNowaitLock = async (pool, safeSql) => {
  const locker = await pool.connect();
  const runner = await pool.connect();
  let lockReleased = false;
  try {
    await setLegacyState(runner);
    const before = await constraintSnapshot(runner);
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE public.cajas_sesiones IN ACCESS EXCLUSIVE MODE');
    const started = process.hrtime.bigint();
    const error = await expectFailure(runner, safeSql, (candidate) => candidate.code === '55P03');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    assert.equal(error.code, '55P03');
    assert.ok(elapsedMs < 1500, `NOWAIT tardo ${elapsedMs.toFixed(3)}ms`);
    await locker.query('ROLLBACK');
    lockReleased = true;
    assert.deepEqual(await constraintSnapshot(runner), before);
    return { sqlstate: error.code, elapsedMs: Number(elapsedMs.toFixed(3)) };
  } finally {
    if (!lockReleased) await locker.query('ROLLBACK').catch(() => {});
    locker.release();
    runner.release();
  }
};

const testWrongTargetDefinitions = async (client, safeSql) => {
  const results = [];
  for (const target of TARGETS) {
    await setCombination(client, '000');
    await client.query(`ALTER TABLE ${target.table} ADD CONSTRAINT ${target.name} CHECK (${target.expression.replace('>= 0', '>= -999')})`);
    const before = await constraintSnapshot(client);
    const error = await expectFailure(client, safeSql, (candidate) => /no coincide con el CHECK no-negativo esperado/.test(candidate.message));
    assert.deepEqual(await constraintSnapshot(client), before);
    results.push({ constraint: target.name, rejected: true, sqlstate: error.code || null });
  }
  return results;
};

const testRollback = async (client, rollbackSql) => {
  await setCombination(client, '000');
  await runMultiStatement(client, rollbackSql);
  const restored = await constraintSnapshot(client);
  assert.ok(restored.every((row) => row.presente && row.convalidated));
  await runMultiStatement(client, rollbackSql);
  assert.deepEqual(await constraintSnapshot(client), restored);

  await setCombination(client, '000');
  await client.query("UPDATE public.cajas_sesiones SET monto_teorico_cierre=-1 WHERE id_sesion_caja=1");
  const negativeError = await expectFailure(client, rollbackSql, (candidate) => /existen montos teoricos negativos/.test(candidate.message));
  await assertSafeState(client);
  await client.query("UPDATE public.cajas_sesiones SET monto_teorico_cierre=10 WHERE id_sesion_caja=1");

  await setCombination(client, '000');
  await client.query('ALTER TABLE public.cajas_arqueos DROP CONSTRAINT ck_cajas_arqueos_contado');
  await client.query('ALTER TABLE public.cajas_arqueos ADD CONSTRAINT ck_cajas_arqueos_contado CHECK (monto_contado >= -1)');
  const countedError = await expectFailure(client, rollbackSql, (candidate) => /monto_contado >= 0/.test(candidate.message));
  await assertSafeState(client);
  await client.query('ALTER TABLE public.cajas_arqueos DROP CONSTRAINT ck_cajas_arqueos_contado');
  await client.query('ALTER TABLE public.cajas_arqueos ADD CONSTRAINT ck_cajas_arqueos_contado CHECK (monto_contado >= 0)');

  return {
    noNegatives: true,
    repeated: true,
    negativesRejected: true,
    negativeSqlstate: negativeError.code || null,
    wrongCountedDefinitionRejected: true,
    countedSqlstate: countedError.code || null
  };
};

const testEightCombinations = async (client, safeSql) => {
  const results = [];
  for (let value = 0; value < 8; value += 1) {
    const bits = value.toString(2).padStart(3, '0');
    await setCombination(client, bits);
    const initial = await constraintSnapshot(client);
    try {
      await runMultiStatement(client, safeSql);
      await assertSafeState(client);
    } finally {
      await restoreConstraintSnapshot(client, initial);
    }
    results.push({ state: bits, restoredExactly: true });
  }
  return results;
};

const testInjectedFailureRestoration = async (client, safeSql) => {
  await setCombination(client, '101');
  const initial = await constraintSnapshot(client);
  let deliberateFailureObserved = false;
  try {
    await runMultiStatement(client, safeSql);
    await assertSafeState(client);
    throw new Error('QA_SMOKE_DELIBERATE_FAILURE_AFTER_SAFE');
  } catch (error) {
    deliberateFailureObserved = error.message === 'QA_SMOKE_DELIBERATE_FAILURE_AFTER_SAFE';
    if (!deliberateFailureObserved) throw error;
  } finally {
    await restoreConstraintSnapshot(client, initial);
  }
  assert.equal(deliberateFailureObserved, true);
  return { initialState: '101', deliberateFailureObserved, restoredExactly: true };
};

const extractMarkedSql = (sql, markerName) => {
  const startMarker = `-- ${markerName}_BEGIN`;
  const endMarker = `-- ${markerName}_END`;
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `No se encontro el bloque SQL ${markerName}`);
  return sql.slice(start + startMarker.length, end).trim();
};

const testRollbackValidateLock = async (pool, rollbackSql) => {
  const locker = await pool.connect();
  const runner = await pool.connect();
  let lockReleased = false;
  try {
    await setCombination(runner, '000');
    await runner.query(`
      ALTER TABLE public.cajas_sesiones
      ADD CONSTRAINT ck_cajas_sesiones_monto_teorico
      CHECK (monto_teorico_cierre IS NULL OR monto_teorico_cierre >= 0) NOT VALID
    `);
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE public.cajas_sesiones IN ACCESS EXCLUSIVE MODE');
    const validateSql = extractMarkedSql(rollbackSql, 'PHASE_2_VALIDATE_CAJAS_SESIONES');
    const started = process.hrtime.bigint();
    const error = await expectFailure(runner, validateSql, (candidate) => candidate.code === '55P03');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    assert.match(error.message, /ck_cajas_sesiones_monto_teorico/);
    assert.ok(elapsedMs >= 900 && elapsedMs < 1500, `VALIDATE lock_timeout tardo ${elapsedMs.toFixed(3)}ms`);
    await locker.query('ROLLBACK');
    lockReleased = true;
    const state = await constraintSnapshot(runner);
    assert.equal(state[0].presente, true);
    assert.equal(state[0].convalidated, false);
    await setLegacyState(runner);
    return { sqlstate: error.code, elapsedMs: Number(elapsedMs.toFixed(3)), constraint: TARGETS[0].name };
  } finally {
    if (!lockReleased) await locker.query('ROLLBACK').catch(() => {});
    locker.release();
    runner.release();
  }
};

const testIsolatedCatalogMutations = async (client) => {
  await client.query('BEGIN');
  try {
    await client.query(`
      INSERT INTO public.cajas_sesiones (id_sesion_caja, monto_teorico_cierre, marca, monto_apertura)
      VALUES (8001, NULL, 'CATALOG_TEST', 0)
    `);
    const baseline = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8001' });
    assertCoreCatalogValid(baseline.catalogValidation);

    const inactive = [];
    for (const code of ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'OTRO']) {
      await client.query('SAVEPOINT catalog_case');
      await client.query('UPDATE public.cat_metodos_pago SET estado=false WHERE codigo=$1', [code]);
      const changed = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8001' });
      assert.equal(changed.catalogValidation[code].valido, false);
      assert.equal(changed.catalogValidation[code].motivo, 'INACTIVO');
      inactive.push(code);
      await client.query('ROLLBACK TO SAVEPOINT catalog_case');
      await client.query('RELEASE SAVEPOINT catalog_case');
    }

    await client.query('SAVEPOINT classification_case');
    await client.query("UPDATE public.cat_metodos_pago SET afecta_efectivo=true WHERE codigo='TARJETA'");
    const misclassified = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8001' });
    assert.equal(misclassified.catalogValidation.TARJETA.motivo, 'AFECTA_EFECTIVO_INCORRECTO');
    await client.query('ROLLBACK TO SAVEPOINT classification_case');
    await client.query('RELEASE SAVEPOINT classification_case');

    await client.query('SAVEPOINT id_swap_case');
    await client.query("UPDATE public.cat_metodos_pago SET codigo='TEMP_T' WHERE codigo='TARJETA'");
    await client.query("UPDATE public.cat_metodos_pago SET codigo='TARJETA' WHERE codigo='OTRO'");
    await client.query("UPDATE public.cat_metodos_pago SET codigo='OTRO' WHERE codigo='TEMP_T'");
    const swapped = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8001' });
    assert.notEqual(swapped.catalogValidation.TARJETA.id_metodo_pago, baseline.catalogValidation.TARJETA.id_metodo_pago);
    assert.notEqual(swapped.fingerprint.catalogo_tarjeta, baseline.fingerprint.catalogo_tarjeta);
    await client.query('ROLLBACK TO SAVEPOINT id_swap_case');
    await client.query('RELEASE SAVEPOINT id_swap_case');

    const duplicates = [];
    for (const [index, code] of ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'OTRO'].entries()) {
      await client.query('SAVEPOINT duplicate_case');
      const expectedCash = code === 'EFECTIVO';
      await client.query(
        'INSERT INTO public.cat_metodos_pago (id_metodo_pago,codigo,estado,afecta_efectivo) VALUES ($1,$2,true,$3)',
        [100 + index, code, expectedCash]
      );
      const duplicated = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8001' });
      assert.equal(duplicated.catalogValidation[code].coincidencias, 2);
      assert.equal(duplicated.catalogValidation[code].motivo, 'CODIGO_DUPLICADO');
      duplicates.push(code);
      await client.query('ROLLBACK TO SAVEPOINT duplicate_case');
      await client.query('RELEASE SAVEPOINT duplicate_case');
    }
    return { inactive, classificationChanged: true, idSwapDetected: true, duplicates };
  } finally {
    await client.query('ROLLBACK');
  }
};

const testRealReversionAttribution = async (client) => {
  await client.query('BEGIN');
  const scenarioResults = [];
  let scenarioIndex = 0;
  const runScenario = async (name, callback) => {
    scenarioIndex += 1;
    const savepoint = `reversion_case_${scenarioIndex}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await callback();
      scenarioResults.push(name);
    } finally {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
  };
  const insertPayment = (id, invoiceId, sessionId, methodId, amount) => client.query(`
    INSERT INTO public.facturas_cobros
      (id_factura_cobro, monto, id_factura, id_sesion_caja, id_metodo_pago)
    VALUES ($1,$2,$3,$4,$5)
  `, [id, amount, invoiceId, sessionId, methodId]);
  const insertReversion = (id, invoiceId, originalSessionId, amount) => client.query(`
    INSERT INTO public.facturas_reversiones
      (id_reversion,id_factura_original,id_sesion_caja_original,monto_reversado,estado)
    VALUES ($1,$2,$3,$4,'APLICADA')
  `, [id, invoiceId, originalSessionId, amount]);
  const assertFingerprintMatchesMethods = (snapshot) => {
    const sumByMethod = Number((
      [...snapshot.reversionsByCode.values()].reduce((sum, value) => sum + value, 0)
      + snapshot.otrosNoEfectivo.reversiones
    ).toFixed(2));
    assert.equal(sumByMethod, snapshot.fingerprint.total_reversado);
    assert.equal(snapshot.totalReversionesPorMetodo, snapshot.fingerprint.total_reversado);
  };
  try {
    await client.query(`
      INSERT INTO public.cajas_sesiones (id_sesion_caja,monto_teorico_cierre,marca,monto_apertura)
      VALUES (8101,NULL,'REV_A',0),(8102,NULL,'REV_B',0)
    `);

    await runScenario('una_sesion_reversion_parcial', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81001)');
      await insertPayment(81101, 81001, 8101, 1, 100);
      await insertReversion(81201, 81001, 8101, 40);
      const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      assert.equal(snapshot.reversionsByCode.get('EFECTIVO'), 40);
      assert.equal(snapshot.salesNetByCode.get('EFECTIVO'), 60);
      assertFingerprintMatchesMethods(snapshot);
    });

    await runScenario('una_sesion_reversion_total', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81002)');
      await insertPayment(81102, 81002, 8101, 2, 100);
      await insertReversion(81202, 81002, 8101, 100);
      const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      assert.equal(snapshot.reversionsByCode.get('TARJETA'), 100);
      assert.equal(snapshot.salesNetByCode.get('TARJETA'), 0);
      assertFingerprintMatchesMethods(snapshot);
    });

    await runScenario('dos_sesiones_original_definida', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81003)');
      await insertPayment(81103, 81003, 8101, 1, 60);
      await insertPayment(81104, 81003, 8102, 2, 40);
      await insertReversion(81203, 81003, 8101, 50);
      const original = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      const other = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8102' });
      assert.equal(original.reversionsByCode.get('EFECTIVO'), 50);
      assert.equal(other.fingerprint.cantidad_reversiones, 0);
      assertFingerprintMatchesMethods(original);
      assertFingerprintMatchesMethods(other);
    });

    await runScenario('dos_sesiones_original_null_ambigua', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81004)');
      await insertPayment(81105, 81004, 8101, 1, 60);
      await insertPayment(81106, 81004, 8102, 2, 40);
      await insertReversion(81204, 81004, null, 50);
      await assert.rejects(
        loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' }),
        (error) => error.code === 'VENTAS_CAJAS_REVERSION_SESSION_AMBIGUOUS'
          && error.httpStatus === 409
          && error.details.sesiones.join(',') === '8101,8102'
      );
    });

    await runScenario('dos_metodos_misma_sesion', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81005)');
      await insertPayment(81107, 81005, 8101, 1, 60);
      await insertPayment(81108, 81005, 8101, 2, 40);
      await insertReversion(81205, 81005, 8101, 50);
      const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      assert.equal(snapshot.reversionsByCode.get('EFECTIVO'), 30);
      assert.equal(snapshot.reversionsByCode.get('TARJETA'), 20);
      assert.equal([...snapshot.reversionsByCode.values()].reduce((sum, value) => sum + value, 0), 50);
      assertFingerprintMatchesMethods(snapshot);
    });

    await runScenario('redondeo_proporcional', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81006)');
      await insertPayment(81109, 81006, 8101, 2, 33.33);
      await insertPayment(81110, 81006, 8101, 3, 66.66);
      await insertReversion(81206, 81006, 8101, 50);
      const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      assert.equal(snapshot.reversionsByCode.get('TARJETA'), 16.67);
      assert.equal(snapshot.reversionsByCode.get('TRANSFERENCIA'), 33.33);
      assertFingerprintMatchesMethods(snapshot);
    });

    await runScenario('original_definida_sin_cobros_en_sesion', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81009)');
      await insertPayment(81114, 81009, 8102, 2, 100);
      await insertReversion(81209, 81009, 8101, 100);
      await assert.rejects(
        loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' }),
        (error) => error.code === 'VENTAS_CAJAS_REVERSION_SESSION_PAYMENT_MISMATCH'
          && error.httpStatus === 409
          && error.details.id_reversion === '81209'
          && error.details.id_sesion_caja_atribuida === '8101'
          && error.details.sesiones_con_cobros.join(',') === '8102'
      );
    });

    await runScenario('original_definida_cobros_sin_sesion', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81010)');
      await insertPayment(81115, 81010, null, 2, 100);
      await insertReversion(81210, 81010, 8101, 100);
      await assert.rejects(
        loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' }),
        (error) => error.code === 'VENTAS_CAJAS_REVERSION_SESSION_PAYMENT_MISMATCH'
          && error.details.cantidad_cobros_sesion_atribuida === 0
          && error.details.sesiones_con_cobros.length === 0
      );
    });

    await runScenario('reversion_positiva_cobros_total_cero', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81011)');
      await insertPayment(81116, 81011, 8101, 2, 0);
      await insertReversion(81211, 81011, 8101, 100);
      await assert.rejects(
        loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' }),
        (error) => error.code === 'VENTAS_CAJAS_REVERSION_SESSION_PAYMENT_MISMATCH'
          && error.details.motivo === 'TOTAL_COBRADO_SESION_INVALIDO'
          && error.details.cantidad_cobros_sesion_atribuida === 1
      );
    });

    await runScenario('varias_reversiones_una_invalida', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81012),(81013)');
      await insertPayment(81117, 81012, 8101, 1, 100);
      await insertPayment(81118, 81013, 8102, 2, 100);
      await insertReversion(81212, 81012, 8101, 25);
      await insertReversion(81213, 81013, 8101, 25);
      await assert.rejects(
        loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' }),
        (error) => error.code === 'VENTAS_CAJAS_REVERSION_SESSION_PAYMENT_MISMATCH'
          && error.details.inconsistencias.some((item) => String(item.id_reversion) === '81213')
      );
    });

    await runScenario('reversion_monto_cero_sin_impacto', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81014)');
      await insertReversion(81214, 81014, 8101, 0);
      const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      assert.equal(snapshot.fingerprint.total_reversado, 0);
      assertFingerprintMatchesMethods(snapshot);
    });

    await runScenario('reversion_superior_al_neto', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81007)');
      await insertPayment(81111, 81007, 8101, 1, 100);
      await insertReversion(81207, 81007, 8101, 150);
      const snapshot = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      assert.equal(snapshot.salesNetByCode.get('EFECTIVO'), -50);
      assert.equal(snapshot.fingerprint.total_reversado, 150);
      assertFingerprintMatchesMethods(snapshot);
    });

    await runScenario('ninguna_reversion_contabilizada_dos_veces', async () => {
      await client.query('INSERT INTO public.facturas VALUES (81008)');
      await insertPayment(81112, 81008, 8101, 1, 75);
      await insertPayment(81113, 81008, 8102, 2, 25);
      await insertReversion(81208, 81008, 8101, 60);
      const firstSession = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8101' });
      const secondSession = await loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: '8102' });
      assert.equal(firstSession.fingerprint.total_reversado, 60);
      assert.equal(secondSession.fingerprint.total_reversado, 0);
      assert.equal(
        firstSession.fingerprint.total_reversado + secondSession.fingerprint.total_reversado,
        60
      );
      assertFingerprintMatchesMethods(firstSession);
      assertFingerprintMatchesMethods(secondSession);
    });

    return { scenarios: scenarioResults, noDoubleCounting: true, fingerprintMatchesMethods: true };
  } finally {
    await client.query('ROLLBACK');
  }
};

const createSessionNotOpenError = () => {
  const error = new Error('La sesion de caja no se encuentra abierta.');
  error.httpStatus = 409;
  error.code = 'VENTAS_CAJAS_SESSION_NOT_OPEN';
  error.publicMessage = 'La sesion de caja no se encuentra abierta.';
  return error;
};

const ensureIsolatedSessionOpen = async (client, idSesionCaja) => {
  const result = await client.query(
    'SELECT estado_codigo FROM public.cajas_sesiones WHERE id_sesion_caja = $1 FOR UPDATE',
    [idSesionCaja]
  );
  if (result.rows[0]?.estado_codigo !== 'ABIERTA') throw createSessionNotOpenError();
};

const testConcurrentFinancialWrite = async ({ pool, kind, idSesionCaja, writeId }) => {
  const closeClient = await pool.connect();
  const writeClient = await pool.connect();
  const targetTable = kind === 'movimiento' ? 'public.cajas_movimientos' : 'public.cajas_arqueos';
  try {
    await closeClient.query(
      'INSERT INTO public.cajas_sesiones (id_sesion_caja, monto_teorico_cierre, marca, monto_apertura, estado_codigo) VALUES ($1, 0, $2, 0, \'ABIERTA\')',
      [idSesionCaja, `CONCURRENCIA_${kind.toUpperCase()}`]
    );

    await closeClient.query('BEGIN');
    await lockCajaFinancialSession(closeClient, idSesionCaja, 2000);
    await writeClient.query('BEGIN');
    let timeoutError;
    try {
      await lockCajaFinancialSession(writeClient, idSesionCaja, 100);
    } catch (error) {
      timeoutError = mapCajaFinancialLockError(error);
    }
    assert.equal(timeoutError?.httpStatus, 409);
    assert.equal(timeoutError?.code, 'VENTAS_CAJAS_CONCURRENT_OPERATION_RETRY');
    await writeClient.query('ROLLBACK');
    await closeClient.query('ROLLBACK');

    await closeClient.query('BEGIN');
    await lockCajaFinancialSession(closeClient, idSesionCaja, 2000);
    const waitingWrite = (async () => {
      await writeClient.query('BEGIN');
      try {
        await lockCajaFinancialSession(writeClient, idSesionCaja, 2000);
        await ensureIsolatedSessionOpen(writeClient, idSesionCaja);
        if (kind === 'movimiento') {
          await writeClient.query(
            'INSERT INTO public.cajas_movimientos (id_movimiento_caja, id_sesion_caja, id_tipo_movimiento_caja, monto) VALUES ($1, $2, 1, 1)',
            [writeId, idSesionCaja]
          );
        } else {
          await writeClient.query(
            'INSERT INTO public.cajas_arqueos (id_arqueo_caja, id_sesion_caja, monto_teorico, monto_contado) VALUES ($1, $2, 0, 0)',
            [writeId, idSesionCaja]
          );
        }
        await writeClient.query('COMMIT');
        return { status: 201, code: null };
      } catch (error) {
        await writeClient.query('ROLLBACK');
        const mapped = mapCajaFinancialLockError(error);
        return { status: mapped.httpStatus || 500, code: mapped.code || null };
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 100));
    await closeClient.query(
      "UPDATE public.cajas_sesiones SET estado_codigo = 'CERRADA' WHERE id_sesion_caja = $1",
      [idSesionCaja]
    );
    await closeClient.query('COMMIT');
    const response = await waitingWrite;
    assert.equal(response.status, 409);
    assert.equal(response.code, 'VENTAS_CAJAS_SESSION_NOT_OPEN');
    const inserted = await closeClient.query(
      `SELECT COUNT(*)::int AS count FROM ${targetTable} WHERE id_sesion_caja = $1 AND ${kind === 'movimiento' ? 'id_movimiento_caja' : 'id_arqueo_caja'} = $2`,
      [idSesionCaja, writeId]
    );
    assert.equal(inserted.rows[0].count, 0);

    return {
      kind,
      timeoutResponse: { status: timeoutError.httpStatus, code: timeoutError.code },
      postCloseResponse: response,
      insertedAfterClose: 0
    };
  } finally {
    await writeClient.query('ROLLBACK').catch(() => {});
    await closeClient.query('ROLLBACK').catch(() => {});
    await closeClient.query('DELETE FROM public.cajas_movimientos WHERE id_sesion_caja = $1', [idSesionCaja]).catch(() => {});
    await closeClient.query('DELETE FROM public.cajas_arqueos WHERE id_sesion_caja = $1', [idSesionCaja]).catch(() => {});
    await closeClient.query('DELETE FROM public.cajas_sesiones WHERE id_sesion_caja = $1', [idSesionCaja]).catch(() => {});
    writeClient.release();
    closeClient.release();
  }
};

const testOrphanReversionPreflight = async (client, preflightSql) => {
  const orphanSectionIndex = preflightSql.indexOf('-- 12) Reversiones aplicadas completamente huerfanas.');
  assert.ok(orphanSectionIndex >= 0, 'No se encontro la consulta exacta de reversiones huerfanas en PREFLIGHT.');
  const orphanQuery = preflightSql.slice(orphanSectionIndex);
  assert.doesNotMatch(orphanQuery, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|LOCK)\b/i);

  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO public.facturas (id_factura) VALUES (9201), (9202)');
    await client.query(`
      INSERT INTO public.facturas_cobros (id_factura_cobro, monto, id_factura, id_sesion_caja, id_metodo_pago)
      VALUES (9211, 10, 9201, NULL, 1), (9212, 10, 9202, 1, 1)
    `);
    await client.query(`
      INSERT INTO public.facturas_reversiones (
        id_reversion, id_factura_original, id_sesion_caja_original, monto_reversado, estado
      ) VALUES
        (9221, 9201, NULL, 10, 'APLICADA'),
        (9222, 9202, NULL, 10, 'APLICADA')
    `);
    const before = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.facturas_reversiones) AS reversiones,
        (SELECT COUNT(*)::int FROM public.facturas_cobros) AS cobros
    `);
    const result = await client.query(orphanQuery);
    const after = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.facturas_reversiones) AS reversiones,
        (SELECT COUNT(*)::int FROM public.facturas_cobros) AS cobros
    `);
    assert.deepEqual(after.rows, before.rows);
    assert.equal(result.rowCount, 1);
    assert.equal(String(result.rows[0].id_reversion), '9221');
    assert.equal(result.rows[0].motivo, 'REVERSION_SIN_SESION_ATRIBUIBLE');
    assert.equal(result.rows[0].bloqueante_despliegue, true);
    assert.equal(result.rows[0].estado_preflight, 'BLOQUEANTE');
    assert.deepEqual(result.rows[0].sesiones_encontradas, []);
    assert.equal(Number(result.rows[0].cantidad_cobros), 1);
    return { detected: result.rows, noDml: true };
  } finally {
    await client.query('ROLLBACK');
  }
};

export const runPostCloseConsistencyTargetedSuite = async ({
  connectionString = process.env.CAJA_CLOSE_ISOLATED_DATABASE_URL
} = {}) => {
  const expectedTarget = assertIsolatedDatabaseUrlAllowed({ connectionString });
  const pool = createPool(connectionString);
  const client = await pool.connect();
  try {
    const destructiveTarget = await assertIsolatedDatabaseServerAndMarker({
      queryRunner: client,
      expectedTarget
    });
    await initializeSchema(client);
    const metricsBefore = await regressionMetrics(client);
    const [movement, arqueo] = await Promise.all([
      testConcurrentFinancialWrite({ pool, kind: 'movimiento', idSesionCaja: 9101, writeId: 9111 }),
      testConcurrentFinancialWrite({ pool, kind: 'arqueo', idSesionCaja: 9102, writeId: 9112 })
    ]);
    const preflightSql = await readFile(PREFLIGHT_PATH, 'utf8');
    const preflight = await testOrphanReversionPreflight(client, preflightSql);
    const metricsAfter = await regressionMetrics(client);
    assert.deepEqual(metricsAfter, metricsBefore);
    return {
      postgresVersion: (await client.query("SELECT current_setting('server_version') AS version")).rows[0].version,
      destructiveTarget,
      movement,
      arqueo,
      preflight,
      metricsBefore,
      metricsAfter,
      zeroResidues: true
    };
  } finally {
    client.release();
    await pool.end();
  }
};

export const runIsolatedPostgresMigrationSuite = async ({
  connectionString = process.env.CAJA_CLOSE_ISOLATED_DATABASE_URL,
  injectFailureAfterSafe = false,
  leaveSafeApplied = false
} = {}) => {
  // Esta politica se evalua antes de abrir una conexion. Aunque alguien
  // suministre accidentalmente una URL real, el harness no alcanza ningun
  // DDL si el host, project ref, nombre o opt-in destructivo no son validos.
  const expectedTarget = assertIsolatedDatabaseUrlAllowed({ connectionString });
  const pool = createPool(connectionString);
  const client = await pool.connect();
  try {
    // Segunda barrera contra URLs redirigidas, aliases o bases incorrectas:
    // PostgreSQL debe confirmar identidad, direccion y marcador desechable
    // antes de que initializeSchema pueda ejecutar DROP SCHEMA.
    const destructiveTarget = await assertIsolatedDatabaseServerAndMarker({
      queryRunner: client,
      expectedTarget
    });
    const [safeSql, rollbackSql] = await Promise.all([
      readFile(SAFE_PATH, 'utf8'),
      readFile(ROLLBACK_PATH, 'utf8')
    ]);
    await initializeSchema(client);

    const attnums = await client.query(`
      SELECT attname, attnum
      FROM pg_attribute
      WHERE attrelid='public.cajas_arqueos'::regclass
        AND attname IN ('monto_teorico','monto_contado')
      ORDER BY attnum
    `);
    assert.deepEqual(attnums.rows.map((row) => [row.attname, Number(row.attnum)]), [
      ['monto_teorico', 7],
      ['monto_contado', 8]
    ]);

    const metricsBefore = await regressionMetrics(client);
    const countedBefore = await countedConstraintSnapshot(client);
    const legacyBefore = await constraintSnapshot(client);
    assert.ok(legacyBefore.every((row) => row.presente && row.convalidated));

    await runMultiStatement(client, safeSql);
    await assertSafeState(client);
    await runMultiStatement(client, safeSql);
    await assertSafeState(client);
    assert.deepEqual(await countedConstraintSnapshot(client), countedBefore);
    assert.deepEqual(await regressionMetrics(client), metricsBefore);

    await restoreConstraintSnapshot(client, legacyBefore);
    const lock = await testNowaitLock(pool, safeSql);
    const wrongDefinitions = await testWrongTargetDefinitions(client, safeSql);
    const combinations = await testEightCombinations(client, safeSql);
    const rollback = await testRollback(client, rollbackSql);
    const rollbackValidateLock = await testRollbackValidateLock(pool, rollbackSql);
    const injectedFailure = await testInjectedFailureRestoration(client, safeSql);
    const catalogMutations = await testIsolatedCatalogMutations(client);
    const reversionAttribution = await testRealReversionAttribution(client);

    if (injectFailureAfterSafe) {
      assert.equal(injectedFailure.deliberateFailureObserved, true);
    }
    if (leaveSafeApplied) {
      await runMultiStatement(client, safeSql);
      await assertSafeState(client);
    } else {
      await restoreConstraintSnapshot(client, legacyBefore);
    }

    assert.deepEqual(await countedConstraintSnapshot(client), countedBefore);
    assert.deepEqual(await regressionMetrics(client), metricsBefore);

    return {
      postgresVersion: (await client.query("SELECT current_setting('server_version') AS version")).rows[0].version,
      destructiveTarget,
      attnums: Object.fromEntries(attnums.rows.map((row) => [row.attname, Number(row.attnum)])),
      safeLegacy: true,
      safeRepeated: true,
      safeOnSafe: true,
      lock,
      wrongDefinitions,
      combinations,
      rollback,
      rollbackValidateLock,
      injectedFailure,
      catalogMutations,
      reversionAttribution,
      zeroBusinessDml: true,
      metricsBefore,
      metricsAfter: await regressionMetrics(client)
    };
  } finally {
    client.release();
    await pool.end();
  }
};

const isDirectExecution = process.argv[1]
  && new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url;

if (isDirectExecution) {
  const result = process.argv.includes('--post-close-consistency-only')
    ? await runPostCloseConsistencyTargetedSuite()
    : await runIsolatedPostgresMigrationSuite({
        injectFailureAfterSafe: process.argv.includes('--inject-failure-after-safe'),
        leaveSafeApplied: process.argv.includes('--leave-safe-applied')
      });
  console.log(JSON.stringify(result, null, 2));
}
