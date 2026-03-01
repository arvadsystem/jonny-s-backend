import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pool from './config/db-connection.js';

import loginRoutes from './routers/login.js';

// ... tus otros routes
import usuarioRoutes from './routers/usuarios.js';
import categoriasRoutes from './routers/categorias_productos.js';
import almacenesRoutes from './routers/almacenes.js';
import productosRoutes from './routers/productos.js';
import insumosRoutes from './routers/insumos.js';
import proveedoresRoutes from './routers/proveedores.js';
import ordenComprasRoutes from './routers/orden_compras.js';
import detalleOrdenComprasRoutes from './routers/detalle_orden_compras.js';
import comprasRoutes from './routers/compras.js';
import detalleComprasRoutes from './routers/detalle_compras.js';
import sucursalesRoutes from './routers/sucursales.js';
import ventasRoutes from './routers/ventas.js';
import menuPosRouter from './routers/menu_pos.js'; // // Router del POS Menú 

//MODULO PERSONAS
import personasRoutes from './routers/personas.js';
import telefonosRoutes from './routers/telefonos.js';
import direccionesRoutes from './routers/direcciones.js';
import correosRoutes from './routers/correos.js';
import empresasRoutes from './routers/empresas.js';

// ESTE ARCHIVO EXISTE COMO "tipos_departamentos.js"
import tipoDepartamentoRoutes from './routers/tipos_departamentos.js';
import movimientosInventarioRoutes from './routers/movimientos_inventario.js';
import perfilRoutes from './routers/perfil.js';


// Seguridad
import seguridadSesionesRoutes from './routers/seguridad/sesiones.js';
import seguridadConfigRoutes from './routers/seguridad/configuracion.js';
import seguridadLoginsRoutes from './routers/seguridad/logins.js';
import seguridadPermisosRoutes from "./routers/seguridad/permisos.js";
import comboPromoRoutes from './routers/combo_promo.js';

import { authRequired, csrfProtect } from './middleware/auth.js';
import { touchSessionMiddleware } from './middleware/touchSession.js';
import { requireActiveSession } from './middleware/requireActiveSession.js';

// Parametros
import catalogosRoutes from './routers/Parametros/catalogos.js';


const app = express();

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

app.use(express.json());
app.use(cookieParser());

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
app.use(perfilRoutes);


// ✅ 4) Rutas protegidas
app.use('/seguridad', seguridadSesionesRoutes);
app.use('/seguridad', seguridadConfigRoutes);
app.use('/seguridad', seguridadLoginsRoutes);
app.use("/seguridad", seguridadPermisosRoutes);

// Parametros
app.use('/parametros/catalogos', catalogosRoutes);

app.use(usuarioRoutes);
app.use(categoriasRoutes);
app.use(almacenesRoutes);
app.use(productosRoutes);
app.use(insumosRoutes);
app.use(proveedoresRoutes);
app.use(ordenComprasRoutes);
app.use(detalleOrdenComprasRoutes);
app.use(comprasRoutes);
app.use(detalleComprasRoutes);
app.use(tipoDepartamentoRoutes);
app.use(sucursalesRoutes);
app.use(ventasRoutes);

//MODULO PERSONAS 
app.use(personasRoutes);
app.use(telefonosRoutes);
app.use(direccionesRoutes);
app.use(correosRoutes);
app.use(empresasRoutes);
app.use(comboPromoRoutes);
app.use(menuPosRouter); // // Monta las rutas del POS Menú

app.use(movimientosInventarioRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});

export default app;
