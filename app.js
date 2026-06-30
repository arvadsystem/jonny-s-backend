import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pool, { getPoolState } from './config/db-connection.js';

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

// Parametros
import catalogosRoutes from './routers/Parametros/catalogos.js';

const app = express();
const USUARIOS_PHOTO_JSON_LIMIT = '30mb';

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const normalizeOrigin = (origin) => String(origin || '').trim().replace(/\/+$/, '');

const getAllowedOrigins = () => {
  const envOrigins = String(process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);

  if (envOrigins.length > 0) return envOrigins;

  const singleOrigin = normalizeOrigin(process.env.FRONTEND_ORIGIN || '');
  if (singleOrigin) return [singleOrigin];

  if (IS_PRODUCTION) return [];

  return DEFAULT_DEV_ORIGINS.map((origin) => normalizeOrigin(origin));
};

const allowedOrigins = getAllowedOrigins();
const isAllowedOrigin = (origin) => allowedOrigins.includes(normalizeOrigin(origin));
const READINESS_TIMEOUT_MS = 2000;
const buildInfo = Object.freeze({
  git_commit_sha: String(process.env.GIT_COMMIT_SHA || process.env.BUILD_SHA || '').trim() || null,
  app_version: String(process.env.APP_VERSION || process.env.npm_package_version || '').trim() || null,
  build_sha: String(process.env.BUILD_SHA || '').trim() || null
});
let healthCheckQueryRunner = pool;

export const setHealthCheckQueryRunnerForTests = (queryRunner = pool) => {
  healthCheckQueryRunner = queryRunner;
};

const withTimeout = (promise, timeoutMs) => {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('READINESS_TIMEOUT');
      error.code = 'READINESS_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
};

const assertInventoryTracePreflightReady = async () => {
  const result = await healthCheckQueryRunner.query(`
    SELECT c.is_generated
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'movimientos_inventario'
      AND c.column_name = 'id_pedido_trazabilidad'
    LIMIT 1
  `);
  const generationState = String(result.rows?.[0]?.is_generated || '').trim().toUpperCase();
  if (generationState !== 'NEVER') {
    const error = new Error('INVENTORY_TRACE_SCHEMA_NOT_READY');
    error.code = generationState ? 'INVENTORY_TRACE_SCHEMA_NOT_READY' : 'INVENTORY_TRACE_SCHEMA_MISSING';
    error.generationState = generationState || 'MISSING';
    throw error;
  }
};

