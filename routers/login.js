import express from 'express';
import pool from '../config/db-connection.js';
import jwt from 'jsonwebtoken'; // <--- 1. Importamos la librería

const router = express.Router();

// Clave secreta para firmar los tokens (En producción esto va en variables de entorno)
const SECRET_KEY = 'jonnys_secreto_seguro_2026'; 

router.post('/login', async (req, res) => {
    const { nombre_usuario, clave } = req.body;

    try {
        const query = 'SELECT * FROM usuarios WHERE nombre_usuario = $1 AND clave = $2';
        const result = await pool.query(query, [nombre_usuario, clave]);

        if (result.rows.length === 0) {
            return res.status(401).json({ 
                error: true, 
                message: 'Usuario o contraseña incorrectos' 
            });
        }

        const usuarioEncontrado = result.rows[0];

        // 2. CREAMOS EL TOKEN
        // Guardamos dentro del token datos útiles (id, nombre, rol)
        // expira en 8 horas (8h)
        const token = jwt.sign(
            { 
                id: usuarioEncontrado.id_usuario, 
                username: usuarioEncontrado.nombre_usuario,
                rol: usuarioEncontrado.id_empleado 
            }, 
            SECRET_KEY, 
            { expiresIn: '8h' }
        );
        
        // 3. ENVIAMOS EL TOKEN AL FRONTEND
        res.status(200).json({
            message: 'Login exitoso',
            token: token, // <--- Aquí va el token
            usuario: {
                id: usuarioEncontrado.id_usuario,
                nombre_usuario: usuarioEncontrado.nombre_usuario,
                rol: usuarioEncontrado.id_empleado
            }
        });

    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
});

export default router;