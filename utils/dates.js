const HN_OFFSET = "-06:00";

/**
 * Convierte un timestamp (sin zona horaria) a ISO UTC (con Z),
 * asumiendo que el timestamp almacenado representa hora de Honduras.
 *
 * Ejemplos:
 *  "2026-02-18 04:28:39"  -> lo tratamos como "2026-02-18T04:28:39-06:00" -> ISO Z
 *  "2026-02-18T04:28:39"  -> igual
 */
export function timestampAsHNToISO(value) {
  if (!value) return null;

  // Si viene como Date (pg a veces lo devuelve así)
  if (value instanceof Date) {
    return value.toISOString(); // ya es un instante, lo mandamos en Z
  }

  // Normalizar "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss"
  let s = String(value).trim().replace(" ", "T");

  // Si NO trae zona, asumimos Honduras (-06:00)
  const hasTZ = /Z$|[+-]\d{2}:\d{2}$/.test(s);
  if (!hasTZ) s = `${s}${HN_OFFSET}`;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  // ISO en UTC con "Z"
  return d.toISOString();
}
