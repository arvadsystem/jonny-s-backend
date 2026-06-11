import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pool from './config/db-connection.js';

import loginRoutes from './routers/login.js';
import publicClienteRoutes from './routers/public_cliente.js';
import publicMenuRouter from './routers/public_menu/index.js';

// ... tus otros routes
import usuarioRoutes from './routers/usuarios.js';
import categoriasRoutes from './routers/categorias_productos.js';
import categoriasInsumosRoutes from './routers/categorias_insumos.js';
import almacenesRoutes from './routers/almacenes.js';
import productosRoutes from './routers/productos.js';
import insumosRoutes from './routers/insumos.js';
import proveedoresRoutes from './routers/proveedores.js';
import ordenComprasRoutes from './routers/orden_compras.js';
import detalleOrdenComprasRoutes from './routers/detalle_orden_compras.js';
import comprasRoutes from './routers/compras.js';
import detalleComprasRoutes from './routers/detalle_compras.js';
import ordenesCompraWorkflowRoutes from './routers/ordenes_compra_workflow.js';
import sucursalesRoutes from './routers/sucursales.js';
import ventasRoutes from './routers/ventas.js';
import cocinaRoutes from './routers/cocina.js';
import menuPosRouter from './routers/menu_pos.js'; // Router del POS Menú

// MODULO PERSONAS
import personasRoutes from './routers/personas.js';
import telefonosRoutes from './routers/telefonos.js';
import direccionesRoutes from './routers/direcciones.js';
import correosRoutes from './routers/correos.js';
import empresasRoutes from './routers/empresas.js';
import clientesRoutes from './routers/clientes.js';
import empleadosRoutes from './routers/empleados.js';
import planillasRoutes from './routers/planillas.js';
import personasAtomicRoutes from './routers/personas_atomic.js';

// ESTE ARCHIVO EXISTE COMO "tipos_departamentos.js"
import tipoDepartamentoRoutes from './routers/tipos_departamentos.js';
import movimientosInventarioRoutes from './routers/movimientos_inventario.js';
import perfilRoutes from './routers/perfil.js';
import mobiliarioRoutes from './routers/mobiliario.js';
import emailCampaignRoutes from './routers/email_campaigns.js';

// Seguridad
import seguridadSesionesRoutes from './routers/Seguridad/sesiones.js';
import seguridadConfigRoutes from './routers/Seguridad/configuracion.js';
import seguridadLoginsRoutes from './routers/Seguridad/logins.js';
import seguridadPermisosRoutes from './routers/Seguridad/permisos.js';
import seguridadUsuariosRoutes from './routers/Seguridad/usuarios.js';
import seguridadDashboardRoutes from './routers/Seguridad/dashboard.js';
import seguridadNotificacionesRoutes from './routers/Seguridad/notificaciones.js';
import { globalAuditMiddleware } from './routers/Seguridad/globalAuditInterceptor.js';
import rolesPermisosRoutes from './routers/roles_permisos.js';

import archivosRoutes from './routers/archivos.js';
import adminRecetasRouter from './routers/admin_recetas.js';
import adminExtrasRouter from './routers/admin_extras.js';
import adminCombosRouter from './routers/admin_combos.js';
import adminMenuPublicacionRouter from './routers/admin_menu_publicacion.js';
import adminSalsasRouter from './routers/admin_salsas.js';
import adminInsumoPresentacionesRouter from './routers/admin_insumo_presentaciones/index.js';
import cajasRoutes from './routers/cajas.js';
import fidelizacionRoutes from './routers/fidelizacion.js';
import reportesRoutes from './routers/reportes.js';

import { authRequired, csrfProtect } from './middleware/auth.js';
import { touchSessionMiddleware } from './middleware/touchSession.js';
import { requireActiveSession } from './middleware/requireActiveSession.js';
import { requirePasswordChange } from './middleware/requirePasswordChange.js';
import { MAX_IMAGE_JSON_LIMIT, UPLOADS_DIR } from './utils/uploads.js';
import { startEmailCampaignScheduler } from './jobs/emailCampaignScheduler.js';

// Parametros
import catalogosRoutes from './routers/Parametros/catalogos.js';

const app = express();
const USUARIOS_PHOTO_JSON_LIMIT = '30mb';

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
const normalizeOrigin = (origin) => String(origin || '').trim().replace(/\/+$/, '');

const getAllowedOrigins = () => {
  const envOrigins = String(process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);

  if (envOrigins.length > 0) return envOrigins;

  const singleOrigin = normalizeOrigin(process.env.FRONTEND_ORIGIN || '');
  if (singleOrigin) return [singleOrigin];

  return DEFAULT_DEV_ORIGINS.map((origin) => normalizeOrigin(origin));
};

const allowedOrigins = getAllowedOrigins();
const isAllowedOrigin = (origin) => allowedOrigins.includes(normalizeOrigin(origin));

// ✅ (Opcional) proxy - no afecta el login
if (String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') {
  app.set('trust proxy', 1);
}

// ✅ 1) Middlewares base SIEMPRE antes de auth
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error('Origen no permitido por CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-CSRF-Token',
      'Authorization',
      'X-Requested-With',
      'Idempotency-Key',
      'X-Idempotency-Key'
    ]
  })
);

// NEW: aumenta el limite JSON para soportar uploads base64 de imagen sin multipart.
// WHY: el modulo Inventario enviara imagenes como data URL / base64 por JSON.
// IMPACT: mantiene el parser global actual y habilita cuerpos de imagen dentro del limite definido.
app.use('/usuarios/v2/photo', express.json({ limit: USUARIOS_PHOTO_JSON_LIMIT }));
app.use(express.json({ limit: MAX_IMAGE_JSON_LIMIT }));
app.use(cookieParser());

