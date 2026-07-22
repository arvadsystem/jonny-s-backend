const normalizeObservation = (value, maxLength = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

export const validateCajaCloseEditObservation = (body) => {
  const requestBody = body && typeof body === 'object' ? body : {};
  const present = Object.prototype.hasOwnProperty.call(requestBody, 'observacion_cierre');
  const observation = present
    ? normalizeObservation(requestBody.observacion_cierre)
    : null;

  return {
    valid: present && Boolean(observation),
    observation
  };
};
