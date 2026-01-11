import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// ------------------------------------------------------------------------------------
// GET: Obtener usuarios
// ------------------------------------------------------------------------------------
// GET: Obtener usuarios
router.get('/usuarios', async (req, res) => {
    try {
        const tabla = 'usuarios';
        
        // CORRECCIÓN AQUÍ: Cambiamos 'cod_usuario' por 'id_usuario'
        // También aseguramos que 'clave' y 'estado' estén bien escritos.
        const columnas = 'id_usuario, nombre_usuario, clave, estado, id_empleado'; 

        // Llamamos a la función
        const query = 'SELECT function_select($1, $2) as resultado';
        const result = await pool.query(query, [tabla, columnas]);

        // Extraemos el resultado
        const datos = result.rows[0].resultado || [];
        res.status(200).json(datos);

    } catch (err) {
        console.error('Error al obtener usuarios:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});

// ------------------------------------------------------------------------------------
// POST: Crear nuevo usuario
// ------------------------------------------------------------------------------------
router.post('/usuarios', async (req, res) => {
    try {
        const tabla = 'usuarios';
        const datosUsuario = req.body; 
        
        /* IMPORTANTE: 
           Desde Postman debes enviar el JSON con las llaves correctas:
           {
             "nombre_usuario": "Juan",
             "clave": "12345",
             "estado": true,
             "id_empleado": 1
           }
        */

        const query = 'CALL pa_insert($1, $2)';
        await pool.query(query, [tabla, datosUsuario]);

        res.status(201).json({ message: 'Usuario creado exitosamente.' });

    } catch (err) {
        console.error('Error al crear usuario:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar usuario
// ------------------------------------------------------------------------------------
router.put('/usuarios', async (req, res) => {
    try {
        const { campo, valor, id_campo, id_valor } = req.body;

        if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
            return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
        }

        const tabla = 'usuarios';
        
        /* EN POSTMAN, para actualizar el nombre del usuario 1, enviarías:
           {
             "campo": "nombre_usuario",
             "valor": "NuevoNombre",
             "id_campo": "id_usuario",   <-- OJO AQUÍ: id_usuario
             "id_valor": 1
           }
        */

        const strNuevoDato = String(valor);
        const strValorCondicion = String(id_valor);

        const query = 'CALL pa_update($1, $2, $3, $4, $5)';
        await pool.query(query, [tabla, campo, strNuevoDato, id_campo, strValorCondicion]);

        res.status(200).json({ message: 'Usuario actualizado correctamente.' });

    } catch (err) {
        console.error('Error al actualizar:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});

// ------------------------------------------------------------------------------------
// DELETE: Eliminar usuario
// ------------------------------------------------------------------------------------
router.delete('/usuarios', async (req, res) => {
    try {
        const { columna_id, valor_id } = req.body;
        // En Postman enviarías: { "columna_id": "id_usuario", "valor_id": 1 }

        if (!columna_id || !valor_id) {
            return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
        }

        const tabla = 'usuarios';
        const strValorId = String(valor_id);

        const query = 'CALL pa_delete($1, $2, $3)';
        await pool.query(query, [tabla, columna_id, strValorId]);

        res.status(200).json({ message: 'Usuario eliminado.' });

    } catch (err) {
        console.error('Error al eliminar:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});
export default router;