const assertPedidosSequencePreflightReady = async () => {
  const result = await healthCheckQueryRunner.query(`
    SELECT
      pg_get_serial_sequence('public.pedidos', 'id_pedido') AS sequence_name,
      to_regclass('public.pedidos') IS NOT NULL AS pedidos_exists,
      to_regclass('public.movimientos_inventario') IS NOT NULL AS inventory_exists
  `);
  const row = result.rows?.[0] || {};
  if (!row.pedidos_exists) {
    const error = new Error('PEDIDOS_TABLE_MISSING');
    error.code = 'PEDIDOS_TABLE_MISSING';
    throw error;
  }
  if (!row.inventory_exists) {
    const error = new Error('MOVIMIENTOS_INVENTARIO_TABLE_MISSING');
    error.code = 'MOVIMIENTOS_INVENTARIO_TABLE_MISSING';
    throw error;
  }
  if (!row.sequence_name) {
    const error = new Error('PEDIDOS_SEQUENCE_MISSING');
    error.code = 'PEDIDOS_SEQUENCE_MISSING';
    throw error;
  }

  const sequenceMetaResult = await healthCheckQueryRunner.query(`
    SELECT
      n.nspname AS sequence_schema,
      c.relname AS sequence_relation,
      seq.seqincrement::bigint AS sequence_increment_by,
      seq.seqcycle::boolean AS sequence_cycle,
      seq.seqmin::bigint AS sequence_min_value,
      seq.seqmax::bigint AS sequence_max_value
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_sequence seq ON seq.seqrelid = c.oid
    WHERE c.oid = $1::regclass
    LIMIT 1
  `, [row.sequence_name]);
  const sequenceMeta = sequenceMetaResult.rows?.[0] || {};
  if (!sequenceMeta.sequence_schema || !sequenceMeta.sequence_relation) {
    const error = new Error('PEDIDOS_SEQUENCE_MISSING');
    error.code = 'PEDIDOS_SEQUENCE_MISSING';
    throw error;
  }

  const sequenceIdentifier = `"${String(sequenceMeta.sequence_schema).replaceAll('"', '""')}"."${String(sequenceMeta.sequence_relation).replaceAll('"', '""')}"`;
  const sequenceStateResult = await healthCheckQueryRunner.query(`
    SELECT last_value::bigint AS sequence_last_value, is_called::boolean AS sequence_is_called
    FROM ${sequenceIdentifier}
  `);
  const historyResult = await healthCheckQueryRunner.query(`
    SELECT
      COALESCE(MAX(id_pedido), 0)::bigint AS max_pedido_id,
      COALESCE((
        SELECT MAX(id_ref)::bigint
        FROM public.movimientos_inventario
        WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
          AND id_ref IS NOT NULL
      ), 0)::bigint AS max_inventory_order_ref
    FROM public.pedidos
  `);

  const sequenceState = sequenceStateResult.rows?.[0] || {};
  const history = historyResult.rows?.[0] || {};
  const sequenceLastValue = Number(sequenceState.sequence_last_value);
  const sequenceIncrementBy = Number(sequenceMeta.sequence_increment_by);
  const sequenceMaxValue = Number(sequenceMeta.sequence_max_value);
  const sequenceIsCalled = sequenceState.sequence_is_called === true;
  const sequenceCycle = sequenceMeta.sequence_cycle === true;
  const maxPedidoId = Number(history.max_pedido_id || 0);
  const maxInventoryOrderRef = Number(history.max_inventory_order_ref || 0);
  const historyFloor = Math.max(maxPedidoId, maxInventoryOrderRef);
  const sequenceNextCandidate = sequenceIsCalled ? sequenceLastValue + sequenceIncrementBy : sequenceLastValue;
  const safeDetails = {
    sequence_last_value: Number.isFinite(sequenceLastValue) ? sequenceLastValue : null,
    sequence_is_called: typeof sequenceState.sequence_is_called === 'boolean' ? sequenceIsCalled : null,
    sequence_increment_by: Number.isFinite(sequenceIncrementBy) ? sequenceIncrementBy : null,
    sequence_cycle: sequenceCycle,
    sequence_next_candidate: Number.isFinite(sequenceNextCandidate) ? sequenceNextCandidate : null,
    max_pedido_id: Number.isFinite(maxPedidoId) ? maxPedidoId : null,
    max_inventory_order_ref: Number.isFinite(maxInventoryOrderRef) ? maxInventoryOrderRef : null,
    history_floor: Number.isFinite(historyFloor) ? historyFloor : null
  };

  let code = null;
  if (!Number.isFinite(sequenceLastValue)) code = 'PEDIDOS_SEQUENCE_MISSING';
  else if (!Number.isFinite(sequenceIncrementBy) || sequenceIncrementBy <= 0) code = 'PEDIDOS_SEQUENCE_INVALID_INCREMENT';
  else if (sequenceCycle) code = 'PEDIDOS_SEQUENCE_CYCLE_UNSAFE';
  else if (!Number.isFinite(sequenceNextCandidate) || sequenceNextCandidate <= historyFloor) {
    code = 'PEDIDOS_SEQUENCE_BELOW_INVENTORY_HISTORY';
  } else if (!Number.isFinite(sequenceMaxValue) || sequenceNextCandidate > sequenceMaxValue) {
    code = 'PEDIDOS_SEQUENCE_EXHAUSTED';
  }
  if (code) {
    const error = new Error(code);
    error.code = code;
    error.safeDetails = safeDetails;
    throw error;
  }
};

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
app.get('/health/live', (req, res) => {
  res.status(200).json({
    status: 'alive',
    role: 'web',
    timestamp: new Date().toISOString()
  });
});

app.get('/health/ready', async (req, res) => {
  try {
    await withTimeout(healthCheckQueryRunner.query('SELECT 1'), READINESS_TIMEOUT_MS);
    await withTimeout(assertInventoryTracePreflightReady(), READINESS_TIMEOUT_MS);
    await withTimeout(assertPedidosSequencePreflightReady(), READINESS_TIMEOUT_MS);
    const poolState = getPoolState();
    return res.status(200).json({
      status: 'ready',
      database: 'ok',
      role: 'web',
      pool: {
        total: poolState.totalCount,
        idle: poolState.idleCount,
        waiting: poolState.waitingCount
      },
      build: buildInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(503).json({
      status: 'not_ready',
      database: 'error',
      role: 'web',
      code: error?.code || 'READINESS_CHECK_FAILED',
      details: error?.safeDetails || undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// Legacy: mantener por compatibilidad; EasyPanel debe usar /health/ready.
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
// Admin: publicacion de menu por sucursal (visible, precio_publico y orden).
app.use('/api/admin/menu-publicacion', adminMenuPublicacionRouter);
// Admin: catalogo/configuracion de salsas para recetas.
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

export default app;

