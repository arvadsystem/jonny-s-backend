import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlDir = path.join(repoRoot, 'sql');

const readSql = (name) => fs.readFileSync(path.join(sqlDir, name), 'utf8');

const compensacionSafe = readSql('20260729_fidelizacion_catalogos_compensacion_SAFE.sql');
const compensacionVerify = readSql('20260729_fidelizacion_catalogos_compensacion_VERIFY.sql');
const reversoSafe = readSql('20260728_fidelizacion_catalogos_reverso_SAFE.sql');
const reversoVerify = readSql('20260728_fidelizacion_catalogos_reverso_VERIFY.sql');

const catalogSql = [
  compensacionSafe,
  compensacionVerify,
  reversoSafe,
  reversoVerify
];

const stripSqlComments = (source) => {
  let result = '';
  let state = 'code';

  for (let index = 0; index < source.length;) {
    if (state === 'code' && source.startsWith('--', index)) {
      state = 'line-comment';
      result += '  ';
      index += 2;
      continue;
    }

    if (state === 'code' && source.startsWith('/*', index)) {
      state = 'block-comment';
      result += '  ';
      index += 2;
      continue;
    }

    if (state === 'line-comment') {
      if (source[index] === '\n') {
        state = 'code';
        result += '\n';
      } else {
        result += ' ';
      }
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (source.startsWith('*/', index)) {
        state = 'code';
        result += '  ';
        index += 2;
      } else {
        result += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    result += source[index];
    index += 1;
  }

  return result;
};

const executableSqlLiterals = (source) => {
  const withoutComments = stripSqlComments(source);
  return [...withoutComments.matchAll(/(?<prefix>U&|E)?'(?<body>(?:''|[^'])*)'/g)];
};

const decodeUnicodeEscapeBody = (body) => body
  .replace(/\\([0-9a-f]{4,6})/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/''/g, "'");

const expectedCompensacionValues = [
  'Compensación',
  'Aplicación de puntos acumulados a ajustes pendientes de reversión.',
  'Compensación aplicada a una deuda pendiente originada por reversión.'
];

const expectedReversoValues = [
  'Reversión de un movimiento previo.',
  'Movimiento generado por reversión de acumulación por factura.'
];

test('catalogos canonicos usan literales U& ASCII y conservan el Unicode exacto', () => {
  const compensacionUnicodeValues = [
    ...executableSqlLiterals(compensacionSafe),
    ...executableSqlLiterals(compensacionVerify)
  ]
    .filter((match) => match.groups.prefix === 'U&')
    .map((match) => decodeUnicodeEscapeBody(match.groups.body));

  const reversoUnicodeValues = [
    ...executableSqlLiterals(reversoSafe),
    ...executableSqlLiterals(reversoVerify)
  ]
    .filter((match) => match.groups.prefix === 'U&')
    .map((match) => decodeUnicodeEscapeBody(match.groups.body));

  for (const expected of expectedCompensacionValues) {
    assert.ok(compensacionUnicodeValues.includes(expected), `Falta el valor canonico: ${expected}`);
  }

  for (const expected of expectedReversoValues) {
    assert.ok(reversoUnicodeValues.includes(expected), `Falta el valor canonico: ${expected}`);
  }

  assert.match(compensacionSafe, /U&'Compensaci\\00F3n'/);
  assert.match(
    compensacionSafe,
    /U&'Aplicaci\\00F3n de puntos acumulados a ajustes pendientes de reversi\\00F3n\.'/
  );
  assert.match(
    compensacionVerify,
    /U&'Compensaci\\00F3n aplicada a una deuda pendiente originada por reversi\\00F3n\.'/
  );
});

test('literales ejecutables de catalogos son transportables completamente como ASCII', () => {
  for (const sql of catalogSql) {
    const nonAsciiLiterals = executableSqlLiterals(sql)
      .filter((match) => /[^\x00-\x7f]/.test(match.groups.body))
      .map((match) => match[0]);

    assert.deepEqual(nonAsciiLiterals, []);
  }
});

test('SAFE y VERIFY no contienen secuencias mojibake conocidas', () => {
  const mojibake = /\u00c3[\u00a1\u00a9\u00ad\u00b3\u00ba\u00b1\u00bc]/u;

  for (const sql of catalogSql) {
    assert.doesNotMatch(sql, mojibake);
  }
});

test('semantica de COMPENSACION y AJUSTE_PENDIENTE permanece intacta', () => {
  for (const sql of [compensacionSafe, compensacionVerify]) {
    assert.match(sql, /v_codigo IS DISTINCT FROM 'COMPENSACION'/);
    assert.match(sql, /v_nombre IS DISTINCT FROM U&'Compensaci\\00F3n'/);
    assert.match(sql, /v_signo_operacion IS DISTINCT FROM -1/);
    assert.match(sql, /v_afecta_saldo IS DISTINCT FROM true/);
    assert.match(sql, /v_codigo IS DISTINCT FROM 'AJUSTE_PENDIENTE'/);
    assert.match(sql, /v_nombre IS DISTINCT FROM 'Ajuste pendiente'/);
  }

  assert.match(compensacionSafe, /v_activo IS NOT TRUE/g);
  assert.match(compensacionVerify, /v_estado IS NOT TRUE/g);

  assert.match(
    compensacionSafe,
    /VALUES\s*\(\s*'COMPENSACION',\s*U&'Compensaci\\00F3n',[\s\S]*?true,\s*-1,\s*true\s*\)/m
  );
  assert.match(
    compensacionSafe,
    /VALUES\s*\(\s*'AJUSTE_PENDIENTE',\s*'Ajuste pendiente',\s*U&'Compensaci\\00F3n aplicada[\s\S]*?true\s*\)/m
  );
});

test('VERIFY permanece read-only y SAFE conserva idempotencia sin reparacion destructiva', () => {
  for (const verify of [compensacionVerify, reversoVerify]) {
    const executable = stripSqlComments(verify);
    assert.doesNotMatch(executable, /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/im);
    assert.match(executable, /RAISE EXCEPTION/);
  }

  for (const safe of [compensacionSafe, reversoSafe]) {
    const executable = stripSqlComments(safe);
    assert.doesNotMatch(executable, /^\s*(UPDATE|DELETE|DROP)\b/im);
    assert.match(executable, /IF v_coincidencias = 1 THEN/);
    assert.match(executable, /ELSE[\s\S]*INSERT INTO public\.cat_fidelizacion_/);
    assert.match(executable, /no-op/);
  }
});
