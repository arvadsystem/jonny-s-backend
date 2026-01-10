import express from "express";
import bodyParser from "body-parser";

// IMPORTANTE: Aquí importamos tu archivo de conexión desde la carpeta config
import pool from "./config/db-connection.js"; 

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Ejemplo: Ruta de prueba para ver si la DB responde
app.get('/prueba-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()'); // Consulta simple de la hora
        res.json({ mensaje: 'Base de datos conectada', hora: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(3001, () => {
    console.log('Servidor escuchando en el puerto 3001');
});