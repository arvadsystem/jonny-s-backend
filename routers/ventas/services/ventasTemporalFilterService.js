import { TEGUCIGALPA_TZ } from '../constants.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const HONDURAS_UTC_OFFSET_HOURS = 6;
const MINUTE_MS = 60 * 1000;
const HOURS_72_MS = 72 * 60 * 60 * 1000;

const tegucigalpaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TEGUCIGALPA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const fail = (code, message, status = 400) => ({ ok: false, code, message, status });

const readSingleQueryValue = (value) => {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (Array.isArray(value) || typeof value === 'object') return { ok: false, value: null };
  const normalized = String(value).trim();
  return normalized ? { ok: true, value: normalized } : { ok: true, value: null };
};
const parseCalendarDate = (value) => {
  const match = DATE_PATTERN.exec(value || '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) return null;
  return { year, month, day };
};

const parseClockTime = (value) => {
  const match = TIME_PATTERN.exec(value || '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, totalMinutes: (hour * 60) + minute };
};

const formatDateParts = ({ year, month, day }) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const addCalendarDays = (date, days) => {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  };
};

const formatWallTimestamp = (date, hour = 0, minute = 0) =>
  `${formatDateParts(date)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

const addOneMinute = (date, time) => {
  if (time.totalMinutes < 1439) {
    const nextTotal = time.totalMinutes + 1;
    return {
      date,
      hour: Math.floor(nextTotal / 60),
      minute: nextTotal % 60
    };
  }
  return { date: addCalendarDays(date, 1), hour: 0, minute: 0 };
};

const getTegucigalpaToday = (now) => {
  const parts = Object.fromEntries(
    tegucigalpaDateFormatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const wallTimeToEpochMs = (date, hour, minute) =>
  Date.UTC(date.year, date.month - 1, date.day, hour + HONDURAS_UTC_OFFSET_HOURS, minute);

const getVentas72hCutoffEpochMs = (now) =>
  Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS - HOURS_72_MS;

export const resolveVentasTemporalFilter = (
  query = {},
  { limitedToLast72Hours = false, now = new Date() } = {}
) => {
  const rawFechaDesde = readSingleQueryValue(query.fechaDesde);
  const rawFechaHasta = readSingleQueryValue(query.fechaHasta);
  const rawHoraDesde = readSingleQueryValue(query.horaDesde);
  const rawHoraHasta = readSingleQueryValue(query.horaHasta);

  if (![rawFechaDesde, rawFechaHasta, rawHoraDesde, rawHoraHasta].every((item) => item.ok)) {
    return fail('VENTAS_FILTRO_TEMPORAL_INVALIDO', 'Los filtros de fecha y hora deben enviarse una sola vez.');
  }

  const hasAnyDate = Boolean(rawFechaDesde.value || rawFechaHasta.value);
  const today = getTegucigalpaToday(now);
  const fechaDesde = hasAnyDate ? rawFechaDesde.value : today;
  const fechaHasta = hasAnyDate ? rawFechaHasta.value : today;

  if (!fechaDesde || !fechaHasta) {
    return fail('VENTAS_FECHAS_INCOMPLETAS', 'Debe indicar fecha inicial y fecha final.');
  }

  const desdeDate = parseCalendarDate(fechaDesde);
  const hastaDate = parseCalendarDate(fechaHasta);
  if (!desdeDate || !hastaDate) {
    return fail('VENTAS_FECHA_INVALIDA', 'fechaDesde y fechaHasta deben ser fechas validas con formato YYYY-MM-DD.');
  }
  if (fechaHasta < fechaDesde) {
    return fail('VENTAS_RANGO_FECHAS_INVALIDO', 'La fecha final no puede ser anterior a la fecha inicial.');
  }
  if (fechaDesde > today || fechaHasta > today) {
    return fail('VENTAS_FECHA_FUTURA', 'No se permiten fechas futuras en el historial de ventas.');
  }

  const hasAnyTime = Boolean(rawHoraDesde.value || rawHoraHasta.value);
  if (hasAnyTime && (!rawHoraDesde.value || !rawHoraHasta.value)) {
    return fail('VENTAS_HORAS_INCOMPLETAS', 'Debe indicar hora inicial y hora final.');
  }
  if (hasAnyTime && fechaDesde !== fechaHasta) {
    return fail('VENTAS_HORAS_REQUIEREN_UN_DIA', 'El filtro de horas solo puede utilizarse para un unico dia.');
  }

  const horaDesde = hasAnyTime ? rawHoraDesde.value : null;
  const horaHasta = hasAnyTime ? rawHoraHasta.value : null;
  const desdeTime = hasAnyTime ? parseClockTime(horaDesde) : null;
  const hastaTime = hasAnyTime ? parseClockTime(horaHasta) : null;
  if (hasAnyTime && (!desdeTime || !hastaTime)) {
    return fail('VENTAS_HORA_INVALIDA', 'horaDesde y horaHasta deben tener formato HH:mm.');
  }
  if (hasAnyTime && hastaTime.totalMinutes <= desdeTime.totalMinutes) {
    return fail('VENTAS_RANGO_HORAS_INVALIDO', 'La hora final debe ser mayor que la hora inicial.');
  }

  const startHour = desdeTime?.hour ?? 0;
  const startMinute = desdeTime?.minute ?? 0;
  const end = hasAnyTime
    ? addOneMinute(hastaDate, hastaTime)
    : { date: addCalendarDays(hastaDate, 1), hour: 0, minute: 0 };
  const startEpochMs = wallTimeToEpochMs(desdeDate, startHour, startMinute);

  if (limitedToLast72Hours && startEpochMs < getVentas72hCutoffEpochMs(now)) {
    return fail(
      'VENTAS_RANGO_72H_EXCEDIDO',
      'El historial de caja solo permite consultar ventas comprendidas en las ultimas 72 horas.',
      403
    );
  }

  return {
    ok: true,
    filters: {
      fechaDesde,
      fechaHasta,
      horaDesde,
      horaHasta,
      timezone: TEGUCIGALPA_TZ
    },
    bounds: {
      startInclusive: formatWallTimestamp(desdeDate, startHour, startMinute),
      endExclusive: formatWallTimestamp(end.date, end.hour, end.minute)
    }
  };
};
