import {
  DESCUENTO_ALCANCE_KEYS
} from '../constants.js';
import { roundMoney } from './moneyUtils.js';

export const normalizeTipoItem = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return ['PRODUCTO', 'RECETA', 'COMBO', 'MIXTO', 'ITEM'].includes(normalized)
    ? normalized
    : 'ITEM';
};

export const parsePositiveInt = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^0*[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const parseOptionalPositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parsePositiveInt(value);
};

export const parseRequiredPositiveInt = (value, fieldName) => {
  const parsed = parsePositiveInt(value);
  if (!parsed) {
    return {
      ok: false,
      message: `${fieldName} debe ser un entero mayor a 0.`
    };
  }
  return { ok: true, value: parsed };
};

export const parseNonNegativeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? roundMoney(parsed) : null;
};

export const normalizeDescuentoAlcance = (value) => {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return Object.values(DESCUENTO_ALCANCE_KEYS).includes(normalized) ? normalized : null;
};

export const parseOptionalDateTime = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const parseBooleanInput = (value) => {
  if (value === true || value === false) return { ok: true, value };
  if (value === 1 || value === 0) return { ok: true, value: value === 1 };
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'si', 'yes', 'y', 'activo'].includes(normalized)) {
      return { ok: true, value: true };
    }
    if (['false', '0', 'no', 'n', 'inactivo'].includes(normalized)) {
      return { ok: true, value: false };
    }
  }
  return { ok: false, value: false };
};

export const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

export const normalizeSearchText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

export const parseComplementosPayload = (value) => {
  if (value === undefined || value === null) return { ok: true, data: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: 'complementos debe ser una lista valida.' };
  }
  const dedupe = new Set();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return { ok: false, message: 'Cada complemento debe ser un objeto valido.' };
    }
    const idComplemento = parseOptionalPositiveInt(entry.id_complemento);
    if (!idComplemento) {
      return { ok: false, message: 'Cada complemento debe incluir id_complemento entero mayor a 0.' };
    }
    dedupe.add(Number(idComplemento));
  }
  return { ok: true, data: [...dedupe].sort((a, b) => a - b) };
};

export const parseVentaExtrasPayload = (value, { kind, cantidad }) => {
  if (value === undefined || value === null) return { ok: true, data: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: 'extras debe ser una lista valida.' };
  }

  if (kind === 'PRODUCTO' && value.length > 0) {
    return { ok: false, message: 'Los productos no permiten extras.' };
  }

  const seen = new Set();
  const normalized = [];
  const maxCantidad = Number(cantidad || 0);

  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return { ok: false, message: 'Cada extra debe ser un objeto valido.' };
    }
    const idExtra = parseOptionalPositiveInt(entry.id_extra);
    if (!idExtra) {
      return { ok: false, message: 'Cada extra debe incluir id_extra entero mayor a 0.' };
    }
    if (seen.has(idExtra)) {
      return { ok: false, message: 'No se permite duplicar el mismo extra en una linea.' };
    }
    const extraCantidad = parsePositiveInt(entry.cantidad);
    if (!extraCantidad) {
      return { ok: false, message: 'Cada extra debe incluir cantidad entera mayor a 0.' };
    }
    if (extraCantidad > maxCantidad) {
      return { ok: false, message: 'La cantidad de un extra no puede ser mayor que la cantidad del item.' };
    }
    seen.add(idExtra);
    normalized.push({ id_extra: idExtra, cantidad: extraCantidad });
  }

  return {
    ok: true,
    data: normalized.sort((left, right) => left.id_extra - right.id_extra)
  };
};

export const normalizeRoleName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

export const parseBoundedPositiveInt = (value, { fallback, min = 1, max = Number.MAX_SAFE_INTEGER }) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

export const parseOptionalDateInput = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '__INVALID_DATE__';
  return normalized;
};

export const coercePositiveIntArray = (value) =>
  [...new Set((Array.isArray(value) ? value : [])
    .map((item) => Number.parseInt(String(item ?? ''), 10))
    .filter((item) => Number.isInteger(item) && item > 0))];

export const parseBooleanish = (value) =>
  value === true ||
  value === 1 ||
  String(value || '').trim().toLowerCase() === 'true';

export const parseEntityIdentifier = (value, fieldName) => {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 0 ||
    value === '0'
  ) {
    return { ok: true, value: null };
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      message: `${fieldName} debe ser un entero mayor a 0 o null.`
    };
  }

  return { ok: true, value: parsed };
};

export const normalizeObservation = (value) => {
  if (value === undefined || value === null) return null;

  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  return normalized.slice(0, 200);
};

export const parseJsonArrayValue = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};
