import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlDir = path.join(repoRoot, 'sql');

const readSql = (name) => fs.readFileSync(path.join(sqlDir, name), 'utf8');

const tipoVerify = readSql('20260728_trabajos_impresion_tipo_reversion_VERIFY.sql');
const idVerify = readSql('20260728_trabajos_impresion_id_reversion_VERIFY.sql');
const snapshotVerify = readSql('20260729_caja_close_email_payload_snapshot_VERIFY.sql');
const pendingVerifies = [tipoVerify, idVerify, snapshotVerify];

const normalizeCheckExpression = (expression) => expression
  .toLowerCase()
  .replace(/::\s*(?:text|character varying)(?:\(\d+\))?(?:\[\])?/g, '')
  .replace(/[\s()]/g, '');

const toSqlLiteral = (value) => `'${value.replace(/'/g, "''")}'`;

test('UNION de constraints usa subconsulta y ORDER BY sobre aliases textuales', () => {
  assert.doesNotMatch(tipoVerify, /ORDER\s+BY\s+tabla\s*::\s*text/i);
  assert.match(
    tipoVerify,
    /SELECT\s+tabla,\s*conname,\s*convalidated\s+FROM\s*\([\s\S]*UNION\s+ALL[\s\S]*\)\s+AS\s+checks\s+ORDER\s+BY\s+tabla,\s*conname;/i
  );
  assert.match(tipoVerify, /conrelid::regclass::text AS tabla/g);
});

test('VERIFY de tipo documental valida estrictamente los cuatro CHECK canonicos', () => {
  const trabajoTipo = normalizeCheckExpression(`
    tipo_documento::text = ANY (
      ARRAY[
        'factura'::character varying,
        'comanda'::character varying,
        'caja'::character varying,
        'reversion'::character varying
      ]::text[]
    )
  `);
  const documentoTipo = normalizeCheckExpression(`
    tipo_documento = ANY (
      ARRAY['factura'::text, 'comanda'::text, 'reversion'::text]
    )
  `);
  const documentoFormato = normalizeCheckExpression(`
    (tipo_documento = 'factura'::text AND formato = 'pdf'::text AND flavor = 'base64'::text)
    OR (tipo_documento = 'reversion'::text AND formato = 'pdf'::text AND flavor = 'base64'::text)
    OR (tipo_documento = 'comanda'::text AND formato = 'html'::text AND flavor = 'plain'::text)
  `);
  const documentoBytes = normalizeCheckExpression(`
    content_bytes > 0
    AND octet_length(contenido) = content_bytes
    AND (
      (tipo_documento = 'factura'::text AND content_bytes <= 2097152)
      OR (tipo_documento = 'reversion'::text AND content_bytes <= 2097152)
      OR (tipo_documento = 'comanda'::text AND content_bytes <= 262144)
    )
  `);

  for (const canonical of [trabajoTipo, documentoTipo, documentoFormato, documentoBytes]) {
    assert.ok(tipoVerify.includes(toSqlLiteral(canonical)), `Falta canonica: ${canonical}`);
  }

  assert.match(tipoVerify, /v_validada IS NOT TRUE/g);
  assert.match(tipoVerify, /RAISE EXCEPTION/g);
  assert.match(tipoVerify, /ARRAY\['0', '2097152', '262144'\]::text\[\]/);
  assert.match(
    tipoVerify,
    /VERIFY_OK: los CHECK de impresion y documentos de reversion son validos y estan validados/
  );
});

test('VERIFY pendientes abortan ante columna, constraint, indice o conteos invalidos', () => {
  assert.match(idVerify, /VERIFY_FAILED_TRABAJOS_ID_REVERSION/);
  assert.match(idVerify, /fk_trabajos_impresion_reversion/);
  assert.match(idVerify, /idx_trabajos_impresion_reversion/);
  assert.match(idVerify, /v_total IS DISTINCT FROM 201/);
  assert.match(idVerify, /v_con_reversion IS DISTINCT FROM 0/);
  assert.match(idVerify, /RAISE EXCEPTION/);

  assert.match(snapshotVerify, /VERIFY_FAILED_PAYLOAD_SNAPSHOT/);
  assert.match(snapshotVerify, /v_tipo IS DISTINCT FROM 'jsonb'/);
  assert.match(snapshotVerify, /v_total IS DISTINCT FROM 9/);
  assert.match(snapshotVerify, /v_con_snapshot IS DISTINCT FROM 0/);
  assert.match(snapshotVerify, /RAISE EXCEPTION/);
});

test('VERIFY pendientes no repiten patrones PostgreSQL invalidos', () => {
  for (const sql of pendingVerifies) {
    assert.doesNotMatch(sql, /ORDER\s+BY\s+\w+\s*::/i);
    assert.doesNotMatch(sql, /\bm\s*\[\s*0\s*\]|\barray\s*\[\s*0\s*\]|resultado_regexp\s*\[\s*0\s*\]/i);
  }

  assert.doesNotMatch(
    idVerify,
    /to_regclass\('public\.trabajos_impresion_documentos'\)::regclass/i
  );
});

test('los tres VERIFY continúan exclusivamente read-only', () => {
  for (const sql of pendingVerifies) {
    const mutatingLines = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--'))
      .filter((line) => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(line));

    assert.deepEqual(mutatingLines, []);
  }
});
