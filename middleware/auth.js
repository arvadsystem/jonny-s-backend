import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'CAMBIA_ESTE_SECRET_EN_ENV';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const authRequired = (req, res, next) => {
  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: true, message: 'No autorizado' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    // Si el token expiró o es inválido, limpiamos cookies
    const isProd = process.env.NODE_ENV === 'production';
    const sameSite = isProd ? 'none' : 'lax';
    const secure = isProd;

    res.clearCookie('access_token', { path: '/', sameSite, secure });
    res.clearCookie('csrf_token', { path: '/', sameSite, secure });

    return res.status(401).json({ error: true, message: 'Sesión expirada o inválida' });
  }
};

export const csrfProtect = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const csrfCookie = req.cookies?.csrf_token;
  const csrfHeader = req.get('x-csrf-token');

  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return res.status(403).json({ error: true, message: 'CSRF token inválido' });
  }

  return next();
};
