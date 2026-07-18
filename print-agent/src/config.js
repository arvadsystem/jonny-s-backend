import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const required = (env, key) => {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`CONFIG_REQUIRED:${key}`);
  return value;
};
const integer = (env, key, fallback, min, max) => {
  const value = Number.parseInt(String(env[key] ?? fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`CONFIG_INVALID:${key}`);
  return value;
};

export const normalizeQzHost = (value) => {
  const rawHost = String(value ?? '').trim().replace(/\.$/, '');
  const host = domainToASCII(rawHost).toLowerCase();
  const labels = host.split('.');
  const validLabels = labels.every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9-]+$/.test(label)
    && !label.startsWith('-')
    && !label.endsWith('-')
  ));
  if (!host || host.length > 253 || net.isIP(host) !== 0 || !validLabels) {
    throw new Error('CONFIG_INVALID:QZ_HOST');
  }
  return host;
};

export const validateQzCaCertificate = ({ certificateText, host, X509CertificateImpl = crypto.X509Certificate }) => {
  if (/PRIVATE KEY/.test(String(certificateText || ''))) {
    throw new Error('CONFIG_INVALID:QZ_CA_CERT_MUST_NOT_CONTAIN_PRIVATE_KEY');
  }
  let certificate;
  try { certificate = new X509CertificateImpl(certificateText); } catch { throw new Error('CONFIG_INVALID:QZ_CA_CERT_PATH'); }
  if (!certificate.checkHost(normalizeQzHost(host))) throw new Error('CONFIG_INVALID:QZ_CA_CERT_HOSTNAME');
  return certificate;
};

export const loadConfig = (
  env = process.env,
  { fileSystem = fs, X509CertificateImpl = crypto.X509Certificate } = {}
) => {
  const apiBaseUrl = required(env, 'API_BASE_URL').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(apiBaseUrl) && !/^https:\/\/localhost(?::\d+)?$/i.test(apiBaseUrl)) throw new Error('CONFIG_INVALID:API_BASE_URL_HTTPS_REQUIRED');
  const qzHost = normalizeQzHost(env.QZ_HOST ?? 'localhost');
  let printerMap;
  try { printerMap = JSON.parse(required(env, 'PRINTER_MAP_JSON')); } catch { throw new Error('CONFIG_INVALID:PRINTER_MAP_JSON'); }
  if (!printerMap || typeof printerMap !== 'object' || Array.isArray(printerMap)) throw new Error('CONFIG_INVALID:PRINTER_MAP_JSON');
  for (const [logical, physical] of Object.entries(printerMap)) {
    if (!['factura', 'cocina', 'caja'].includes(logical) || !String(physical || '').trim()) throw new Error('CONFIG_INVALID:PRINTER_MAP_JSON');
  }
  const caPathValue = String(env.QZ_CA_CERT_PATH || env.NODE_EXTRA_CA_CERTS || '').trim();
  const qzCaCertPath = caPathValue ? path.resolve(caPathValue) : null;
  if (qzHost !== 'localhost' && !qzCaCertPath) throw new Error('CONFIG_REQUIRED:QZ_CA_CERT_PATH');
  if (qzCaCertPath) {
    if (!fileSystem.existsSync(qzCaCertPath) || !fileSystem.statSync(qzCaCertPath).isFile()) throw new Error('CONFIG_INVALID:QZ_CA_CERT_PATH');
    const caText = fileSystem.readFileSync(qzCaCertPath, 'utf8');
    validateQzCaCertificate({ certificateText: caText, host: qzHost, X509CertificateImpl });
  }
  return {
    apiBaseUrl,
    agentId: required(env, 'PRINT_AGENT_ID'),
    token: required(env, 'PRINT_AGENT_TOKEN'),
    branchId: integer(env, 'BRANCH_ID', null, 1, 2147483647),
    qzHost,
    qzSecurePort: integer(env, 'QZ_SECURE_PORT', 8181, 1, 65535),
    pollIntervalMs: integer(env, 'POLL_INTERVAL_MS', 3000, 500, 60000),
    heartbeatIntervalMs: integer(env, 'HEARTBEAT_INTERVAL_MS', 30000, 5000, 300000),
    leaseSeconds: integer(env, 'LEASE_SECONDS', 90, 30, 600),
    printerMap,
    logDir: String(env.LOG_DIR || './logs').trim(),
    stateFile: path.resolve(String(env.PRINT_STATE_FILE || './data/print-state.json').trim()),
    qzCaCertPath
  };
};
