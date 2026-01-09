import express from "express"
// Constante para el paquete de PostgreSQL (extraemos Pool directamente y utilizamos la variable pg)


// Constante para el paquete de Express
const app = express();

// Constante para el paquete de body-parser

 // poner a escuchar nuestra aplicación en el puerto 3001
    app.listen(3001, () => {
        console.log('Servidor escuchando en el puerto 3001')
    })