import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pool from './config/db-connection.js';

import loginRoutes from './routers/login.js';

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

import { authRequired, csrfProtect } from './middleware/auth.js';

const app = express();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

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

// Rutas públicas
app.get('/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', db_time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(loginRoutes);

// Rutas protegidas (JWT + CSRF)
app.use(authRequired);
app.use(csrfProtect);

// CRUD protegido
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});

export default app;
