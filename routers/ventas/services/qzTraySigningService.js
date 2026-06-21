import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const CERT_PATH_ENV_KEYS = ['QZ_TRAY_CERTIFICATE_PATH', 'QZ_CERTIFICATE_PATH', 'QZ_CERT_PATH'];
const CERT_TEXT_ENV_KEYS = ['QZ_TRAY_CERTIFICATE_TEXT', 'QZ_CERTIFICATE_TEXT'];
const KEY_PATH_ENV_KEYS = ['QZ_TRAY_PRIVATE_KEY_PATH', 'QZ_PRIVATE_KEY_PATH'];
const KEY_TEXT_ENV_KEYS = ['QZ_TRAY_PRIVATE_KEY_PEM', 'QZ_PRIVATE_KEY_PEM'];

let certificateCache = null;
let privateKeyCache = null;

const readFirstEnvValue = (keys = []) => {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
};

const readTextFromEnvOrFile = async ({
  textEnvKeys = [],
  pathEnvKeys = []
}) => {
  const inlineText = readFirstEnvValue(textEnvKeys);
  if (inlineText) return inlineText;

  const filePath = readFirstEnvValue(pathEnvKeys);
  if (!filePath) return '';

  return fs.readFile(filePath, 'utf8');
};

export const getQzCertificateText = async () => {
  if (certificateCache !== null) return certificateCache;
  const text = await readTextFromEnvOrFile({
    textEnvKeys: CERT_TEXT_ENV_KEYS,
    pathEnvKeys: CERT_PATH_ENV_KEYS
  });
  certificateCache = String(text || '').trim();
  return certificateCache;
};

export const getQzPrivateKeyText = async () => {
  if (privateKeyCache !== null) return privateKeyCache;
  const text = await readTextFromEnvOrFile({
    textEnvKeys: KEY_TEXT_ENV_KEYS,
    pathEnvKeys: KEY_PATH_ENV_KEYS
  });
  privateKeyCache = String(text || '').trim();
  return privateKeyCache;
};

export const hasQzSigningConfigured = async () => {
  const [certificate, privateKey] = await Promise.all([
    getQzCertificateText(),
    getQzPrivateKeyText()
  ]);
  return Boolean(certificate && privateKey);
};

export const getQzSignatureAlgorithm = () => {
  const raw = String(process.env.QZ_SIGNATURE_ALGORITHM || 'SHA512').trim().toUpperCase();
  if (!raw) return 'SHA512';
  return raw.startsWith('RSA-') ? raw : `RSA-${raw}`;
};

export const signQzMessage = async (requestToSign) => {
  const privateKey = await getQzPrivateKeyText();
  if (!privateKey) {
    const error = new Error('QZ_SIGNING_NOT_CONFIGURED');
    error.code = 'QZ_SIGNING_NOT_CONFIGURED';
    throw error;
  }

  const payload = String(requestToSign || '');
  if (!payload) {
    const error = new Error('QZ_SIGN_REQUEST_INVALID');
    error.code = 'QZ_SIGN_REQUEST_INVALID';
    throw error;
  }

  const signer = crypto.createSign(getQzSignatureAlgorithm());
  signer.update(payload);
  signer.end();

  return signer.sign(privateKey, 'base64');
};
