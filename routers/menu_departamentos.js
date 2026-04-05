import pool from '../config/db-connection.js';

// Nombres canonicos que gobiernan la clasificacion del modulo MENU.
const MENU_DEPARTMENT_NAMES = Object.freeze({
  combos: ['combos', 'combo'],
  productos: [
    'cervezas',
    'cerveza',
    'refrescos / agua',
    'refrescos/agua',
    'helados sarita',
    'snacks',
    'snack'
  ],
  excluidosRecetasExtra: ['salsas']
});

const normalizeDepartmentName = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/\s*\/\s*/g, '/')
  .replace(/\s+/g, ' ');

const toUniquePositiveIntArray = (values) => (
  [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )]
);

const getFirstMatchId = (nameToId, candidates) => {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const id = nameToId.get(normalizeDepartmentName(candidate));
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
};

const getIdsForNames = (nameToId, candidates) => toUniquePositiveIntArray(
  (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => nameToId.get(normalizeDepartmentName(candidate)))
);

// Resuelve IDs por nombre para evitar dependencia de IDs fijos (12/13/14/15/19).
export const resolveMenuDepartmentIds = async () => {
  const result = await pool.query(
    `
      SELECT id_tipo_departamento, nombre_departamento
      FROM tipo_departamento
      ORDER BY id_tipo_departamento ASC;
    `
  );

  const nameToId = new Map();
  for (const row of result.rows || []) {
    const normalizedName = normalizeDepartmentName(row?.nombre_departamento);
    const idTipoDepartamento = Number(row?.id_tipo_departamento || 0);

    if (!normalizedName || !Number.isInteger(idTipoDepartamento) || idTipoDepartamento <= 0) continue;
    if (!nameToId.has(normalizedName)) {
      nameToId.set(normalizedName, idTipoDepartamento);
    }
  }

  const comboDepartmentId = getFirstMatchId(nameToId, MENU_DEPARTMENT_NAMES.combos);
  const productDepartmentIds = getIdsForNames(nameToId, MENU_DEPARTMENT_NAMES.productos);
  const extraRecipeExcludedIds = getIdsForNames(nameToId, MENU_DEPARTMENT_NAMES.excluidosRecetasExtra);

  const recipeExcludedDepartmentIds = toUniquePositiveIntArray([
    ...productDepartmentIds,
    comboDepartmentId,
    ...extraRecipeExcludedIds
  ]);

  return {
    comboDepartmentId,
    productDepartmentIds,
    recipeExcludedDepartmentIds
  };
};
