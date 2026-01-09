import express from "express"
import pg from "pg"; // 1. Importamos el paquete pg
import bodyParser from "body-parser"; // 2. Importamos body-parser

// Constante para el paquete de Express
const app = express();
const { Pool } = pg;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Constante para el paquete de body-parser

 // poner a escuchar nuestra aplicación en el puerto 3001
    app.listen(3001, () => {
        console.log('Servidor escuchando en el puerto 3001')
    })