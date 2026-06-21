import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const CERT_PATH_ENV_KEYS = ['QZ_TRAY_CERTIFICATE_PATH', 'QZ_CERTIFICATE_PATH', 'QZ_CERT_PATH'];
const CERT_TEXT_ENV_KEYS = ['QZ_TRAY_CERTIFICATE_TEXT', 'QZ_CERTIFICATE_TEXT'];
const KEY_PATH_ENV_KEYS = ['QZ_TRAY_PRIVATE_KEY_PATH', 'QZ_PRIVATE_KEY_PATH'];
const KEY_TEXT_ENV_KEYS = ['QZ_TRAY_PRIVATE_KEY_PEM', 'QZ_PRIVATE_KEY_PEM'];

const CONFIG_ERROR_CODES = new Set([
  'QZ_CERTIFICATE_NOT_CONFIGURED',
  'QZ_PRIVATE_KEY_NOT_CONFIGURED',
  'QZ_CERTIFICATE_READ_ERROR',
  'QZ_PRIVATE_KEY_READ_ERROR',
  'QZ_SIGNING_PERMISSION_DENIED',
  'QZ_CERTIFICATE_INVALID',
  'QZ_PRIVATE_KEY_INVALID',
  'QZ_CERTIFICATE_KEY_MISMATCH',
  'QZ_SIGNING_NOT_CONFIGURED'
]);

const createQzError = (code, cause = null) => {
  const error = new Error(code);
  error.code = code;
  error.expose = false;
  if (CONFIG_ERROR_CODES.has(code)) error.httpStatus = 503;
  if (cause) error.cause = cause;
  return error;
};

const readFirstEnvValue = (keys = []) => {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
};

const normalizePemText = (value = '') => {
  const text = String(value || '').replace(/^\uFEFF/, '');
  const withRealLineBreaks = text.includes('\\n') && !text.includes('\n')
    ? text.replace(/\\n/g, '\n')
    : text;
  return withRealLineBreaks.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
};

const isPermissionDenied = (error) => ['EACCES', 'EPERM'].includes(error?.code);

const readTextFromEnvOrFile = async ({
  textEnvKeys = [],
  pathEnvKeys = [],
  notConfiguredCode,
  readErrorCode
}) => {
  const inlineText = readFirstEnvValue(textEnvKeys);
  if (inlineText) return normalizePemText(inlineText);

  const filePath = readFirstEnvValue(pathEnvKeys);
  if (!filePath) throw createQzError(notConfiguredCode);

  try {
    return normalizePemText(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw createQzError(
      isPermissionDenied(error) ? 'QZ_SIGNING_PERMISSION_DENIED' : readErrorCode,
      error
    );
  }
};

export const getQzCertificateText = async () => {
  const { certificateText } = await getQzSigningConfiguration();
  return certificateText;
};

export const getQzPrivateKeyText = async () => {
  const { privateKeyText } = await getQzSigningConfiguration();
  return privateKeyText;
};

const readQzCertificateText = async () => readTextFromEnvOrFile({
  textEnvKeys: CERT_TEXT_ENV_KEYS,
  pathEnvKeys: CERT_PATH_ENV_KEYS,
  notConfiguredCode: 'QZ_CERTIFICATE_NOT_CONFIGURED',
  readErrorCode: 'QZ_CERTIFICATE_READ_ERROR'
});

const readQzPrivateKeyText = async () => readTextFromEnvOrFile({
  textEnvKeys: KEY_TEXT_ENV_KEYS,
  pathEnvKeys: KEY_PATH_ENV_KEYS,
  notConfiguredCode: 'QZ_PRIVATE_KEY_NOT_CONFIGURED',
  readErrorCode: 'QZ_PRIVATE_KEY_READ_ERROR'
});

const parseCertificate = (certificateText) => {
  try {
    return new crypto.X509Certificate(certificateText);
  } catch (error) {
    throw createQzError('QZ_CERTIFICATE_INVALID', error);
  }
};

const parsePrivateKey = (privateKeyText) => {
  try {
    return crypto.createPrivateKey(privateKeyText);
  } catch (error) {
    throw createQzError('QZ_PRIVATE_KEY_INVALID', error);
  }
};

export const getQzSignatureAlgorithm = () => {
  const raw = String(process.env.QZ_SIGNATURE_ALGORITHM || 'SHA512').trim().toUpperCase();
  if (!raw) return 'RSA-SHA512';
  return raw.startsWith('RSA-') ? raw : `RSA-${raw}`;
};

const assertCertificateMatchesPrivateKey = ({ certificate, privateKey, algorithm }) => {
  try {
    const payload = Buffer.from('qz-tray-key-pair-check', 'utf8');
    const signature = crypto.sign(algorithm, payload, privateKey);
    const verified = crypto.verify(algorithm, payload, certificate.publicKey, signature);
    if (!verified) throw createQzError('QZ_CERTIFICATE_KEY_MISMATCH');
  } catch (error) {
    if (error?.code === 'QZ_CERTIFICATE_KEY_MISMATCH') throw error;
    throw createQzError('QZ_CERTIFICATE_KEY_MISMATCH', error);
  }
};

export const getQzSigningConfiguration = async () => {
  let certificateText = '';
  let privateKeyText = '';
  try {
    [certificateText, privateKeyText] = await Promise.all([
      readQzCertificateText(),
      readQzPrivateKeyText()
    ]);
  } catch (error) {
    if (error?.httpStatus === 503) throw error;
    throw createQzError('QZ_SIGNING_NOT_CONFIGURED', error);
  }

  if (!certificateText) throw createQzError('QZ_CERTIFICATE_NOT_CONFIGURED');
  if (!privateKeyText) throw createQzError('QZ_PRIVATE_KEY_NOT_CONFIGURED');

  const certificate = parseCertificate(certificateText);
  const privateKey = parsePrivateKey(privateKeyText);
  const algorithm = getQzSignatureAlgorithm();
  assertCertificateMatchesPrivateKey({ certificate, privateKey, algorithm });

  return {
    certificateText,
    privateKeyText,
    certificate,
    privateKey,
    algorithm
  };
};

export const hasQzSigningConfigured = async () => {
  try {
    await getQzSigningConfiguration();
    return true;
  } catch (error) {
    if (error?.httpStatus === 503) return false;
    throw error;
  }
};

export const isQzConfigurationError = (error) => (
  CONFIG_ERROR_CODES.has(error?.code) || Number(error?.httpStatus) === 503
);

export const getQzPublicErrorMessage = () => (
  'La firma segura de QZ Tray no esta configurada correctamente.'
);

export const signQzMessage = async (requestToSign) => {
  if (typeof requestToSign !== 'string' || requestToSign.length === 0) {
    throw createQzError('QZ_SIGN_REQUEST_INVALID');
  }

  const { privateKey, algorithm } = await getQzSigningConfiguration();

  try {
    return crypto.sign(
      algorithm,
      Buffer.from(requestToSign, 'utf8'),
      privateKey
    ).toString('base64');
  } catch (error) {
    throw createQzError('QZ_SIGNING_NOT_CONFIGURED', error);
  }
};
