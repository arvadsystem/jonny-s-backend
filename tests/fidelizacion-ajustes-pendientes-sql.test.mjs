import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlDir = path.join(repoRoot, 'sql');
const ajustesSafePath = path.join(sqlDir, '20260728_fidelizacion_ajustes_pendientes_SAFE.sql');
const ajustesVerifyPath = path.join(sqlDir, '20260728_fidelizacion_ajustes_pendientes_VERIFY.sql');
const impresionSafePath = path.join(sqlDir, '20260728_trabajos_impresion_tipo_reversion_SAFE.sql');

const ajustesSafe = fs.readFileSync(ajustesSafePath, 'utf8');
const ajustesVerify = fs.readFileSync(ajustesVerifyPath, 'utf8');
const impresionSafe = fs.readFileSync(impresionSafePath, 'utf8');

const canonical = [
  "estado='pendiente'andpuntos_recuperados=0andpuntos_pendientes=puntos_objetivo",
  "orestado='parcialmente_recuperado'andpuntos_recuperados>0andpuntos_pendientes>0",
  "orestado='recuperado'andpuntos_recuperados=puntos_objetivoandpuntos_pendientes=0"
].join('');

const normalizeCheckExpression = (expression) => expression
  .toLowerCase()
  .replace(/::\s*(?:text|character varying)(?:\(\d+\))?/g, '')
  .replace(/[\s()]/g, '');

const readSqlCanonical = (sql) => {
  const match = sql.match(/v_canonica text := '((?:''|[^'])*)';/);
  assert.ok(match, 'El SQL debe declarar v_canonica');
  return match[1].replace(/''/g, "'");
};

const postgres17Expression = `
  estado::text = 'PENDIENTE'::text
  AND puntos_recuperados = 0
  AND puntos_pendientes = puntos_objetivo
  OR estado::text = 'PARCIALMENTE_RECUPERADO'::text
  AND puntos_recuperados > 0
  AND puntos_pendientes > 0
  OR estado::text = 'RECUPERADO'::text
  AND puntos_recuperados = puntos_objetivo
  AND puntos_pendientes = 0
`;

test('SQL de estas fases no usa indices cero para arreglos de regexp_matches', () => {
  const sqlFiles = fs.readdirSync(sqlDir).filter((name) => name.endsWith('.sql'));
  const offenders = sqlFiles.filter((name) => {
    const content = fs.readFileSync(path.join(sqlDir, name), 'utf8');
    return /\bm\s*\[\s*0\s*\]|\barray\s*\[\s*0\s*\]|resultado_regexp\s*\[\s*0\s*\]/i.test(content);
  });

  assert.deepEqual(offenders, []);
  assert.match(ajustesSafe, /array_agg\(DISTINCT m\[1\] ORDER BY m\[1\]\)/);
  assert.match(impresionSafe, /array_agg\(DISTINCT m\[1\] ORDER BY m\[1\]\)/);
});

test('acepta la expresion real de PostgreSQL 17 y su normalizacion es idempotente', () => {
  const normalized = normalizeCheckExpression(postgres17Expression);

  assert.equal(normalized, canonical);
  assert.equal(readSqlCanonical(ajustesSafe), normalized);
  assert.equal(readSqlCanonical(ajustesVerify), normalized);
  assert.equal(normalizeCheckExpression(normalizeCheckExpression(postgres17Expression)), canonical);
});

test('rechaza expresiones con rama faltante, operador incorrecto o estado adicional', () => {
  const missingBranch = postgres17Expression.replace(
    /OR estado::text = 'RECUPERADO'::text[\s\S]*$/,
    ''
  );
  const wrongOperator = postgres17Expression.replace('puntos_recuperados > 0', 'puntos_recuperados >= 0');
  const additionalState = `${postgres17Expression} OR estado = 'CANCELADO'`;

  assert.notEqual(normalizeCheckExpression(missingBranch), canonical);
  assert.notEqual(normalizeCheckExpression(wrongOperator), canonical);
  assert.notEqual(normalizeCheckExpression(additionalState), canonical);
});

test('rechaza una condicion adicional aunque conserve estados y numeros canonicos', () => {
  const additionalCondition = postgres17Expression.replace(
    "estado::text = 'PENDIENTE'::text",
    "estado::text = 'PENDIENTE'::text AND id_cliente IS NOT NULL"
  );

  assert.notEqual(normalizeCheckExpression(additionalCondition), canonical);
});

test('SAFE y VERIFY comparan la expresion completa obtenida con pg_get_expr', () => {
  for (const sql of [ajustesSafe, ajustesVerify]) {
    assert.match(sql, /pg_get_expr\(conbin,\s*conrelid,\s*true\)/);
    assert.match(sql, /v_normalizada IS DISTINCT FROM v_canonica/);
  }
  assert.match(ajustesVerify, /v_conteo IS DISTINCT FROM 1/);
  assert.match(ajustesVerify, /v_validada IS NOT TRUE/);
  assert.match(ajustesVerify, /RAISE EXCEPTION/);
  assert.match(ajustesSafe, /regexp_matches\(v_expresion,\s*'\\y\(\\d\+\)\\y',\s*'g'\)/);
  assert.match(ajustesSafe, /v_numeros IS DISTINCT FROM ARRAY\['0'\]::text\[\]/);
});

test('SAFE conserva convergencia idempotente y no contiene reparacion destructiva', () => {
  assert.match(ajustesSafe, /CREATE TABLE IF NOT EXISTS public\.fidelizacion_ajustes_pendientes/);
  assert.match(ajustesSafe, /IF v_definicion IS NULL THEN[\s\S]*ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado_coherente/);

  const executableDestructive = ajustesSafe
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .filter((line) => /^\s*(DROP|DELETE)\b/i.test(line));

  assert.deepEqual(executableDestructive, []);
});