app.use((err, req, res, next) => {
  if (err?.message === 'Origen no permitido por CORS') {
    const method = req?.method || 'UNKNOWN';
    const route = req?.originalUrl || req?.url || '-';
    const origin = req?.headers?.origin || '-';
    console.warn(`[cors] origen bloqueado ${origin} en ${method} ${route}`);
    return res.status(403).json({
      ok: false,
      message: 'Origen no permitido.'
    });
  }

  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    const method = req?.method || 'UNKNOWN';
    const route = req?.originalUrl || req?.url || '-';
    console.warn(`[json] payload invalido en ${method} ${route}`);
    return res.status(400).json({
      ok: false,
      message: 'El cuerpo de la solicitud no tiene un formato JSON válido.'
    });
  }
  return next(err);
});

// NEW: exposicion publica de `/uploads` para thumbnails e imagen principal de inventario.
// WHY: los registros en `archivos.url_publica` apuntan a archivos locales servidos por Express.
// IMPACT: no protege con JWT porque las imagenes deben poder cargarse en la UI como assets normales.
app.use('/uploads', express.static(UPLOADS_DIR));

// ✅ 2) Rutas públicas ANTES de auth
app.get('/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', db_time: result.rows[0] });
  } catch (err) {
    console.error('[status] Error:', err);
    res.status(500).json({
      error: true,
      message: 'No se pudo verificar el estado del servicio.'
    });
  }
});

// ✅ Login debe ser público
app.use(loginRoutes);

// ✅ Menú público para clientes (sin sesión de dashboard/POS).
app.use('/api/public-menu', publicMenuRouter);

// ✅ Rutas públicas de clientes (registro, login, menú, forgot-password)
app.use(publicClienteRoutes);

// ✅ 3) A partir de aquí: todo protegido
app.use(authRequired);               // 1) valida JWT
app.use(requireActiveSession);       // 2) valida sesión activa en BD
app.use(requirePasswordChange);      // fuerza cambio de contrasena cuando aplica
app.use(touchSessionMiddleware);     // 3) actualiza ultima_actividad
app.use(csrfProtect);                // 4) CSRF para no-GET
app.use(globalAuditMiddleware);      // 5) auditoria global (intencion real + diff puntual)
app.use(perfilRoutes);
app.use(emailCampaignRoutes);

// Admin: CRUD de recetas para panel administrativo (rutas relativas en router).
app.use('/api/admin/recetas', adminRecetasRouter);
// Admin: CRUD de extras opcionales del menu.
app.use('/api/admin/extras', adminExtrasRouter);
// Admin: CRUD de combos para panel administrativo (rutas relativas en router).
app.use('/api/admin/combos', adminCombosRouter);
// Admin: publicacion de menu por sucursal (visible, precio_publico y orden).
app.use('/api/admin/menu-publicacion', adminMenuPublicacionRouter);
// Admin: catalogo/configuracion de salsas para recetas y combos.
app.use('/api/admin/salsas', adminSalsasRouter);
// Admin: presentaciones/conversiones por insumo.
app.use('/api/admin/insumos', adminInsumoPresentacionesRouter);

// ✅ 4) Rutas protegidas
app.use('/seguridad', seguridadSesionesRoutes);
app.use('/seguridad', seguridadConfigRoutes);
app.use('/seguridad', seguridadLoginsRoutes);
app.use('/seguridad', seguridadPermisosRoutes);
app.use('/seguridad', seguridadUsuariosRoutes);
app.use('/seguridad', seguridadDashboardRoutes);
app.use('/seguridad', seguridadNotificacionesRoutes);
app.use('/api/security', seguridadDashboardRoutes);
app.use('/api/roles-permisos', rolesPermisosRoutes);

// Parametros
app.use('/parametros/catalogos', catalogosRoutes);

app.use(usuarioRoutes);

// NEW: alta de archivos para imagen principal de Productos/Insumos.
// WHY: centralizar el guardado en tabla `archivos` y reutilizar el mismo flujo en Inventario.
// IMPACT: agrega `POST /archivos`; no modifica endpoints existentes.
app.use(archivosRoutes);

app.use(categoriasRoutes);

// NEW: CRUD de categorías de insumos con el mismo patrón que categorías de productos.
// WHY: unificar Inventario > Categorías sin romper endpoints existentes.
// IMPACT: agrega rutas nuevas `/categorias_insumos`; no altera rutas actuales.
app.use(categoriasInsumosRoutes);
app.use(almacenesRoutes);
app.use(productosRoutes);
app.use(insumosRoutes);
// AM: submodulo Inventario > Mobiliario (v1).
app.use(mobiliarioRoutes);
app.use(proveedoresRoutes);
app.use(ordenComprasRoutes);
app.use(detalleOrdenComprasRoutes);
app.use(comprasRoutes);
app.use(detalleComprasRoutes);
// AM: flujo transaccional y seguro para solicitudes/ordenes/compras de abastecimiento.
app.use(ordenesCompraWorkflowRoutes);
app.use(tipoDepartamentoRoutes);
app.use(sucursalesRoutes);
app.use(cajasRoutes);
app.use(ventasRoutes);
app.use(cocinaRoutes);
app.use(fidelizacionRoutes);
app.use(reportesRoutes);

// MODULO PERSONAS
app.use(personasRoutes);
app.use(telefonosRoutes);
app.use(direccionesRoutes);
app.use(correosRoutes);
app.use(clientesRoutes);
app.use(empleadosRoutes);
app.use(personasAtomicRoutes);
app.use(planillasRoutes);
app.use(empresasRoutes);

app.use(menuPosRouter); // Monta las rutas del POS Menú
app.use(movimientosInventarioRoutes);

const PORT = process.env.PORT || 3001;
startEmailCampaignScheduler();
app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});

export default app;

