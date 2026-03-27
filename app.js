import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pool from './config/db-connection.js';

import loginRoutes from './routers/login.js';

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

// ESTE ARCHIVO EXISTE COMO "tipos_departamentos.js"
import tipoDepartamentoRoutes from './routers/tipos_departamentos.js';
import movimientosInventarioRoutes from './routers/movimientos_inventario.js';
import perfilRoutes from './routers/perfil.js';

// Seguridad
import seguridadSesionesRoutes from './routers/Seguridad/sesiones.js';
import seguridadConfigRoutes from './routers/Seguridad/configuracion.js';
import seguridadLoginsRoutes from './routers/Seguridad/logins.js';
import seguridadPermisosRoutes from './routers/Seguridad/permisos.js';
import seguridadUsuariosRoutes from './routers/Seguridad/usuarios.js';
import { globalAuditMiddleware } from './routers/Seguridad/globalAuditInterceptor.js';
import rolesPermisosRoutes from './routers/roles_permisos.js';

import archivosRoutes from './routers/archivos.js';
import adminRecetasRouter from './routers/admin_recetas.js';
import adminCombosRouter from './routers/admin_combos.js';

import { authRequired, csrfProtect } from './middleware/auth.js';
import { touchSessionMiddleware } from './middleware/touchSession.js';
import { requireActiveSession } from './middleware/requireActiveSession.js';
import { MAX_IMAGE_JSON_LIMIT, UPLOADS_DIR } from './utils/uploads.js';

// Parametros
import catalogosRoutes from './routers/Parametros/catalogos.js';

const app = express();
const USUARIOS_PHOTO_JSON_LIMIT = '30mb';

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

// ✅ (Opcional) proxy - no afecta el login
app.set('trust proxy', 1);

// ✅ 1) Middlewares base SIEMPRE antes de auth
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token']
  })
);

// NEW: aumenta el limite JSON para soportar uploads base64 de imagen sin multipart.
// WHY: el modulo Inventario enviara imagenes como data URL / base64 por JSON.
// IMPACT: mantiene el parser global actual y habilita cuerpos de imagen dentro del limite definido.
app.use('/usuarios/v2/photo', express.json({ limit: USUARIOS_PHOTO_JSON_LIMIT }));
app.use(express.json({ limit: MAX_IMAGE_JSON_LIMIT }));
app.use(cookieParser());

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
    res.status(500).json({ error: err.message });
  }
});

// ✅ Login debe ser público
app.use(loginRoutes);

// ✅ 3) A partir de aquí: todo protegido
app.use(authRequired);               // 1) valida JWT
app.use(requireActiveSession);       // 2) valida sesión activa en BD
app.use(touchSessionMiddleware);     // 3) actualiza ultima_actividad
app.use(csrfProtect);                // 4) CSRF para no-GET
app.use(globalAuditMiddleware);      // 5) auditoria global (intencion real + diff puntual)
app.use(perfilRoutes);

// Admin: CRUD de recetas para panel administrativo (rutas relativas en router).
app.use('/api/admin/recetas', adminRecetasRouter);
// Admin: CRUD de combos para panel administrativo (rutas relativas en router).
app.use('/api/admin/combos', adminCombosRouter);

// ✅ 4) Rutas protegidas
app.use('/seguridad', seguridadSesionesRoutes);
app.use('/seguridad', seguridadConfigRoutes);
app.use('/seguridad', seguridadLoginsRoutes);
app.use('/seguridad', seguridadPermisosRoutes);
app.use('/seguridad', seguridadUsuariosRoutes);
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
app.use(proveedoresRoutes);
app.use(ordenComprasRoutes);
app.use(detalleOrdenComprasRoutes);
app.use(comprasRoutes);
app.use(detalleComprasRoutes);
// AM: flujo transaccional y seguro para solicitudes/ordenes/compras de abastecimiento.
app.use(ordenesCompraWorkflowRoutes);
app.use(tipoDepartamentoRoutes);
app.use(sucursalesRoutes);
app.use(ventasRoutes);
app.use(cocinaRoutes);

// MODULO PERSONAS
app.use(personasRoutes);
app.use(telefonosRoutes);
app.use(direccionesRoutes);
app.use(correosRoutes);
app.use(clientesRoutes);
app.use(empleadosRoutes);
app.use(planillasRoutes);
app.use(empresasRoutes);

app.use(menuPosRouter); // Monta las rutas del POS Menú
app.use(movimientosInventarioRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});

export default app;

