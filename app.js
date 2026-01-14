import express from 'express';
import cors from 'cors'; // <--- 1. IMPORTAR CORS
import pool from './config/db-connection.js';

// Importamos las rutas
import usuarioRoutes from './routers/usuarios.js';
import loginRoutes from './routers/login.js'; // <--- 2. IMPORTAR RUTA LOGIN

//ANDRES RUTAS
import categoriasRoutes from './routers/categorias_productos.js';
import almacenesRoutes from './routers/almacenes.js';
import productosRoutes from './routers/productos.js';


const app = express();

// Middlewares
app.use(cors()); // <--- 3. ACTIVAR CORS (Permite que React se conecte)
app.use(express.json());


// Usamos las rutas
app.use(usuarioRoutes);
app.use(loginRoutes); // <--- 4. USAR RUTA LOGIN

//ANDRES APP.USE
app.use(categoriasRoutes);
app.use(almacenesRoutes);
app.use(productosRoutes);



// Ruta de prueba de conexión DB
app.get('/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ status: 'ok', db_time: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});

export default app;