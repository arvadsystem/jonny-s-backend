import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import pg from 'pg';

const SAFE_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_SAFE.sql', import.meta.url);
const ROLLBACK_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_ROLLBACK.sql', import.meta.url);

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

    CREATE TABLE public.cajas_sesiones (
      id_sesion_caja bigint PRIMARY KEY,
      monto_teorico_cierre numeric(14,2),
      marca text,
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

    CREATE TABLE public.facturas (id_factura bigint PRIMARY KEY);
    CREATE TABLE public.detalle_facturas (
      id_detalle_factura bigint PRIMARY KEY,
      total_detalle numeric(14,2) NOT NULL
    );
    CREATE TABLE public.facturas_cobros (
      id_factura_cobro bigint PRIMARY KEY,
      monto numeric(14,2) NOT NULL
    );
    CREATE TABLE public.pedidos (id_pedido bigint PRIMARY KEY);
    CREATE TABLE public.cajas_movimientos (id_movimiento_caja bigint PRIMARY KEY);

    INSERT INTO public.cajas_sesiones VALUES (1, 10, 'BASE');
    INSERT INTO public.cajas_cierres VALUES (1, 10, 'BASE');
    INSERT INTO public.cajas_arqueos (
      id_arqueo_caja, id_sesion_caja, id_caja, id_sucursal, id_usuario,
      fecha_registro, monto_teorico, monto_contado
    ) VALUES (1, 1, 1, 1, 1, NOW(), 10, 10);
    INSERT INTO public.facturas VALUES (1);
    INSERT INTO public.detalle_facturas VALUES (1, 123.45);
    INSERT INTO public.facturas_cobros VALUES (1, 123.45);
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

export const runIsolatedPostgresMigrationSuite = async ({
  connectionString = process.env.CAJA_CLOSE_ISOLATED_DATABASE_URL,
  injectFailureAfterSafe = false,
  leaveSafeApplied = false
} = {}) => {
  if (!connectionString) throw new Error('CAJA_CLOSE_ISOLATED_DATABASE_URL es obligatorio.');
  const pool = createPool(connectionString);
  const client = await pool.connect();
  try {
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
    const injectedFailure = await testInjectedFailureRestoration(client, safeSql);

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
      attnums: Object.fromEntries(attnums.rows.map((row) => [row.attname, Number(row.attnum)])),
      safeLegacy: true,
      safeRepeated: true,
      safeOnSafe: true,
      lock,
      wrongDefinitions,
      combinations,
      rollback,
      injectedFailure,
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
  const result = await runIsolatedPostgresMigrationSuite({
    injectFailureAfterSafe: process.argv.includes('--inject-failure-after-safe'),
    leaveSafeApplied: process.argv.includes('--leave-safe-applied')
  });
  console.log(JSON.stringify(result, null, 2));
}
