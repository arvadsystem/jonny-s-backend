const normalizeCode = (value) => String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase();
const WEB_ORIGINS = new Set(['MENU', 'WEB', 'MENU_PUBLICO', 'PUBLIC_MENU']);
const LOCAL_CHANNELS = new Set(['LOCAL', 'TELEFONO', 'WHATSAPP']);
const LOCAL_ORIGINS = new Set(['CAJA']);
const EAT_HERE_MODES = new Set(['CONSUMO_LOCAL', 'LOCAL']);
const PICKUP_MODES = new Set(['RECOGER', 'PARA_LLEVAR']);

const isLegacyPublicMenu = (description) => /\[(?:public-menu|menu-publico)\]/i.test(String(description ?? ''));

export const resolveKdsOrderOrigin = ({
  canalCodigo,
  modalidadCodigo,
  origenPedido,
  descripcionPedido,
  hasDelivery = false
} = {}) => {
  const channel = normalizeCode(canalCodigo);
  const mode = normalizeCode(modalidadCodigo);
  const origin = normalizeCode(origenPedido);
  if (channel === 'MENU_PUBLICO' || WEB_ORIGINS.has(origin) || isLegacyPublicMenu(descripcionPedido)) return 'WEB';
  if (mode === 'DELIVERY' || hasDelivery) return 'DELIVERY';
  if (LOCAL_CHANNELS.has(channel) || EAT_HERE_MODES.has(mode) || PICKUP_MODES.has(mode) || LOCAL_ORIGINS.has(origin)) return 'LOCAL';
  return 'NO_DEFINIDO';
};

export const resolveKdsDeliveryMode = ({ modalidadCodigo, hasDelivery = false, descripcionEnvio } = {}) => {
  const mode = normalizeCode(modalidadCodigo);
  if (mode === 'DELIVERY' || hasDelivery) return 'DELIVERY';
  if (EAT_HERE_MODES.has(mode)) return 'COMER_AQUI';
  if (PICKUP_MODES.has(mode)) return 'PARA_LLEVAR';

  const legacy = normalizeCode(descripcionEnvio);
  if (/DELIVERY|DOMICILIO/.test(legacy)) return 'DELIVERY';
  if (/RECOGER|PARA_LLEVAR|LLEVAR/.test(legacy)) return 'PARA_LLEVAR';
  if (/CONSUMO_LOCAL|COMER_AQUI/.test(legacy)) return 'COMER_AQUI';
  return 'NO_DEFINIDA';
};

export const resolveLegacyKdsServiceType = (mode) => ({
  COMER_AQUI: 'LOCAL',
  PARA_LLEVAR: 'PARA_LLEVAR',
  DELIVERY: 'DELIVERY'
}[mode] || 'NO_DEFINIDO');
