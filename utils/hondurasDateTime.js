import { HN_TZ, timestampAsHNToISO } from './dates.js';

export { HN_TZ };

const DATE_FORMATTER = new Intl.DateTimeFormat('es-HN', {
  timeZone: HN_TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

const TIME_FORMATTER = new Intl.DateTimeFormat('es-HN', {
  timeZone: HN_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const STABLE_FALLBACK_ISO = '1970-01-01T00:00:00.000Z';

/**
 * Interpreta un timestamp Postgres "sin zona" como hora local de Honduras
 * (America/Tegucigalpa, UTC-06:00) y lo devuelve como instante absoluto (Date).
 *
 * Acepta: "YYYY-MM-DD HH:mm:ss[.ms]" (sin zona, asumido Honduras), ISO sin
 * zona, ISO con "Z", ISO con offset explicito, e instancias Date. Nunca
 * depende de process.env.TZ ni de la zona horaria del contenedor.
 */
export const toHondurasInstant = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const iso = timestampAsHNToISO(value);
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatHondurasDate = (value, fallback = '--') => {
  const date = toHondurasInstant(value);
  return date ? DATE_FORMATTER.format(date) : fallback;
};

export const formatHondurasTime = (value, fallback = '--') => {
  const date = toHondurasInstant(value);
  return date ? TIME_FORMATTER.format(date) : fallback;
};

/**
 * Formato combinado fecha + hora usado por comandas de cocina.
 */
export const formatHondurasDateTime = (value, fallback = 'N/D') => {
  const date = toHondurasInstant(value);
  if (!date) return fallback;
  return `${DATE_FORMATTER.format(date)} ${TIME_FORMATTER.format(date)}`;
};

/**
 * Fecha estable para metadatos de PDF (creationDate/modDate). Determinista
 * para el mismo valor de entrada, por lo que las reimpresiones producen el
 * mismo documento canonico.
 */
export const resolveStableDocumentDate = (value, fallbackIso = STABLE_FALLBACK_ISO) =>
  toHondurasInstant(value) || new Date(fallbackIso);
