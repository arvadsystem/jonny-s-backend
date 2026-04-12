import express from 'express';
import { createPublicOrderController } from './publicMenuController.js';
import { requireAuthenticatedPublicCustomer } from './publicMenuAuthMiddleware.js';
import { validateCreateOrderBody } from './publicMenuValidators.js';

// Router de escritura del menu publico (acciones de pedido).
// Importante:
// - Esta superficie representa la frontera protegida de negocio.
// - Aqui SI exigimos sesion de cliente autenticado + CSRF.
const publicMenuOrderRouter = express.Router();

// Crear pedido desde menu publico.
publicMenuOrderRouter.post(
  '/pedidos',
  requireAuthenticatedPublicCustomer,
  validateCreateOrderBody,
  createPublicOrderController
);

export default publicMenuOrderRouter;
