'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const allowedFile = path.join(repoRoot, 'config', 'db-connection.js');
const selfFile = __filename;

const ignoredDirectories = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage'
]);

const allowedExtensions = new Set(['.js', '.cjs', '.mjs']);

const forbiddenPatterns = [
  { label: "import pg from 'pg'", regex: /\bimport\s+pg\s+from\s+['"]pg['"]/ },
  { label: "import { Pool } from 'pg'", regex: /\bimport\s*\{[^}]*\bPool\b[^}]*\}\s*from\s+['"]pg['"]/ },
  { label: "import { Client } from 'pg'", regex: /\bimport\s*\{[^}]*\bClient\b[^}]*\}\s*from\s+['"]pg['"]/ },
  { label: "require('pg')", regex: /\brequire\s*\(\s*['"]pg['"]\s*\)/ },
  { label: 'new Pool(', regex: /\bnew\s+Pool\s*\(/ },
  { label: 'new Client(', regex: /\bnew\s+Client\s*\(/ },
  { label: 'new pg.Pool(', regex: /\bnew\s+pg\.Pool\s*\(/ },
  { label: 'new pg.Client(', regex: /\bnew\s+pg\.Client\s*\(/ },
  { label: 'Pool(', regex: /(?<![\w.])Pool\s*\(/ },
  { label: 'Client(', regex: /(?<![\w.])Client\s*\(/ }
];

const toRelativePath = (filePath) => path.relative(repoRoot, filePath).replace(/\\/g, '/');

const isIgnoredFile = (filePath) => {
  if (filePath === allowedFile || filePath === selfFile) {
    return true;
  }

  if (path.extname(filePath) === '.map') {
    return true;
  }

  return !allowedExtensions.has(path.extname(filePath));
};

const isBinaryBuffer = (buffer) => buffer.includes(0);

const sanitizeLine = (line) => {
  const trimmed = line.trim().slice(0, 180);
  return trimmed
    .replace(/(password\s*[:=]\s*)['"`][^'"`]*['"`]/gi, '$1[redacted]')
    .replace(/(connectionString\s*[:=]\s*)['"`][^'"`]*['"`]/gi, '$1[redacted]')
    .replace(/(DATABASE_URL\s*[:=]\s*)['"`][^'"`]*['"`]/gi, '$1[redacted]');
};

const collectFiles = (directory, files = []) => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collectFiles(entryPath, files);
      }
      continue;
    }

    if (entry.isFile() && !isIgnoredFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
};

const auditFile = (filePath) => {
  const buffer = fs.readFileSync(filePath);

  if (isBinaryBuffer(buffer)) {
    return [];
  }

  const content = buffer.toString('utf8');
  const lines = content.split(/\r?\n/);
  const findings = [];

  lines.forEach((line, index) => {
    for (const pattern of forbiddenPatterns) {
      if (pattern.regex.test(line)) {
        findings.push({
          file: toRelativePath(filePath),
          line: index + 1,
          pattern: pattern.label,
          fragment: sanitizeLine(line)
        });
      }
    }
  });

  return findings;
};

const findings = collectFiles(repoRoot).flatMap(auditFile);

if (findings.length > 0) {
  console.error('ERROR: se encontraron accesos directos no autorizados a pg/Pool/Client.');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} | ${finding.pattern} | ${finding.fragment}`);
  }
  process.exit(1);
}

console.log('OK: no se encontraron accesos directos no autorizados a pg/Pool/Client.');
