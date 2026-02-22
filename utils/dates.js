export const HN_TZ = "America/Tegucigalpa";
const HN_OFFSET = "-06:00";

/**
 * Convierte un timestamp (sin zona horaria) a ISO UTC (con Z),
 * asumiendo que el timestamp almacenado representa hora de Honduras.
 *
 * Ejemplos:
 *  "2026-02-18 04:28:39"  -> "2026-02-18T04:28:39-06:00" -> ISO Z
 *  "2026-02-18T04:28:39"  -> igual
 */
export function timestampAsHNToISO(value) {
  if (!value) return null;

  // Si viene como Date (por alguna ruta antigua)
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Normalizar "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss"
  let s = String(value).trim().replace(" ", "T");

  // Si NO trae zona, asumimos Honduras (-06:00)
  const hasTZ = /Z$|[+-]\d{2}:\d{2}$/.test(s);
  if (!hasTZ) s = `${s}${HN_OFFSET}`;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString();
}

/**
 * Convierte un input de filtro (YYYY-MM-DD o ISO) a "timestamp sin TZ" (wall-clock de Honduras).
 *
 * - Si viene como "YYYY-MM-DD", NO se interpreta con Date (JS la trata como UTC),
 *   y se devuelve "YYYY-MM-DD 00:00:00" o "YYYY-MM-DD 23:59:59.999".
 * - Si viene como ISO (con Z u offset), se convierte al wall-clock de Honduras.
 */
export function toHNWallTimestamp(value, { endOfDay = false } = {}) {
  if (!value) return null;
  const s = String(value).trim();

  // Fecha pura (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s} 23:59:59.999` : `${s} 00:00:00`;
  }

  // ISO / datetime: lo convertimos a instante y luego al wall-clock HN
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const HH = get("hour");
  const MM = get("minute");
  const SS = get("second");

  if (endOfDay) return `${yyyy}-${mm}-${dd} 23:59:59.999`;
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}