/**
 * utils/security/clientInfo.js
 * Helpers para obtener IP real del cliente y extraer info básica del User-Agent.
 * Sin librerías externas para mantenerlo simple y portable.
 */

/**
 * Obtiene IP del cliente considerando proxies (Interserver / Nginx / etc.)
 * - x-forwarded-for puede traer una lista: "ip1, ip2, ip3"
 * - usamos la primera (la IP del cliente original)
 */
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    return first || req.ip;
  }

  let ip = (req.ip || '').replace('::ffff:', '');

  // Si estás en localhost IPv6, lo convertimos a IPv4 típico
  if (ip === '::1') ip = '127.0.0.1';

  return ip;
}


/**
 * Parsea información "suficiente" del user-agent.
 * No es perfecto, pero cumple HU78 sin añadir dependencias.
 */
export function parseUserAgent(userAgentRaw = '') {
  const ua = String(userAgentRaw);

  // --- Sistema Operativo ---
  let sistema_operativo = 'Desconocido';
  if (/Windows NT/i.test(ua)) sistema_operativo = 'Windows';
  else if (/Android/i.test(ua)) sistema_operativo = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) sistema_operativo = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) sistema_operativo = 'macOS';
  else if (/Linux/i.test(ua)) sistema_operativo = 'Linux';

  // --- Navegador (orden importa) ---
  let navegador = 'Desconocido';
  if (/Edg\//i.test(ua)) navegador = 'Edge';
  else if (/OPR\//i.test(ua)) navegador = 'Opera';
  else if (/Chrome\//i.test(ua)) navegador = 'Chrome';
  else if (/Firefox\//i.test(ua)) navegador = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) navegador = 'Safari';

  // --- Dispositivo (muy básico) ---
  let dispositivo = 'Desktop';
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) dispositivo = 'Mobile';

  return { dispositivo, navegador, sistema_operativo };
}
