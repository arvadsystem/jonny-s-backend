import express from 'express';
import { createPublicOrderController } from './publicMenuController.js';
import { validateCreateOrderBody } from './publicMenuValidators.js';

// Router de escritura del menu publico (acciones de pedido).
// Importante:
// - Esta superficie representa la frontera protegida de negocio.
// - En el siguiente hardening se debe aplicar auth de cliente aqui,
//   sin mezclar la sesion del dashboard/staff.
const publicMenuOrderRouter = express.Router();

// Crear pedido desde menu publico.
publicMenuOrderRouter.post('/pedidos', validateCreateOrderBody, createPublicOrderController);

export default publicMenuOrderRouter;
