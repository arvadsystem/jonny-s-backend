import express from 'express';
import publicMenuReadRouter from './publicMenuReadRouter.js';
import publicMenuOrderRouter from './publicMenuOrderRouter.js';

// Router raiz del modulo publico de menu.
// Se divide en dos superficies para definir frontera de seguridad:
// 1) Lectura publica: ver sucursales/menu/precios sin sesion.
// 2) Escritura de pedidos: frontera protegida para auth cliente.
const router = express.Router();

// Lectura publica del menu (anonimo permitido).
router.use(publicMenuReadRouter);

// Escritura de pedidos (a endurecer con auth de cliente en siguiente paso).
router.use(publicMenuOrderRouter);

export default router;
