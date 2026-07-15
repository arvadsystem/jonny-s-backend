const normalizeRoleCodes = (roleCodes) =>
  (Array.isArray(roleCodes) ? roleCodes : [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);

const hasAnyRoleCode = (roleCodes, candidates) => {
  const normalizedRoles = new Set(normalizeRoleCodes(roleCodes));
  return (Array.isArray(candidates) ? candidates : []).some((candidate) =>
    normalizedRoles.has(String(candidate || '').trim().toUpperCase())
  );
};

export const isCajaUserSuperAdmin = (roleCodes) => hasAnyRoleCode(roleCodes, ['SUPER_ADMIN']);

export const canBypassCajaSucursalForAuxiliary = ({
  actorIsSuperAdmin = false,
  targetRoleCodes = [],
  puedeResponsable = false,
  puedeAuxiliar = false
} = {}) =>
  Boolean(puedeAuxiliar) &&
  !Boolean(puedeResponsable) &&
  Boolean(actorIsSuperAdmin) &&
  isCajaUserSuperAdmin(targetRoleCodes);
